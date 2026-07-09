# HLL Geofences - go-let-loose Worker

Custom Hell Let Loose geofence worker based on `go-let-loose`.

This version was created because the original worker returned player positions as `X:0 Y:0 Z:0` on my server, while `go-let-loose` correctly reads real `WorldPosition` data through RCONv2.

## Features

- Reads player positions through RCONv2
- Supports Allies and Axis geofences
- Sends warning messages to players outside the allowed area
- Punishes players after a configurable delay
- Supports map and game mode conditions
- Ignores `player_count` conditions so the geofence can be controlled manually through the Discord buttons
- Works with Docker Compose
- Includes a Discord button bot for starting and stopping Midcap/Lastcap containers

## Current behavior

- `Allies` players are checked against `AlliesFence`.
- `Axis` players are checked against `AxisFence`.
- Grid checks are strict. If a player crosses into a non-allowed grid cell, the worker warns them immediately and punishes them after the configured delay.
- No extra safety margin is applied around grid borders by default.
- Player count conditions are intentionally ignored. Start and stop the geofence manually with the Discord buttons instead.

## Manual control

The geofence is controlled by starting or stopping the Docker containers:

- Start Midcap = Midcap geofence active
- Stop Midcap = Midcap geofence inactive
- Start Lastcap = Lastcap geofence active
- Stop Lastcap = Lastcap geofence inactive

Do not start a geofence container during a live public match unless you really want the configured fence to apply immediately.

## Important

Do not commit live config files.

These files should stay private:

- `.env`
- `seeding.midcap.yml`
- `seeding.lastcap.yml`
- `config.yml`

Use `seeding.example.yml` and `.env.example` as templates.

## Setup

Copy the example config:

```bash
cp seeding.example.yml seeding.midcap.yml
cp seeding.example.yml seeding.lastcap.yml
```

Edit both files and insert your HLL RCON host, port, password and geofence settings.

## Build Docker image

```bash
docker build --no-cache --pull -t hll-geofences-goletloose:latest .
```

## Start Midcap

```bash
docker compose -p hll-geofences-midcap up -d hll-geofences-midcap
```

## Start Lastcap

```bash
docker compose -p hll-geofences-midcap up -d hll-geofences-lastcap
```

## Stop services

```bash
docker compose -p hll-geofences-midcap stop hll-geofences-midcap hll-geofences-lastcap
```

## Logs

```bash
docker compose -p hll-geofences-midcap logs -f --tail=100 hll-geofences-midcap
```

## Discord bot

Copy the example env file:

```bash
cp .env.example .env
```

Edit `.env` and insert your Discord bot token and channel ID.

Install dependencies:

```bash
npm install
```

Start the bot:

```bash
npm start
```

Optional PM2 setup:

```bash
npm install -g pm2
pm2 start seeding.main.mjs --name hll-geofences-bot
pm2 save
pm2 startup
```

## GitHub safety check

Before pushing, run:

```bash
git status
```

Make sure `.env`, `seeding.midcap.yml` and `seeding.lastcap.yml` are not listed as staged files.
