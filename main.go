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
		log.Fatalf("RCON Verbindung fehlgeschlagen für %s:%d: %v", srv.Host, srv.Port, err)
	}
	defer rcn.Close()

	outside := map[string]OutsidePlayer{}

	log.Printf("Geofence Worker gestartet für %s:%d | punish_after=%ds", srv.Host, srv.Port, punishAfter)

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

		for _, p := range players {
			if !p.IsSpawned() {
				delete(outside, p.ID)
				continue
			}

			var fences []Fence
			team := strings.ToLower(fmt.Sprint(p.Team))

			if team == "allies" {
				fences = alliesFences
			} else if team == "axis" {
				fences = axisFences
			} else {
				continue
			}

			if len(fences) == 0 {
				continue
			}

			grid := positionToGrid(p.Position)

			if isInsideAnyFence(grid, fences) {
				if _, ok := outside[p.ID]; ok {
					log.Printf("player-back-inside player=%q grid=%s", p.Name, grid.String())
				}
				delete(outside, p.ID)
				continue
			}

			o, alreadyOutside := outside[p.ID]
			if !alreadyOutside {
				outside[p.ID] = OutsidePlayer{
					Name:         p.Name,
					FirstOutside: time.Now(),
					LastGrid:     grid,
				}

				msg := formatMessage(srv.WarningMessage(), fmt.Sprintf("%ds", punishAfter))
				log.Printf("player-outside-fence player=%q id=%s team=%s grid=%s pos=(%.1f, %.1f, %.1f)", p.Name, p.ID, p.Team, grid.String(), p.Position.X, p.Position.Y, p.Position.Z)

				if err := rcn.MessagePlayer(p.ID, msg); err != nil {
					log.Printf("message-player-outside-fence player=%q id=%s error=%v", p.Name, p.ID, err)
				}
				continue
			}

			o.LastGrid = grid
			outside[p.ID] = o

			if time.Since(o.FirstOutside) >= time.Duration(punishAfter)*time.Second {
				reason := formatMessage(srv.PunishMessage(), fmt.Sprintf("%ds", punishAfter))
				log.Printf("punish-player player=%q id=%s grid=%s", p.Name, p.ID, grid.String())

				if err := rcn.PunishPlayer(p.ID, reason); err != nil {
					log.Printf("punish-player-error player=%q id=%s error=%v", p.Name, p.ID, err)
				}

				delete(outside, p.ID)
			}
		}

		time.Sleep(1 * time.Second)
	}
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
	for _, f := range fences {
		if f.Matches(session) {
			out = append(out, f)
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

	// Manual button control: player_count conditions are intentionally ignored.
	// This keeps old configs compatible while preventing the worker from
	// automatically disabling all fences once the server reaches a player limit.
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
	for _, v := range values {
		if strings.EqualFold(strings.TrimSpace(v), strings.TrimSpace(needle)) {
			return true
		}
	}
	return false
}

func isInsideAnyFence(g Grid, fences []Fence) bool {
	for _, f := range fences {
		if f.Includes(g) {
			return true
		}
	}
	return false
}

func (f Fence) Includes(g Grid) bool {
	if f.X != nil && !strings.EqualFold(*f.X, g.X) {
		return false
	}
	if f.Y != nil && *f.Y != g.Y {
		return false
	}
	if len(f.Numpads) == 0 {
		return true
	}
	for _, n := range f.Numpads {
		if n == g.Numpad {
			return true
		}
	}
	return false
}

func positionToGrid(p hll.Position) Grid {
	gx := clampInt(int(math.Floor((p.X-mapMin)/cell)), 0, 9)
	gy := clampInt(int(math.Floor((p.Y-mapMin)/cell)), 0, 9)

	localX := (p.X - (mapMin + float64(gx)*cell)) / cell
	localY := (p.Y - (mapMin + float64(gy)*cell)) / cell

	col := clampInt(int(math.Floor(localX*3)), 0, 2)
	row := clampInt(int(math.Floor(localY*3)), 0, 2)

	return Grid{
		X:      string(rune('A' + gx)),
		Y:      gy + 1,
		Numpad: row*3 + col + 1,
	}
}

func clampInt(v, min, max int) int {
	if v < min {
		return min
	}
	if v > max {
		return max
	}
	return v
}

func (g Grid) String() string {
	return fmt.Sprintf("%s%d.%d", g.X, g.Y, g.Numpad)
}
