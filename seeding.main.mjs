import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
} from 'discord.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config();

const execPromise = promisify(exec);

const {
  DISCORD_TOKEN,
  CHANNEL_ID,
  CHANNEL_ID_2,
  SERVER_NAME = 'HLL Server',
  CRCON_API_URL = '',
  CRCON_API_KEY = '',
  BOT_FLAG = '🌱',
} = process.env;

if (!DISCORD_TOKEN || !CHANNEL_ID) {
  throw new Error('Missing DISCORD_TOKEN or CHANNEL_ID in .env');
}

function envInt(name, fallback, minimum = 0) {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(parsed, minimum);
}

const midcapThreshold = envInt('MIDCAP_BOT_THRESHOLD', 35);
const lastcapThreshold = envInt('LASTCAP_BOT_THRESHOLD', 5);
const armAtBotCount = envInt('BOT_COUNT_ARM_AT', midcapThreshold + 1, 1);
const requiredConfirmations = envInt('BOT_COUNT_CONFIRMATIONS', 3, 1);
const checkIntervalMs = envInt('BOT_COUNT_INTERVAL_SECONDS', 5, 1) * 1000;
const crconTimeoutMs = envInt('CRCON_TIMEOUT_SECONDS', 10, 1) * 1000;

const projectDir = process.cwd();
const projectName = 'hll-geofences-midcap';
const stateFile = path.join(projectDir, '.geofence-auto-state.json');

const services = [
  { key: 'midcap', name: 'hll-geofences-midcap', label: 'MIDCAP' },
  { key: 'lastcap', name: 'hll-geofences-lastcap', label: 'LASTCAP' },
];

const serviceByKey = Object.fromEntries(
  services.map((service) => [service.key, service]),
);

const automationConfigured = Boolean(
  CRCON_API_URL.trim() && CRCON_API_KEY.trim(),
);

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

function freshAutomationState() {
  return {
    enabled: false,
    phase: 'off',
    midcapArmed: false,
    peakBotCount: 0,
    lastBotCount: null,
    confirmations: 0,
    lastCheckAt: null,
    lastError: null,
  };
}

let automation = freshAutomationState();
let automationTickRunning = false;

async function run(command) {
  const { stdout, stderr } = await execPromise(command, { cwd: projectDir });
  return (stdout || stderr || '').trim();
}

async function serviceIsRunning(serviceName) {
  const out = await run(`docker ps -q -f name=^${serviceName}$`);
  return out.length > 0;
}

async function startService(serviceName) {
  if (await serviceIsRunning(serviceName)) return '';
  return run(`docker compose -p ${projectName} up -d ${serviceName}`);
}

async function stopService(serviceName) {
  if (!(await serviceIsRunning(serviceName))) return '';
  return run(`docker compose -p ${projectName} stop ${serviceName}`);
}

async function applyFenceMode(mode) {
  const midcap = serviceByKey.midcap.name;
  const lastcap = serviceByKey.lastcap.name;

  if (mode === 'midcap') {
    await stopService(lastcap);
    await startService(midcap);
    return;
  }

  if (mode === 'lastcap') {
    await stopService(midcap);
    await startService(lastcap);
    return;
  }

  if (mode === 'off') {
    await stopService(midcap);
    await stopService(lastcap);
    return;
  }

  throw new Error(`Unknown fence mode: ${mode}`);
}

async function getStatuses() {
  const rows = [];
  for (const service of services) {
    rows.push({ ...service, running: await serviceIsRunning(service.name) });
  }
  return rows;
}

function serializableAutomationState() {
  return {
    enabled: automation.enabled,
    phase: automation.phase,
    midcapArmed: automation.midcapArmed,
    peakBotCount: automation.peakBotCount,
  };
}

async function saveAutomationState() {
  await writeFile(
    stateFile,
    `${JSON.stringify(serializableAutomationState(), null, 2)}\n`,
    'utf8',
  );
}

