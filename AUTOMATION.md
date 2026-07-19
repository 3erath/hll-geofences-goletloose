# Automatic geofence switching

The Discord control bot can automatically switch the seeding geofences by counting online CRCON players with the `🌱` flag.

## State machine

1. Press **START SEEDING-AUTOMATIK**.
2. LASTCAP is stopped and MIDCAP is started.
3. The controller waits until it has seen at least `BOT_COUNT_ARM_AT` flagged bots once. This prevents an immediate switch while the bots are still joining.
4. After `BOT_COUNT_CONFIRMATIONS` consecutive measurements with `MIDCAP_BOT_THRESHOLD` or fewer flagged bots, MIDCAP is stopped and LASTCAP is started.
5. After the same number of consecutive measurements with `LASTCAP_BOT_THRESHOLD` or fewer flagged bots, LASTCAP is stopped and the automation ends.

With the default settings this means:

- Start: MIDCAP on, LASTCAP off
- 35 or fewer `🌱` bots: MIDCAP off, LASTCAP on
- 5 or fewer `🌱` bots: LASTCAP off

The automation only moves forward. A reconnect above a previous threshold does not return it to an earlier phase.

## CRCON setup

The controller calls the CRCON `get_team_view` endpoint. Its result includes the online players and their profile flags.

Add the following values to `.env`:

```dotenv
CRCON_API_URL=https://your-crcon.example/api/
CRCON_API_KEY=your_api_key
BOT_FLAG=🌱
MIDCAP_BOT_THRESHOLD=35
LASTCAP_BOT_THRESHOLD=5
BOT_COUNT_ARM_AT=36
BOT_COUNT_CONFIRMATIONS=3
BOT_COUNT_INTERVAL_SECONDS=5
CRCON_TIMEOUT_SECONDS=10
```

The CRCON API key must belong to a user that is allowed to call `get_team_view`.

## Safety behavior

- A failed or timed-out CRCON request never changes a geofence.
- Three consecutive measurements are required by default.
- Manual MIDCAP or LASTCAP buttons cancel the active automation so it cannot fight a manual decision.
- **STOP AUTO + GEOFENCES** stops the automation and both Docker services.
- The current phase is stored in `.geofence-auto-state.json`, allowing the controller to resume after a PM2 restart.

## Install and restart

```bash
npm install
pm2 restart hll-geofences-bot --update-env
pm2 logs hll-geofences-bot --lines 100
```

The Discord embed displays the current service state, automation phase, last successful bot count, peak bot count and the last CRCON error.
