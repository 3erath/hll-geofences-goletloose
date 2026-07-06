import { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import dotenv from 'dotenv';

dotenv.config();

const execPromise = promisify(exec);

const {
  DISCORD_TOKEN,
  CHANNEL_ID,
  CHANNEL_ID_2,
  SERVER_NAME = 'HLL Server',
} = process.env;

if (!DISCORD_TOKEN || !CHANNEL_ID) {
  throw new Error('Missing DISCORD_TOKEN or CHANNEL_ID in .env');
}

const projectDir = process.cwd();
const projectName = 'hll-geofences-midcap';
const services = [
  { key: 'midcap', name: 'hll-geofences-midcap', label: 'MIDCAP' },
  { key: 'lastcap', name: 'hll-geofences-lastcap', label: 'LASTCAP' },
];

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

async function run(command) {
  const { stdout, stderr } = await execPromise(command, { cwd: projectDir });
  return (stdout || stderr || '').trim();
}

async function serviceIsRunning(serviceName) {
  const out = await run(`docker ps -q -f name=^${serviceName}$`);
  return out.length > 0;
}

async function getStatuses() {
  const rows = [];
  for (const service of services) {
    rows.push({ ...service, running: await serviceIsRunning(service.name) });
  }
  return rows;
}

async function buildMessage() {
  const statuses = await getStatuses();
  const anyRunning = statuses.some((s) => s.running);

  const embed = new EmbedBuilder()
    .setTitle('HLL Geofence Control')
    .setDescription('Start/Stop Docker services for seeding geofences')
    .setColor(anyRunning ? 0x00aa55 : 0xaa0000)
    .setFooter({ text: `Server: ${SERVER_NAME}` })
    .setTimestamp();

  for (const s of statuses) {
    embed.addFields({
      name: s.name,
      value: s.running ? '🟢 Running' : '🔴 Stopped',
      inline: false,
    });
  }

  const rows = services.map((service) => {
    const status = statuses.find((s) => s.name === service.name);
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

  return { embeds: [embed], components: rows };
}

async function refreshChannel(channel) {
  const payload = await buildMessage();
  const messages = await channel.messages.fetch({ limit: 10 });
  const botMessage = messages.find((m) => m.author.id === client.user.id);

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

client.once('clientReady', async () => {
  console.log(`Bot started for ${SERVER_NAME}`);
  await refreshAllChannels();
  setInterval(refreshAllChannels, 30_000);
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;

  const [action, serviceName] = interaction.customId.split(':');
  if (!['start', 'stop'].includes(action) || !services.some((s) => s.name === serviceName)) return;

  await interaction.deferReply({ ephemeral: true });

  try {
    const command = action === 'start'
      ? `docker compose -p ${projectName} up -d ${serviceName}`
      : `docker compose -p ${projectName} stop ${serviceName}`;

    const output = await run(command);
    await refreshAllChannels();

    await interaction.editReply({
      content: `Done: ${action} ${serviceName}\n\`\`\`\n${output || 'No output'}\n\`\`\``,
    });
  } catch (error) {
    await interaction.editReply({ content: `Error: ${error.message}` });
  }
});

client.login(DISCORD_TOKEN);
