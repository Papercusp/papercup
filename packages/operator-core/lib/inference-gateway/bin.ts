#!/usr/bin/env node
/**
 * Executable entry for the supervised hive inference gateway (hive-inference-gateway P-013).
 * Run by the `papercup-inference-gateway` systemd --user unit (Restart=always = fail-closed).
 *
 * Env:
 *   PAPERCUSP_GATEWAY_PORT         localhost port to listen on (default 8788)
 *   PAPERCUSP_GATEWAY_CONCURRENCY  max forwarded requests at once (default 24)
 *   PAPERCUSP_WORKSPACE            workspace id for account-pool resolution (default: active)
 *   PAPERCUSP_ACCOUNT_ID           pin a specific pool account (else sole-account / local fallback)
 *   ANTHROPIC_BASE_URL_UPSTREAM    override the upstream (default https://api.anthropic.com)
 *   PAPERCUSP_GATEWAY_HARD_STOP_MS hard drain ceiling before force-exit (default 12000, < TimeoutStopSec)
 *   PAPERCUSP_GATEWAY_LOG          durable lifecycle log path (default ~/.papercusp/gateway.log)
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { startGatewayService, DEFAULT_GATEWAY_PORT } from './launch';

/** Hard ceiling on the SIGTERM drain before we force-exit — DEFENSE-IN-DEPTH behind gateway.close()'s
 *  own GRACEFUL_SHUTDOWN_MS (~5s) grace. MUST stay below the unit's TimeoutStopSec=30s so WE exit first,
 *  rather than systemd escalating to SIGKILL (which orphans the tsx children + drops every in-flight
 *  bee/queen spawn — the EI-2421 crash-loop mechanism). Env-tunable. */
const HARD_STOP_MS = Number(process.env.PAPERCUSP_GATEWAY_HARD_STOP_MS) || 12_000;
/** Durable, journald-INDEPENDENT lifecycle log. journald's stdout-socket capture
 *  (/run/systemd/journal/stdout) was observed wedged host-wide (2026-06-22, EI-2421), making the
 *  gateway's up/shutdown lines invisible — which is why a restart's timing + reason couldn't be seen.
 *  Mirror them to a file (synchronous append, immediately readable) so they survive regardless of
 *  journald. Env-tunable. */
const LOG_FILE = process.env.PAPERCUSP_GATEWAY_LOG || join(homedir(), '.papercusp', 'gateway.log');

let logDirEnsured = false;
function logLine(m: string): void {
  const line = `[inference-gateway ${new Date().toISOString()}] ${m}`;
  console.log(line);
  try {
    if (!logDirEnsured) {
      mkdirSync(dirname(LOG_FILE), { recursive: true });
      logDirEnsured = true;
    }
    appendFileSync(LOG_FILE, line + '\n');
  } catch {
    /* durable log unavailable (perm/disk) — console.log remains the fallback; never let logging crash boot/shutdown */
  }
}

async function main(): Promise<void> {
  const svc = await startGatewayService({
    port: Number(process.env.PAPERCUSP_GATEWAY_PORT) || DEFAULT_GATEWAY_PORT,
    workspace: process.env.PAPERCUSP_WORKSPACE || undefined,
    concurrency: Number(process.env.PAPERCUSP_GATEWAY_CONCURRENCY) || undefined,
    upstreamBase: process.env.ANTHROPIC_BASE_URL_UPSTREAM || undefined,
  });
  logLine(`up on 127.0.0.1:${svc.port} → account '${svc.account.accountId}' (${svc.account.source})`);

  let stopping = false;
  const shutdown = async (sig: string) => {
    if (stopping) return;
    stopping = true;
    const t0 = Date.now();
    logLine(`${sig} → draining + stopping (hard ceiling ${HARD_STOP_MS}ms)`);
    // DEFENSE-IN-DEPTH: race the (already-bounded) drain against a hard ceiling so a wedged close()
    // can never let systemd's TimeoutStopSec expire → SIGKILL → orphan leak. We exit no matter what.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const hardStop = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), HARD_STOP_MS);
      timer.unref?.();
    });
    const drain = svc
      .stop()
      .then(() => 'drained' as const)
      .catch((e) => {
        logLine(`stop() error (continuing to exit): ${(e as Error).message}`);
        return 'drained' as const;
      });
    const outcome = await Promise.race([drain, hardStop]);
    if (timer) clearTimeout(timer);
    if (outcome === 'timeout') {
      logLine(`drain exceeded ${HARD_STOP_MS}ms — FORCE-exiting before systemd SIGKILL (close() grace wedged? investigate)`);
    } else {
      logLine(`drained cleanly in ${Date.now() - t0}ms → exit`);
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((e) => {
  try {
    logLine(`fatal: ${(e as Error)?.stack || String(e)}`);
  } catch {
    console.error('[inference-gateway] fatal:', e);
  }
  process.exit(1);
});
