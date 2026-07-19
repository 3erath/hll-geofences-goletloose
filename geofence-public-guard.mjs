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

const numberFromEnv = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
};

const cfg = {
  project: process.env.GEOFENCE_PROJECT_NAME || 'hll-geofences',
  flag: process.env.BOT_FLAG || '🌱',
  triggerBelow: numberFromEnv('PUBLIC_LASTCAP_PLAYER_THRESHOLD', 60),
  recoverAbove: numberFromEnv('PUBLIC_LASTCAP_RECOVER_ABOVE', 85),
  confirmations: Math.max(1, numberFromEnv('PUBLIC_LASTCAP_CONFIRMATIONS', 3)),
  intervalMs: Math.max(5, numberFromEnv('BOT_COUNT_INTERVAL_SECONDS', 5)) * 1000,
  timeoutMs: Math.max(2, numberFromEnv('CRCON_TIMEOUT_SECONDS', 10)) * 1000,
};

const servers = [
  {
    key: 'okt1',
    name: 'OKT1',
    baseUrl: process.env.SERVER_1_CRCON_BASE_URL,
    token: process.env.SERVER_1_CRCON_API_TOKEN,
    midcap: 'hll-geofences-okt1-midcap',
    lastcap: 'hll-geofences-okt1-lastcap',
  },
  {
    key: 'okt2',
    name: 'OKT2',
    baseUrl: process.env.SERVER_2_CRCON_BASE_URL,
    token: process.env.SERVER_2_CRCON_API_TOKEN,
    midcap: 'hll-geofences-okt2-midcap',
    lastcap: 'hll-geofences-okt2-lastcap',
  },
];

const runtimeDir = path.join(dir, 'runtime');
const stateFile = path.join(runtimeDir, 'geofence-public-guard-state.json');
const freshState = () => ({ armed: false, active: false, lowHits: 0, highHits: 0 });
const log = (server, text) => console.log(
  `${new Date().toISOString()} [${server?.name || 'PUBLIC-GUARD'}] ${text}`,
);

async function loadState() {
  try {
    const saved = JSON.parse(await readFile(stateFile, 'utf8'));
    return Object.fromEntries(
      servers.map((server) => [server.key, { ...freshState(), ...(saved[server.key] || {}) }]),
    );
  } catch (error) {
    if (error.code !== 'ENOENT') log(null, `State-Lesefehler: ${error.message}`);
    return Object.fromEntries(servers.map((server) => [server.key, freshState()]));
  }
}

async function saveState(state) {
  await mkdir(runtimeDir, { recursive: true });
  const temporary = `${stateFile}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`);
  await rename(temporary, stateFile);
}

async function compose(...args) {
  return execFileAsync('docker', ['compose', '-p', cfg.project, ...args], {
    cwd: dir,
    maxBuffer: 2 * 1024 * 1024,
  });
}

async function isRunning(service) {
  const { stdout } = await compose('ps', '-q', service);
  const id = stdout.trim();
  if (!id) return false;

  const result = await execFileAsync(
    'docker',
    ['inspect', '-f', '{{.State.Running}}', id],
  );

  return result.stdout.trim() === 'true';
}

async function containerStatus(server) {
  const [midcap, lastcap] = await Promise.all([
    isRunning(server.midcap),
    isRunning(server.lastcap),
  ]);

  return { midcap, lastcap };
}

function extractPlayers(game) {
  const found = [];

  for (const teamKey of ['axis', 'allies', 'unassigned']) {
    const team = game?.[teamKey];
    if (!team) continue;
    if (team.commander) found.push(team.commander);

    for (const squad of Object.values(team.squads ?? {})) {
      found.push(...(squad?.players ?? []));
    }
  }

  const unique = new Map();
  for (const player of found) {
    const key = player?.player_id || player?.name;
    if (key) unique.set(key, player);
  }

  return [...unique.values()];
}

function hasBotFlag(player) {
  return (player?.profile?.flags ?? []).some((entry) => {
    const value = typeof entry === 'string' ? entry : entry?.flag;
    return typeof value === 'string' && value.trim() === cfg.flag;
  });
}

