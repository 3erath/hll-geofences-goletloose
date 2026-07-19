import { execFile } from 'child_process';
import dotenv from 'dotenv';
import { mkdir, readFile, rename, writeFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const dir = path.dirname(fileURLToPath(import.meta.url));

dotenv.config({ path: path.join(dir, '.env') });
dotenv.config({ path: '/opt/oktogon-seeding-bot/.env', override: false });

const num = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
};

const cfg = {
  project: process.env.GEOFENCE_PROJECT_NAME || 'hll-geofences',
  flag: process.env.BOT_FLAG || '🌱',
  armAt: num('BOT_COUNT_ARM_AT', 36),
  midAt: num('MIDCAP_BOT_THRESHOLD', 35),
  lastAt: num('LASTCAP_BOT_THRESHOLD', 5),
  confirmations: Math.max(1, num('BOT_COUNT_CONFIRMATIONS', 3)),
  intervalMs: Math.max(5, num('BOT_COUNT_INTERVAL_SECONDS', 5)) * 1000,
  timeoutMs: Math.max(2, num('CRCON_TIMEOUT_SECONDS', 10)) * 1000,
};

const servers = [
  {
    key: 'okt1', name: 'OKT1',
    baseUrl: process.env.SERVER_1_CRCON_BASE_URL,
    token: process.env.SERVER_1_CRCON_API_TOKEN,
    midcap: 'hll-geofences-okt1-midcap',
    lastcap: 'hll-geofences-okt1-lastcap',
  },
  {
    key: 'okt2', name: 'OKT2',
    baseUrl: process.env.SERVER_2_CRCON_BASE_URL,
    token: process.env.SERVER_2_CRCON_API_TOKEN,
    midcap: 'hll-geofences-okt2-midcap',
    lastcap: 'hll-geofences-okt2-lastcap',
  },
];

const runtimeDir = path.join(dir, 'runtime');
const stateFile = path.join(runtimeDir, 'geofence-auto-state.json');
const fresh = () => ({
  phase: 'IDLE', armed: false, maxBots: 0,
  midHits: 0, lastHits: 0, updatedAt: new Date().toISOString(),
});
const log = (server, text) => console.log(
  `${new Date().toISOString()} [${server?.name || 'AUTO'}] ${text}`,
);
const touch = (state) => { state.updatedAt = new Date().toISOString(); };

async function loadState() {
  try {
    const saved = JSON.parse(await readFile(stateFile, 'utf8'));
    return Object.fromEntries(servers.map((s) => [s.key, { ...fresh(), ...(saved[s.key] || {}) }]));
  } catch (error) {
    if (error.code !== 'ENOENT') log(null, `State-Lesefehler: ${error.message}`);
    return Object.fromEntries(servers.map((s) => [s.key, fresh()]));
  }
}

async function saveState(state) {
  await mkdir(runtimeDir, { recursive: true });
  const tmp = `${stateFile}.tmp`;
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`);
  await rename(tmp, stateFile);
}

async function compose(...args) {
  return execFileAsync('docker', ['compose', '-p', cfg.project, ...args], {
    cwd: dir, maxBuffer: 2 * 1024 * 1024,
  });
}

async function running(service) {
  const { stdout } = await compose('ps', '-q', service);
  const id = stdout.trim();
  if (!id) return false;
  const result = await execFileAsync('docker', ['inspect', '-f', '{{.State.Running}}', id]);
  return result.stdout.trim() === 'true';
}

async function status(server) {
  const [midcap, lastcap] = await Promise.all([
    running(server.midcap), running(server.lastcap),
  ]);
  return { midcap, lastcap };
}

const start = (service) => compose('up', '-d', '--force-recreate', service);
const stop = (service) => compose('stop', service);

function playersFrom(game) {
  const result = [];
  for (const key of ['axis', 'allies', 'unassigned']) {
    const team = game?.[key];
    if (!team) continue;
    if (team.commander) result.push(team.commander);
    for (const squad of Object.values(team.squads ?? {})) {
      result.push(...(squad?.players ?? []));
    }
  }
  const unique = new Map();
  for (const player of result) {
    const key = player?.player_id || player?.name;
    if (key) unique.set(key, player);
  }
  return [...unique.values()];
}

function isBot(player) {
  return (player?.profile?.flags ?? []).some((item) => {
    const value = typeof item === 'string' ? item : item?.flag;
    return typeof value === 'string' && value.trim() === cfg.flag;
  });
}

async function counts(server) {
  if (!server.baseUrl || !server.token) throw new Error('CRCON URL/Token fehlt');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  try {
    const url = `${server.baseUrl.replace(/\/$/, '')}/api/get_team_view`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${server.token}`, Accept: 'application/json' },
      signal: controller.signal,
    });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { throw new Error(`Kein JSON, HTTP ${response.status}`); }
    if (!response.ok || data?.failed === true || data?.error) {
      throw new Error(`HTTP ${response.status}: ${data?.error || 'Abfrage fehlgeschlagen'}`);
    }
    const players = playersFrom(data?.result ?? data);
    const bots = players.filter(isBot);
    return { players: players.length, bots: bots.length, names: bots.map((p) => p.name || p.player_id) };
  } finally {
    clearTimeout(timer);
  }
}

