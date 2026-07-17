package main

import (
	"fmt"
	"log"
	"math"
	"os"
	"strings"
	"time"

	"github.com/zMoooooritz/go-let-loose/pkg/hll"
	"github.com/zMoooooritz/go-let-loose/pkg/rcon"
	"gopkg.in/yaml.v3"
)

const (
	mapMin = -100000.0
	cell   = 20000.0

	spawnGraceDuration   = 30 * time.Second
	movementThresholdCm = 200.0
)

type Config struct {
	Servers []Server `yaml:"Servers"`
}

type Server struct {
	Host               string    `yaml:"Host"`
	Port               int       `yaml:"Port"`
	Password           string    `yaml:"Password"`
	PunishAfterSeconds *int      `yaml:"PunishAfterSeconds,omitempty"`
	AxisFence          []Fence   `yaml:"AxisFence"`
	AlliesFence        []Fence   `yaml:"AlliesFence"`
	Messages           *Messages `yaml:"Messages,omitempty"`
}

type Messages struct {
	Warning *string `yaml:"Warning,omitempty"`
	Punish  *string `yaml:"Punish,omitempty"`
}

type Fence struct {
	X         *string    `yaml:"X,omitempty"`
	Y         *int       `yaml:"Y,omitempty"`
	Numpads   []int      `yaml:"Numpad,omitempty"`
	Condition *Condition `yaml:"Condition,omitempty"`
}

type Condition struct {
	Equals      map[string][]string `yaml:"Equals,omitempty"`
	LessThan    map[string]int      `yaml:"LessThan,omitempty"`
	GreaterThan map[string]int      `yaml:"GreaterThan,omitempty"`
}

type Grid struct {
	X      string
	Y      int
	Numpad int
}

type OutsidePlayer struct {
	Name         string
	FirstOutside time.Time
	LastGrid     Grid
}

type PlayerState struct {
	Name             string
	Team             string
	AnchorPosition   hll.Position
	AwaitingMovement bool
	GraceUntil       time.Time
}

func main() {
	cfgBytes, err := os.ReadFile("./config.yml")
	if err != nil {
		log.Fatalf("config lesen fehlgeschlagen: %v", err)
	}

	var cfg Config
	if err := yaml.Unmarshal(cfgBytes, &cfg); err != nil {
		log.Fatalf("config yaml ungültig: %v", err)
	}

	if len(cfg.Servers) == 0 {
		log.Fatal("keine Server in config.yml gefunden")
	}

	for _, srv := range cfg.Servers {
		go runServer(srv)
	}

	select {}
}

