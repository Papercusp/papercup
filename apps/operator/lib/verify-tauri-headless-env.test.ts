/**
 * verify-tauri-headless-env.test.ts — recurrence guard for
 * EI-20210154033151684.
 *
 * A verifier launched from an agent session inherits the operator host's
 * cluster and spawner-sidecar environment. Those values must be scrubbed at
 * the generated Tauri launcher boundary; the dev-operator's later defaults
 * cannot protect Tauri's beforeDevCommand or stale socket adoption.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const SCRIPT = resolve(__dirname, '../../../scripts/verify-tauri-headless.sh');
const src = readFileSync(SCRIPT, 'utf8');
const devWrapper = readFileSync(
  resolve(__dirname, '../../../papercusp-desktop/bin/dev-operator-ifneeded.sh'),
  'utf8',
);
const launchTemplate = src.match(
  /cat > "\$WORK\/launch\.sh" <<LAUNCH\n([\s\S]*?)\nLAUNCH/,
)?.[1];

describe('EI-20210154033151684 — verifier launch scrubs ambient runtime env', () => {
  it('keeps disposable backup coordination local despite inherited host pins', () => {
    const assignment = src.match(/^  ISOLATED_ENV_LINE\+=" KOPIA_BACKUP_LOCK_PATH=.*$/m)?.[0];
    expect(assignment).toBeTruthy();
    const preserve = devWrapper.match(/DEV_CALLER_OVERRIDES=""\n[\s\S]*?\ndone/)?.[0];
    expect(preserve).toBeTruthy();
    // Execute the real assignment and wrapper capture, including paths with
    // spaces and a conflicting .env.local value after caller capture.
    const result = execFileSync('bash', ['-c', `
      WORK='/tmp/private verifier'
      ISOLATED_ENV_LINE=''
      ${assignment}
      eval "export $ISOLATED_ENV_LINE"
      ${preserve}
      export KOPIA_BACKUP_LOCK_PATH=/run/lock/papercusp/kopia-global.lock
      export KOPIA_BACKUP_STATE_DIR=/tmp/host-state
      eval "env $DEV_CALLER_OVERRIDES printenv KOPIA_BACKUP_LOCK_PATH KOPIA_BACKUP_STATE_DIR"
    `], { encoding: 'utf8', env: {
      ...process.env,
      KOPIA_BACKUP_LOCK_PATH: '/run/lock/papercusp/kopia-global.lock',
      KOPIA_BACKUP_STATE_DIR: '/tmp/inherited-host-state',
    } });
    expect(result.trim().split('\n')).toEqual([
      '/tmp/private verifier/backup-guard/kopia.lock',
      '/tmp/private verifier/backup-guard/state',
    ]);
  });

  it('pins single-process execution and removes ambient spawner state', () => {
    expect(launchTemplate).toBeTruthy();
    expect(launchTemplate).toContain(
      'exec env -u WAYLAND_DISPLAY -u PAPERCUSP_SPAWNER_IPC_SOCKET',
    );
    expect(launchTemplate).toContain(
      'PAPERCUSP_CLUSTER=0 PAPERCUSP_CLUSTER_WORKERS=0',
    );
    expect(launchTemplate).toContain(
      'PAPERCUSP_SPAWNER_SIDECAR=0 PAPERCUSP_SPAWNER_SIDECAR_MODE=0',
    );
  });

  it('disables every explicit git-sidecar override at the verifier boundary', () => {
    // gitSidecarEnabled() checks these subsystem-specific overrides before the
    // shared PAPERCUSP_SPAWNER_SIDECAR switch. Leaving one inherited from the
    // operator host can create a sidecar in the shared slice even when the
    // verifier pins its global spawner switch off.
    expect(launchTemplate).toBeTruthy();
    for (const variable of [
      'PAPERCUSP_DEV_DEPLOY_SPAWN_SIDECAR=0',
      'PAPERCUSP_SYSTEM_HEALTH_SPAWN_SIDECAR=0',
      'PAPERCUSP_GIT_SYNC_SPAWN_SIDECAR=0',
      'PAPERCUSP_GIT_PIPELINE_SPAWN_SIDECAR=0',
      'PAPERCUSP_POT_GIT_SPAWN_SIDECAR=0',
      'PAPERCUSP_HARNESS_DOCS_SPAWN_SIDECAR=0',
    ]) {
      expect(launchTemplate).toContain(variable);
    }
  });

  it('pins the private verifier host to loopback instead of inheriting a dev .env bind', () => {
    // EI-21140610191173818: apps/operator/.env.local legitimately configures a
    // remote-capable dev host with PAPERCUSP_BIND_HOST=0.0.0.0. The isolated
    // verifier must override it or remote-auth-policy fails closed before the
    // desktop starts (eight supervised crash-loop attempts in the live repro).
    expect(launchTemplate).toContain('PAPERCUSP_BIND_HOST=127.0.0.1');
    // The wrapper preserves explicit caller values through one loop; the bind
    // host must stay in its key list, and only a non-empty value is carried.
    expect(devWrapper).toMatch(/for DEV_CALLER_KEY in [^;\n]*\bPAPERCUSP_BIND_HOST\b[^;\n]*; do/);
    expect(devWrapper).toContain('if [ -n "${!DEV_CALLER_KEY:-}" ]; then');
    // The override must be spliced into the SAME `env` invocation that sets the
    // operator port, so it wins over the sourced .env.local. Other plain
    // VAR=value assignments may sit between them (e.g. MALLOC_ARENA_MAX=2).
    expect(devWrapper).toMatch(
      /env \$\{DEV_CALLER_OVERRIDES\}(?:[A-Z_][A-Z0-9_]*=\S+ )*PAPERCUSP_HONO_PORT=\$PORT/,
    );
  });
});
