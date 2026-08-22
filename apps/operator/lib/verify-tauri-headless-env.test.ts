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
import { describe, expect, it } from 'vitest';

const SCRIPT = resolve(__dirname, '../../../scripts/verify-tauri-headless.sh');
const src = readFileSync(SCRIPT, 'utf8');
const launchTemplate = src.match(
  /cat > "\$WORK\/launch\.sh" <<LAUNCH\n([\s\S]*?)\nLAUNCH/,
)?.[1];

describe('EI-20210154033151684 — verifier launch scrubs ambient runtime env', () => {
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
});