async function loadAutomationState() {
  try {
    const raw = await readFile(stateFile, 'utf8');
    const saved = JSON.parse(raw);

    automation = {
      ...freshAutomationState(),
      enabled: Boolean(saved.enabled),
      phase: ['off', 'midcap', 'lastcap', 'complete', 'manual'].includes(
        saved.phase,
      )
        ? saved.phase
        : 'off',
      midcapArmed: Boolean(saved.midcapArmed),
      peakBotCount: Number.isFinite(saved.peakBotCount)
        ? saved.peakBotCount
        : 0,
    };

    if (
      automation.enabled
      && !['midcap', 'lastcap'].includes(automation.phase)
    ) {
      automation.enabled = false;
      automation.phase = 'off';
    }

    if (automation.enabled) {
      console.log(
        `Resuming geofence automation in phase ${automation.phase}`,
      );
      await applyFenceMode(automation.phase);
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      console.error('Unable to load automation state:', error);
    }
    automation = freshAutomationState();
  }
}

function resolveCrconTeamViewUrl() {
  const raw = CRCON_API_URL.trim();

  if (!raw) {
    throw new Error('CRCON_API_URL is not configured');
  }

  if (/\/get_team_view\/?$/i.test(raw)) {
    return raw;
  }

  const base = raw.endsWith('/') ? raw : `${raw}/`;
  return new URL('get_team_view', base).toString();
}

function extractOnlinePlayers(teamView) {
  const players = [];

  for (const teamKey of ['axis', 'allies', 'unassigned']) {
    const team = teamView?.[teamKey];
    if (!team || typeof team !== 'object') continue;

    if (team.commander) {
      players.push(team.commander);
    }

    for (const squad of Object.values(team.squads ?? {})) {
      if (Array.isArray(squad?.players)) {
        players.push(...squad.players);
      }
    }
  }

  const unique = new Map();

  for (const player of players) {
    const id =
      player?.player_id
      ?? player?.id
      ?? `${player?.name ?? 'unknown'}:${player?.team ?? ''}`;

    unique.set(String(id), player);
  }

  return [...unique.values()];
}

function playerHasBotFlag(player) {
  const flags = player?.profile?.flags;

  if (!Array.isArray(flags)) return false;

  return flags.some((entry) => {
    const value =
      typeof entry === 'string'
        ? entry
        : entry?.flag ?? entry?.emoji ?? '';

    return String(value).includes(BOT_FLAG);
  });
}

