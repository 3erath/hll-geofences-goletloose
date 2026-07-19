#!/usr/bin/env python3
from __future__ import annotations

from datetime import datetime
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path('/opt/hll-geofences')
STAMP = datetime.now().strftime('%Y%m%d-%H%M%S')

AUTO = ROOT / 'geofence-auto.mjs'
PUBLIC = ROOT / 'geofence-public-guard.mjs'


def replace_once(text: str, old: str, new: str, label: str) -> tuple[str, bool]:
    if new in text:
        print(f'ℹ️  {label}: bereits vorhanden')
        return text, False
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f'{label}: erwarteten Block {count}x gefunden statt 1x')
    return text.replace(old, new, 1), True


def patch_file(path: Path, replacements: list[tuple[str, str, str]]) -> bool:
    if not path.exists():
        raise FileNotFoundError(path)

    original = path.read_text(encoding='utf-8')
    updated = original
    changed = False

    for old, new, label in replacements:
        updated, did_change = replace_once(updated, old, new, label)
        changed = changed or did_change

    if not changed:
        return False

    backup = path.with_name(f'{path.name}.before-mapswitch-{STAMP}.bak')
    shutil.copy2(path, backup)
    path.write_text(updated, encoding='utf-8')
    print(f'✅ {path.name} aktualisiert')
    print(f'   Backup: {backup}')
    return True


AUTO_STATUS_OLD = """async function running(service) {
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
"""

AUTO_STATUS_NEW = """async function serviceState(service) {
  const { stdout } = await compose('ps', '-a', '-q', service);
  const id = stdout.trim();
  if (!id) return { running: false, exitCode: null };

  const result = await execFileAsync(
    'docker',
    ['inspect', '-f', '{{.State.Running}} {{.State.ExitCode}}', id],
  );
  const [runningValue, exitCodeValue] = result.stdout.trim().split(/\\s+/);

  return {
    running: runningValue === 'true',
    exitCode: Number.isFinite(Number(exitCodeValue)) ? Number(exitCodeValue) : null,
  };
}

async function status(server) {
  const [midcapState, lastcapState] = await Promise.all([
    serviceState(server.midcap), serviceState(server.lastcap),
  ]);
  return {
    midcap: midcapState.running,
    lastcap: lastcapState.running,
    midcapExitCode: midcapState.exitCode,
    lastcapExitCode: lastcapState.exitCode,
  };
}
"""

AUTO_ANCHOR_OLD = """  if (live.midcap && live.lastcap) {
    log(server, 'WARNUNG: Midcap und Lastcap laufen gleichzeitig; keine Aktion.');
    return false;
  }

  if (state.phase === 'IDLE') {
"""

AUTO_ANCHOR_NEW = """  if (live.midcap && live.lastcap) {
    log(server, 'WARNUNG: Midcap und Lastcap laufen gleichzeitig; keine Aktion.');
    return false;
  }

  if (
    state.phase === 'MIDCAP' &&
    !live.midcap &&
    !live.lastcap &&
    live.midcapExitCode === 2
  ) {
    try {
      await start(server.midcap);
      log(server, 'Mapswitch erkannt; Midcap für die neue Map automatisch neu gestartet.');
    } catch (error) {
      log(server, `Midcap-Neustart nach Mapswitch fehlgeschlagen: ${error.message}`);
    }
    return true;
  }

  if (
    state.phase === 'LASTCAP' &&
    !live.midcap &&
    !live.lastcap &&
    live.lastcapExitCode === 2
  ) {
    try {
      await start(server.lastcap);
      log(server, 'Mapswitch erkannt; Lastcap für die neue Map automatisch neu gestartet.');
    } catch (error) {
      log(server, `Lastcap-Neustart nach Mapswitch fehlgeschlagen: ${error.message}`);
    }
    return true;
  }

  if (state.phase === 'IDLE') {
"""

PUBLIC_STATUS_OLD = """async function isRunning(service) {
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
"""

PUBLIC_STATUS_NEW = """async function serviceState(service) {
  const { stdout } = await compose('ps', '-a', '-q', service);
  const id = stdout.trim();
  if (!id) return { running: false, exitCode: null };

  const result = await execFileAsync(
    'docker',
    ['inspect', '-f', '{{.State.Running}} {{.State.ExitCode}}', id],
  );
  const [runningValue, exitCodeValue] = result.stdout.trim().split(/\\s+/);

  return {
    running: runningValue === 'true',
    exitCode: Number.isFinite(Number(exitCodeValue)) ? Number(exitCodeValue) : null,
  };
}

async function containerStatus(server) {
  const [midcapState, lastcapState] = await Promise.all([
    serviceState(server.midcap),
    serviceState(server.lastcap),
  ]);

  return {
    midcap: midcapState.running,
    lastcap: lastcapState.running,
    midcapExitCode: midcapState.exitCode,
    lastcapExitCode: lastcapState.exitCode,
  };
}
"""

PUBLIC_ANCHOR_OLD = """  if (state.active) {
    if (!live.lastcap) {
"""

PUBLIC_ANCHOR_NEW = """  if (
    state.active &&
    !live.midcap &&
    !live.lastcap &&
    live.lastcapExitCode === 2
  ) {
    try {
      await compose('up', '-d', '--force-recreate', server.lastcap);
      log(server, 'Mapswitch erkannt; Notfall-Lastcap für die neue Map automatisch neu gestartet.');
    } catch (error) {
      log(server, `Lastcap-Neustart nach Mapswitch fehlgeschlagen: ${error.message}`);
    }
    return true;
  }

  if (state.active) {
    if (!live.lastcap) {
"""


def main() -> int:
    try:
        changed_auto = patch_file(
            AUTO,
            [
                (AUTO_STATUS_OLD, AUTO_STATUS_NEW, 'Auto: Containerstatus mit Exit-Code'),
                (AUTO_ANCHOR_OLD, AUTO_ANCHOR_NEW, 'Auto: Mapswitch-Neustart'),
            ],
        )
        changed_public = patch_file(
            PUBLIC,
            [
                (PUBLIC_STATUS_OLD, PUBLIC_STATUS_NEW, 'Public Guard: Containerstatus mit Exit-Code'),
                (PUBLIC_ANCHOR_OLD, PUBLIC_ANCHOR_NEW, 'Public Guard: Mapswitch-Neustart'),
            ],
        )

        for path in (AUTO, PUBLIC):
            subprocess.run(['node', '--check', str(path)], check=True)
            print(f'✅ Syntax okay: {path.name}')

        if not changed_auto and not changed_public:
            print('ℹ️  Keine Änderung nötig; Fix war bereits installiert.')
        return 0
    except Exception as error:
        print(f'❌ Patch fehlgeschlagen: {error}', file=sys.stderr)
        print('Die PM2-Prozesse wurden nicht verändert.', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