async function tick(server, state) {
  const live = await status(server);
  if (live.midcap && live.lastcap) {
    log(server, 'WARNUNG: Midcap und Lastcap laufen gleichzeitig; keine Aktion.');
    return false;
  }

  if (state.phase === 'IDLE') {
    if (!live.midcap) return false;
    Object.assign(state, fresh(), { phase: 'MIDCAP' });
    log(server, `Seeding-Start erkannt; warte auf mindestens ${cfg.armAt} ${cfg.flag}-Bots.`);
  }

  if (state.phase === 'DONE') {
    if (!live.midcap && !live.lastcap) {
      Object.assign(state, fresh());
      log(server, 'Bereit für die nächste Seeding-Runde.');
      return true;
    }
    return false;
  }

  if (state.phase === 'MIDCAP') {
    if (!live.midcap && !live.lastcap) {
      Object.assign(state, fresh());
      log(server, 'Midcap manuell gestoppt; Automatik zurückgesetzt.');
      return true;
    }
    if (!live.midcap && live.lastcap) {
      Object.assign(state, { phase: 'LASTCAP', armed: true, midHits: 0, lastHits: 0 });
      log(server, 'Manuellen Wechsel auf Lastcap erkannt.');
    }
  } else if (state.phase === 'LASTCAP') {
    if (!live.midcap && !live.lastcap) {
      state.phase = 'DONE'; touch(state);
      log(server, 'Lastcap manuell gestoppt; Runde beendet.');
      return true;
    }
    if (live.midcap && !live.lastcap) {
      state.phase = 'DONE'; touch(state);
      log(server, 'Manueller Rückwechsel auf Midcap; Automatik für diese Runde deaktiviert.');
      return true;
    }
  }

  let current;
  try { current = await counts(server); }
  catch (error) {
    log(server, `CRCON-Fehler: ${error.message}; Zustand bleibt unverändert.`);
    return false;
  }

  log(server, `Phase=${state.phase} | Spieler=${current.players} | ${cfg.flag}-Bots=${current.bots}`);
  state.maxBots = Math.max(state.maxBots, current.bots);

  if (state.phase === 'MIDCAP') {
    if (!state.armed) {
      if (current.bots >= cfg.armAt) {
        state.armed = true;
        log(server, `Automatik scharf bei ${current.bots} ${cfg.flag}-Bots.`);
      }
      touch(state);
      return true;
    }

    state.midHits = current.bots <= cfg.midAt ? state.midHits + 1 : 0;
    if (state.midHits) log(server, `Midcap ${current.bots} <= ${cfg.midAt}: ${state.midHits}/${cfg.confirmations}.`);
    touch(state);

    if (state.midHits >= cfg.confirmations) {
      try {
        await stop(server.midcap);
        await start(server.lastcap);
      } catch (error) {
        state.midHits = 0; touch(state);
        log(server, `Docker-Wechsel fehlgeschlagen: ${error.message}`);
        return true;
      }
      Object.assign(state, { phase: 'LASTCAP', midHits: 0, lastHits: 0 });
      touch(state);
      log(server, 'Midcap gestoppt und Lastcap gestartet.');
    }
    return true;
  }

  if (state.phase === 'LASTCAP') {
    state.lastHits = current.bots <= cfg.lastAt ? state.lastHits + 1 : 0;
    if (state.lastHits) log(server, `Lastcap ${current.bots} <= ${cfg.lastAt}: ${state.lastHits}/${cfg.confirmations}.`);
    touch(state);

    if (state.lastHits >= cfg.confirmations) {
      try { await stop(server.lastcap); }
      catch (error) {
        state.lastHits = 0; touch(state);
        log(server, `Lastcap-Stop fehlgeschlagen: ${error.message}`);
        return true;
      }
      Object.assign(state, { phase: 'DONE', lastHits: 0 });
      touch(state);
      log(server, 'Lastcap gestoppt; Automatik abgeschlossen.');
    }
    return true;
  }

  return false;
}

async function probe() {
  console.log(`Flag=${cfg.flag} | ArmAt=${cfg.armAt} | Midcap<=${cfg.midAt} | Lastcap<=${cfg.lastAt}`);
  for (const server of servers) {
    try {
      const [live, current] = await Promise.all([status(server), counts(server)]);
      console.log(`\n=== ${server.name} ===`);
      console.log(`Midcap: ${live.midcap ? 'AKTIV' : 'AUS'} | Lastcap: ${live.lastcap ? 'AKTIV' : 'AUS'}`);
      console.log(`Spieler: ${current.players} | ${cfg.flag}-Bots: ${current.bots}`);
      if (current.names.length) console.log(`Namen: ${current.names.join(', ')}`);
    } catch (error) { console.error(`❌ ${server.name}: ${error.message}`); }
  }
}

async function main() {
  if (process.argv.includes('--probe')) return probe();
  const state = await loadState();
  log(null, `Start: ArmAt=${cfg.armAt}, Midcap<=${cfg.midAt}, Lastcap<=${cfg.lastAt}, ${cfg.confirmations}x/${cfg.intervalMs / 1000}s.`);
  while (true) {
    let changed = false;
    for (const server of servers) {
      try { changed = (await tick(server, state[server.key])) || changed; }
      catch (error) { log(server, `Unerwarteter Fehler: ${error.stack || error.message}`); }
    }
    if (changed) {
      try { await saveState(state); }
      catch (error) { log(null, `State-Speicherfehler: ${error.message}`); }
    }
    await new Promise((resolve) => setTimeout(resolve, cfg.intervalMs));
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
