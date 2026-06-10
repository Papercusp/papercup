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
 */
import { startGatewayService, DEFAULT_GATEWAY_PORT } from './launch';

async function main(): Promise<void> {
  const svc = await startGatewayService({
    port: Number(process.env.PAPERCUSP_GATEWAY_PORT) || DEFAULT_GATEWAY_PORT,
    workspace: process.env.PAPERCUSP_WORKSPACE || undefined,
    concurrency: Number(process.env.PAPERCUSP_GATEWAY_CONCURRENCY) || undefined,
    upstreamBase: process.env.ANTHROPIC_BASE_URL_UPSTREAM || undefined,
  });
  console.log(`[inference-gateway] up on 127.0.0.1:${svc.port} → account '${svc.account.accountId}' (${svc.account.source})`);

  let stopping = false;
  const shutdown = async (sig: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`[inference-gateway] ${sig} → draining + stopping`);
    await svc.stop().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((e) => {
  console.error('[inference-gateway] fatal:', e);
  process.exit(1);
});