async function getCounts(server) {
  if (!server.baseUrl || !server.token) {
    throw new Error('CRCON URL oder Token fehlt');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), cfg.timeoutMs);

  try {
    const url = `${server.baseUrl.replace(/\/$/, '')}/api/get_team_view`;
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${server.token}`,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });

    const data = await response.json();
    if (!response.ok || data?.failed === true || data?.error) {
      throw new Error(`HTTP ${response.status}: ${data?.error || 'Abfrage fehlgeschlagen'}`);
    }

    const players = extractPlayers(data?.result ?? data);
    return {
      players: players.length,
      bots: players.filter(hasBotFlag).length,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function tick(server, state) {
  const live = await containerStatus(server);

  if (live.midcap && live.lastcap) {
    log(server, 'WARNUNG: Midcap und Lastcap laufen gleichzeitig; keine Aktion.');
    return false;
  }

  let current;
  try {
    current = await getCounts(server);
  } catch (error) {
    log(server, `CRCON-Fehler: ${error.message}; keine Umschaltung.`);
    return false;
  }

  if (state.active) {
    if (!live.lastcap) {
      Object.assign(state, freshState());
      log(server, 'Notfall-Lastcap wurde manuell gestoppt; Schutz muss erneut bei >85 Spielern scharf werden.');
      return true;
    }

    state.highHits = current.players > cfg.recoverAbove ? state.highHits + 1 : 0;

    if (state.highHits > 0) {
      log(server, `Erholung ${current.players} > ${cfg.recoverAbove}: ${state.highHits}/${cfg.confirmations}.`);
    }

    if (state.highHits >= cfg.confirmations) {
      await compose('stop', server.lastcap);
      Object.assign(state, { ...freshState(), armed: true });
      log(server, `Mehr als ${cfg.recoverAbove} Spieler erreicht; Notfall-Lastcap gestoppt.`);
    }

    return true;
  }

  if (live.midcap || live.lastcap) {
    return false;
  }

  if (current.bots > 0) {
    const changed = state.armed || state.lowHits || state.highHits;
    Object.assign(state, freshState());
    if (changed) log(server, `${cfg.flag}-Bots erkannt; öffentlicher Notfallschutz zurückgesetzt.`);
    return changed;
  }

  if (current.players > cfg.recoverAbove) {
    if (!state.armed) {
      Object.assign(state, { ...freshState(), armed: true });
      log(server, `Notfallschutz scharf: 0 ${cfg.flag}-Bots und ${current.players} Spieler.`);
      return true;
    }

    state.lowHits = 0;
    return false;
  }

  if (!state.armed) {
    return false;
  }

  state.lowHits = current.players < cfg.triggerBelow ? state.lowHits + 1 : 0;

  if (state.lowHits > 0) {
    log(server, `Spielereinbruch ${current.players} < ${cfg.triggerBelow}: ${state.lowHits}/${cfg.confirmations}.`);
  }

  if (state.lowHits >= cfg.confirmations) {
    await compose('up', '-d', '--force-recreate', server.lastcap);
    Object.assign(state, { armed: true, active: true, lowHits: 0, highHits: 0 });
    log(server, `Unter ${cfg.triggerBelow} Spieler bei 0 ${cfg.flag}-Bots; Lastcap aktiv bis >${cfg.recoverAbove} Spieler.`);
  }

  return true;
}

async function probe() {
  console.log(
    `Notfallmodus: 0 ${cfg.flag}-Bots | Start <${cfg.triggerBelow} | Ende >${cfg.recoverAbove} | ${cfg.confirmations} Bestätigungen`,
  );

  for (const server of servers) {
    try {
      const [live, current] = await Promise.all([
        containerStatus(server),
        getCounts(server),
      ]);

      console.log(`\n=== ${server.name} ===`);
      console.log(`Midcap: ${live.midcap ? 'AKTIV' : 'AUS'} | Lastcap: ${live.lastcap ? 'AKTIV' : 'AUS'}`);
      console.log(`Spieler: ${current.players} | ${cfg.flag}-Bots: ${current.bots}`);
    } catch (error) {
      console.error(`❌ ${server.name}: ${error.message}`);
    }
  }
}

async function main() {
  if (process.argv.includes('--probe')) return probe();

  const state = await loadState();
  log(
    null,
    `Start: Erst nach >${cfg.recoverAbove} Spielern scharf; ` +
      `bei 0 Bots und <${cfg.triggerBelow} Lastcap an; ` +
      `bei >${cfg.recoverAbove} wieder aus; ${cfg.confirmations}x/${cfg.intervalMs / 1000}s.`,
  );

  while (true) {
    let changed = false;

    for (const server of servers) {
      try {
        changed = (await tick(server, state[server.key])) || changed;
      } catch (error) {
        log(server, `Unerwarteter Fehler: ${error.stack || error.message}`);
      }
    }

    if (changed) {
      try {
        await saveState(state);
      } catch (error) {
        log(null, `State-Speicherfehler: ${error.message}`);
      }
    }

    await new Promise((resolve) => setTimeout(resolve, cfg.intervalMs));
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
