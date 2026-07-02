/**
 * provisioner/backend-config — render a systemd user-unit for a llama-server backend
 * (local-concurrent-inference-2026-07-02 P-009, D-006's "install/configure backend" step).
 * Pure string rendering — this module never writes a file or touches systemd itself;
 * provision.ts's applyProvision() does the (injectable) write.
 *
 * The shape mirrors this box's real, currently-live `llama-ornith.service` unit
 * (verified via `systemctl --user cat llama-ornith.service`) so the wizard's own output is
 * consistent with the hand-tuned reference config it was designed from.
 */

export interface LlamaServerUnitOptions {
  /** Human-readable alias passed to llama-server's --alias (shows up in /v1/models). */
  alias: string;
  weightsPath: string;
  host: string;
  port: number;
  parallelSlots: number;
  ctxTotal: number;
  kvCacheType: string;
  flashAttn: boolean;
  /** Absolute path to append stdout/stderr to. */
  logPath: string;
  /** llama-server binary — defaults to relying on PATH. */
  binPath?: string;
  description?: string;
}

/** Render a systemd user-unit file (`[Unit]/[Service]/[Install]`) for a llama-server backend. */
export function renderLlamaServerUnit(opts: LlamaServerUnitOptions): string {
  const bin = opts.binPath ?? 'llama-server';
  const description = opts.description ?? `llama-server serving ${opts.alias} (provisioner wizard — local-concurrent-inference-2026-07-02 P-009)`;
  return `[Unit]
Description=${description}
After=network.target

[Service]
Type=simple
ExecStart=${bin} \\
  -m ${opts.weightsPath} \\
  --host ${opts.host} --port ${opts.port} \\
  --flash-attn ${opts.flashAttn ? 'on' : 'off'} \\
  -np ${opts.parallelSlots} -c ${opts.ctxTotal} \\
  --cache-type-k ${opts.kvCacheType} --cache-type-v ${opts.kvCacheType} \\
  --alias ${opts.alias}
Restart=on-failure
RestartSec=5
Nice=5
StandardOutput=append:${opts.logPath}
StandardError=append:${opts.logPath}

[Install]
WantedBy=default.target
`;
}