async function fetchFlaggedBotCount() {
  if (!automationConfigured) {
    throw new Error(
      'CRCON automation is not configured. Set CRCON_API_URL and CRCON_API_KEY.',
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), crconTimeoutMs);

  try {
    const response = await fetch(resolveCrconTeamViewUrl(), {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${CRCON_API_KEY.trim()}`,
      },
      signal: controller.signal,
    });

    const payload = await response.json();

    if (!response.ok) {
      throw new Error(
        `CRCON returned HTTP ${response.status}: ${
          payload?.error ?? response.statusText
        }`,
      );
    }

    if (payload?.failed) {
      throw new Error(payload.error || 'CRCON get_team_view failed');
    }

    const teamView = payload?.result ?? payload;
    const players = extractOnlinePlayers(teamView);
    const bots = players.filter(playerHasBotFlag);

    return {
      count: bots.length,
      totalPlayers: players.length,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function confirmationText() {
  return `${automation.confirmations}/${requiredConfirmations}`;
}

function automationStatusText() {
  if (!automationConfigured) {
    return '⚫ Nicht konfiguriert';
  }

  if (automation.enabled && automation.phase === 'midcap') {
    if (!automation.midcapArmed) {
      return `🟡 MIDCAP aktiv – warte auf mindestens ${armAtBotCount} ${BOT_FLAG}-Bots`;
    }

    return `🟢 MIDCAP aktiv – Wechsel bei ≤ ${midcapThreshold} (${confirmationText()})`;
  }

  if (automation.enabled && automation.phase === 'lastcap') {
    return `🟠 LASTCAP aktiv – Abschaltung bei ≤ ${lastcapThreshold} (${confirmationText()})`;
  }

  if (automation.phase === 'complete') {
    return '✅ Seeding beendet – beide GeoFences aus';
  }

  if (automation.phase === 'manual') {
    return '⚪ Manuelle Steuerung';
  }

  return '⚫ Aus';
}

async function buildMessage() {
  const statuses = await getStatuses();
  const anyRunning = statuses.some((service) => service.running);

  const embed = new EmbedBuilder()
    .setTitle('HLL Geofence Control')
    .setDescription(
      'Manuelle Steuerung und automatische Umschaltung anhand der 🌱-Flags.',
    )
    .setColor(
      automation.enabled
        ? 0x00aa55
        : anyRunning
          ? 0xffaa00
          : 0xaa0000,
    )
    .setFooter({ text: `Server: ${SERVER_NAME}` })
    .setTimestamp();

  for (const service of statuses) {
    embed.addFields({
      name: service.name,
      value: service.running ? '🟢 Running' : '🔴 Stopped',
      inline: false,
    });
  }

  embed.addFields({
    name: 'Automatik',
    value: automationStatusText(),
    inline: false,
  });

  const measured =
    automation.lastBotCount === null
      ? 'Noch keine erfolgreiche Messung'
      : `${automation.lastBotCount} ${BOT_FLAG}-Bots online`;

  embed.addFields({
    name: `${BOT_FLAG} Bot-Zählung`,
    value: `${measured}\nSpitzenwert: ${automation.peakBotCount}`,
    inline: false,
  });

  if (automation.lastError) {
    embed.addFields({
      name: 'Letzter CRCON-Fehler',
      value: automation.lastError.slice(0, 1000),
      inline: false,
    });
  }

  const rows = services.map((service) => {
    const status = statuses.find((row) => row.name === service.name);

    return new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`start:${service.name}`)
        .setLabel(`START ${service.label}`)
        .setStyle(ButtonStyle.Success)
        .setDisabled(status?.running ?? false),
      new ButtonBuilder()
        .setCustomId(`stop:${service.name}`)
        .setLabel(`STOP ${service.label}`)
        .setStyle(ButtonStyle.Danger)
        .setDisabled(!(status?.running ?? false)),
    );
  });

  rows.push(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('auto:start')
        .setLabel('START SEEDING-AUTOMATIK')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(automation.enabled || !automationConfigured),
      new ButtonBuilder()
        .setCustomId('auto:stop')
        .setLabel('STOP AUTO + GEOFENCES')
        .setStyle(ButtonStyle.Danger)
        .setDisabled(!automation.enabled && !anyRunning),
    ),
  );

  return { embeds: [embed], components: rows };
}

async function refreshChannel(channel) {
  const payload = await buildMessage();
  const messages = await channel.messages.fetch({ limit: 10 });
  const botMessage = messages.find((message) => message.author.id === client.user.id);

  if (botMessage) {
    await botMessage.edit(payload);
  } else {
    await channel.send(payload);
  }
}

async function refreshAllChannels() {
  const channelIds = [CHANNEL_ID, CHANNEL_ID_2].filter(Boolean);

  for (const id of channelIds) {
    const channel = await client.channels.fetch(id);
    if (channel) await refreshChannel(channel);
  }
}

async function startAutomation() {
  if (!automationConfigured) {
    throw new Error(
      'Set CRCON_API_URL and CRCON_API_KEY in .env before starting automation.',
    );
  }

  await applyFenceMode('midcap');

  automation = {
    ...freshAutomationState(),
    enabled: true,
    phase: 'midcap',
  };

  await saveAutomationState();
  console.log('Geofence automation started: MIDCAP active');
}

async function stopAutomation({ stopFences = true, phase = 'off' } = {}) {
  if (stopFences) {
    await applyFenceMode('off');
  }

  automation = {
    ...freshAutomationState(),
    phase,
  };

  await saveAutomationState();
}

async function transitionToLastcap() {
  await applyFenceMode('lastcap');
  automation.phase = 'lastcap';
  automation.confirmations = 0;
  automation.lastError = null;
  await saveAutomationState();

  console.log(
    `Geofence automation switched to LASTCAP at ${automation.lastBotCount} bots`,
  );
}

async function finishAutomation() {
  await applyFenceMode('off');
  automation.enabled = false;
  automation.phase = 'complete';
  automation.confirmations = 0;
  automation.lastError = null;
  await saveAutomationState();

  console.log(
    `Geofence automation completed at ${automation.lastBotCount} bots`,
  );
}

async function tickAutomation() {
  if (!automation.enabled || automationTickRunning) return;

  automationTickRunning = true;
  let refreshNeeded = false;

  try {
    const { count, totalPlayers } = await fetchFlaggedBotCount();

    automation.lastBotCount = count;
    automation.lastCheckAt = new Date().toISOString();
    automation.lastError = null;
    automation.peakBotCount = Math.max(automation.peakBotCount, count);

    console.log(
      `Geofence automation: phase=${automation.phase} bots=${count} total_players=${totalPlayers}`,
    );

    if (automation.phase === 'midcap') {
      if (!automation.midcapArmed) {
        automation.confirmations = 0;

        if (count >= armAtBotCount) {
          automation.midcapArmed = true;
          refreshNeeded = true;
          await saveAutomationState();
          console.log(
            `MIDCAP threshold armed after seeing ${count} flagged bots`,
          );
        }

        return;
      }

      if (count <= midcapThreshold) {
        automation.confirmations += 1;
      } else {
        automation.confirmations = 0;
      }

      if (automation.confirmations >= requiredConfirmations) {
        await transitionToLastcap();
        refreshNeeded = true;
      }
    } else if (automation.phase === 'lastcap') {
      if (count <= lastcapThreshold) {
        automation.confirmations += 1;
      } else {
        automation.confirmations = 0;
      }

      if (automation.confirmations >= requiredConfirmations) {
        await finishAutomation();
        refreshNeeded = true;
      }
    }
  } catch (error) {
    automation.lastError =
      error?.name === 'AbortError'
        ? `CRCON request timed out after ${crconTimeoutMs / 1000}s`
        : error?.message ?? String(error);

    console.error('Geofence automation check failed:', error);
  } finally {
    automationTickRunning = false;

    if (refreshNeeded) {
      try {
        await refreshAllChannels();
      } catch (error) {
        console.error('Unable to refresh Discord channels:', error);
      }
    }
  }
}

client.once('clientReady', async () => {
  console.log(`Bot started for ${SERVER_NAME}`);

  await loadAutomationState();
  await refreshAllChannels();

  setInterval(() => {
    refreshAllChannels().catch((error) => {
      console.error('Discord refresh failed:', error);
    });
  }, 30_000);

  setInterval(() => {
    tickAutomation().catch((error) => {
      console.error('Automation tick failed:', error);
    });
  }, checkIntervalMs);

  if (automation.enabled) {
    await tickAutomation();
  }
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;

  const [action, target] = interaction.customId.split(':');

  if (action === 'auto') {
    await interaction.deferReply({ ephemeral: true });

    try {
      if (target === 'start') {
        await startAutomation();
        await tickAutomation();
        await refreshAllChannels();

        await interaction.editReply({
          content:
            `Seeding-Automatik gestartet.\n`
            + `MIDCAP ist aktiv. Der Wechsel auf LASTCAP erfolgt nach `
            + `${requiredConfirmations} bestätigten Messungen mit höchstens `
            + `${midcapThreshold} ${BOT_FLAG}-Bots.`,
        });
        return;
      }

      if (target === 'stop') {
        await stopAutomation({ stopFences: true, phase: 'off' });
        await refreshAllChannels();

        await interaction.editReply({
          content: 'Automatik beendet. MIDCAP und LASTCAP wurden gestoppt.',
        });
        return;
      }

      await interaction.editReply({ content: 'Unbekannte Automatik-Aktion.' });
    } catch (error) {
      await interaction.editReply({ content: `Error: ${error.message}` });
    }

    return;
  }

  const serviceExists = services.some((service) => service.name === target);

  if (!['start', 'stop'].includes(action) || !serviceExists) return;

  await interaction.deferReply({ ephemeral: true });

  try {
    if (automation.enabled) {
      await stopAutomation({ stopFences: false, phase: 'manual' });
    } else {
      automation.phase = 'manual';
      await saveAutomationState();
    }

    const command =
      action === 'start'
        ? `docker compose -p ${projectName} up -d ${target}`
        : `docker compose -p ${projectName} stop ${target}`;

    const output = await run(command);
    await refreshAllChannels();

    await interaction.editReply({
      content: `Done: ${action} ${target}\n\`\`\`\n${output || 'No output'}\n\`\`\``,
    });
  } catch (error) {
    await interaction.editReply({ content: `Error: ${error.message}` });
  }
});

client.login(DISCORD_TOKEN);