func runServer(srv Server) {
	punishAfter := 10
	if srv.PunishAfterSeconds != nil {
		punishAfter = *srv.PunishAfterSeconds
	}

	rcn, err := rcon.NewRcon(rcon.ServerConfig{
		Host:     srv.Host,
		Port:     fmt.Sprint(srv.Port),
		Password: srv.Password,
	}, 2)
	if err != nil {
		log.Fatalf(
			"RCON Verbindung fehlgeschlagen für %s:%d: %v",
			srv.Host,
			srv.Port,
			err,
		)
	}
	defer rcn.Close()

	outside := map[string]OutsidePlayer{}
	playerStates := map[string]PlayerState{}

	log.Printf(
		"Geofence Worker gestartet für %s:%d | punish_after=%ds | spawn_grace=%s | movement_threshold=%.0fcm",
		srv.Host,
		srv.Port,
		punishAfter,
		spawnGraceDuration,
		movementThresholdCm,
	)

	for {
		session, err := rcn.GetSessionInfo()
		if err != nil {
			log.Printf("session error: %v", err)
			time.Sleep(2 * time.Second)
			continue
		}

		axisFences := applicableFences(srv.AxisFence, session)
		alliesFences := applicableFences(srv.AlliesFence, session)

		players, err := rcn.GetPlayersInfo()
		if err != nil {
			log.Printf("players error: %v", err)
			time.Sleep(2 * time.Second)
			continue
		}

		now := time.Now()
		seenPlayers := make(map[string]bool, len(players))

		for _, p := range players {
			seenPlayers[p.ID] = true
			team := normalizeTeam(p.Team)

			if !p.IsSpawned() {
				if _, exists := outside[p.ID]; exists {
					log.Printf("player-not-spawned-reset player=%q id=%s", p.Name, p.ID)
				}

				delete(outside, p.ID)
				delete(playerStates, p.ID)
				continue
			}

			if team == "" {
				delete(outside, p.ID)
				delete(playerStates, p.ID)
				continue
			}

			state, stateExists := playerStates[p.ID]
			if !stateExists {
				playerStates[p.ID] = PlayerState{
					Name:             p.Name,
					Team:             team,
					AnchorPosition:   p.Position,
					AwaitingMovement: true,
				}

				delete(outside, p.ID)
				log.Printf(
					"player-awaiting-first-movement player=%q id=%s team=%s pos=(%.1f, %.1f, %.1f)",
					p.Name,
					p.ID,
					team,
					p.Position.X,
					p.Position.Y,
					p.Position.Z,
				)
				continue
			}

			if state.Team != team {
				log.Printf(
					"player-team-change-reset player=%q id=%s old_team=%s new_team=%s",
					p.Name,
					p.ID,
					state.Team,
					team,
				)

				playerStates[p.ID] = PlayerState{
					Name:             p.Name,
					Team:             team,
					AnchorPosition:   p.Position,
					AwaitingMovement: true,
				}

				delete(outside, p.ID)
				continue
			}

			if state.AwaitingMovement {
				distance := positionDistance2D(state.AnchorPosition, p.Position)
				if distance < movementThresholdCm {
					delete(outside, p.ID)
					continue
				}

				state.Name = p.Name
				state.AnchorPosition = p.Position
				state.AwaitingMovement = false
				state.GraceUntil = now.Add(spawnGraceDuration)
				playerStates[p.ID] = state

				delete(outside, p.ID)
				log.Printf(
					"player-spawn-confirmed player=%q id=%s team=%s movement=%.1fcm grace_until=%s",
					p.Name,
					p.ID,
					team,
					distance,
					state.GraceUntil.Format(time.RFC3339),
				)
				continue
			}

			if now.Before(state.GraceUntil) {
				delete(outside, p.ID)
				continue
			}

			var fences []Fence
			if team == "allies" {
				fences = alliesFences
			} else if team == "axis" {
				fences = axisFences
			}

			if len(fences) == 0 {
				delete(outside, p.ID)
				continue
			}

			grid := positionToGrid(p.Position)
			if isInsideAnyFence(grid, fences) {
				if _, exists := outside[p.ID]; exists {
					log.Printf(
						"player-back-inside player=%q id=%s team=%s grid=%s",
						p.Name,
						p.ID,
						team,
						grid.String(),
					)
				}

				delete(outside, p.ID)
				continue
			}

			outsideState, alreadyOutside := outside[p.ID]
			if !alreadyOutside {
				outside[p.ID] = OutsidePlayer{
					Name:         p.Name,
					FirstOutside: now,
					LastGrid:     grid,
				}

				message := formatMessage(srv.WarningMessage(), fmt.Sprintf("%ds", punishAfter))
				log.Printf(
					"player-outside-fence player=%q id=%s team=%s grid=%s pos=(%.1f, %.1f, %.1f)",
					p.Name,
					p.ID,
					team,
					grid.String(),
					p.Position.X,
					p.Position.Y,
					p.Position.Z,
				)

				if err := rcn.MessagePlayer(p.ID, message); err != nil {
					log.Printf(
						"message-player-outside-fence player=%q id=%s error=%v",
						p.Name,
						p.ID,
						err,
					)
				}
				continue
			}

			outsideState.Name = p.Name
			outsideState.LastGrid = grid
			outside[p.ID] = outsideState

			if now.Sub(outsideState.FirstOutside) < time.Duration(punishAfter)*time.Second {
				continue
			}

			reason := formatMessage(srv.PunishMessage(), fmt.Sprintf("%ds", punishAfter))
			log.Printf(
				"punish-player player=%q id=%s team=%s grid=%s",
				p.Name,
				p.ID,
				team,
				grid.String(),
			)

			if err := rcn.PunishPlayer(p.ID, reason); err != nil {
				log.Printf(
					"punish-player-error player=%q id=%s error=%v",
					p.Name,
					p.ID,
					err,
				)
			}

			outsideState.FirstOutside = now
			outsideState.LastGrid = grid
			outside[p.ID] = outsideState
		}

		for playerID := range playerStates {
			if !seenPlayers[playerID] {
				delete(playerStates, playerID)
				delete(outside, playerID)
			}
		}

		time.Sleep(1 * time.Second)
	}
}

func normalizeTeam(team any) string {
	value := strings.ToLower(strings.TrimSpace(fmt.Sprint(team)))

	switch value {
	case "allies":
		return "allies"
	case "axis":
		return "axis"
	default:
		return ""
	}
}

func positionDistance2D(a hll.Position, b hll.Position) float64 {
	dx := b.X - a.X
	dy := b.Y - a.Y
	return math.Sqrt(dx*dx + dy*dy)
}

func (s Server) WarningMessage() string {
	if s.Messages != nil && s.Messages.Warning != nil {
		return *s.Messages.Warning
	}

	return "You are outside of the designated play area! Please go back to the battlefield immediately.\n\nYou will be punished in %s"
}

func (s Server) PunishMessage() string {
	if s.Messages != nil && s.Messages.Punish != nil {
		return *s.Messages.Punish
	}

	return "%s outside the play area"
}

func formatMessage(template string, value string) string {
	if strings.Contains(template, "%s") {
		return fmt.Sprintf(template, value)
	}
	return template
}

func applicableFences(fences []Fence, session hll.SessionInfo) []Fence {
	out := []Fence{}
	for _, fence := range fences {
		if fence.Matches(session) {
			out = append(out, fence)
		}
	}
	return out
}

func (c Condition) Matches(session hll.SessionInfo) bool {
	for key, values := range c.Equals {
		switch key {
		case "map_name":
			if !containsStringLoose(values, session.MapName) {
				return false
			}
		case "game_mode":
			if !containsStringLoose(values, fmt.Sprint(session.GameMode)) {
				return false
			}
		default:
			return false
		}
	}

	for key := range c.LessThan {
		if key != "player_count" {
			return false
		}
	}

	for key := range c.GreaterThan {
		if key != "player_count" {
			return false
		}
	}

	return true
}

func (f Fence) Matches(session hll.SessionInfo) bool {
	if f.Condition == nil {
		return true
	}
	return f.Condition.Matches(session)
}

func containsStringLoose(values []string, needle string) bool {
	for _, value := range values {
		if strings.EqualFold(strings.TrimSpace(value), strings.TrimSpace(needle)) {
			return true
		}
	}
	return false
}

func isInsideAnyFence(grid Grid, fences []Fence) bool {
	for _, fence := range fences {
		if fence.Includes(grid) {
			return true
		}
	}
	return false
}

func (f Fence) Includes(grid Grid) bool {
	if f.X != nil && !strings.EqualFold(*f.X, grid.X) {
		return false
	}
	if f.Y != nil && *f.Y != grid.Y {
		return false
	}
	if len(f.Numpads) == 0 {
		return true
	}
	for _, numpad := range f.Numpads {
		if numpad == grid.Numpad {
			return true
		}
	}
	return false
}

func positionToGrid(position hll.Position) Grid {
	gridX := clampInt(int(math.Floor((position.X-mapMin)/cell)), 0, 9)
	gridY := clampInt(int(math.Floor((position.Y-mapMin)/cell)), 0, 9)

	localX := (position.X - (mapMin + float64(gridX)*cell)) / cell
	localY := (position.Y - (mapMin + float64(gridY)*cell)) / cell

	column := clampInt(int(math.Floor(localX*3)), 0, 2)
	row := clampInt(int(math.Floor(localY*3)), 0, 2)

	return Grid{
		X:      string(rune('A' + gridX)),
		Y:      gridY + 1,
		Numpad: row*3 + column + 1,
	}
}

func clampInt(value, minimum, maximum int) int {
	if value < minimum {
		return minimum
	}
	if value > maximum {
		return maximum
	}
	return value
}

func (g Grid) String() string {
	return fmt.Sprintf("%s%d.%d", g.X, g.Y, g.Numpad)
}
