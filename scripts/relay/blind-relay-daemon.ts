/**
 * Standalone blind-relay daemon for the Papercusp-run relay VM
 * (plan public-blind-relay-2026-10-01, P-001). Runs the same server wiring the
 * operator uses in-process (packages/operator-core/lib/voice-node/blind-relay-core.ts)
 * with the seed read from a file, so the VM needs no Postgres and no operator.
 *
 * Bundled by scripts/relay/build-relay-daemon.mjs into one .mjs with only
 * hyperdht + blind-relay as runtime deps. Logs JSON lines on stdout.
 *
 * usage: node blind-relay-daemon.mjs --seed-file <path> [--port <udp>] [--stats-sec <n>]
 */
import { readFileSync } from 'node:fs';
import { createBlindRelayServer, parseRelaySeedHex } from '../../packages/operator-core/lib/voice-node/blind-relay-core';

export interface DaemonArgs {
  seedFile: string;
  port?: number;
  statsSec: number;
}

export function parseDaemonArgs(argv: readonly string[]): DaemonArgs {
  let seedFile: string | undefined;
  let port: number | undefined;
  let statsSec = 300;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[i + 1];
    if (a === '--seed-file' && v) {
      seedFile = v;
      i++;
    } else if (a === '--port' && v) {
      port = Number(v);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`--port must be 1-65535, got ${v}`);
      i++;
    } else if (a === '--stats-sec' && v) {
      statsSec = Number(v);
      if (!Number.isFinite(statsSec) || statsSec <= 0) throw new Error(`--stats-sec must be > 0, got ${v}`);
      i++;
    } else {
      throw new Error(`unknown or incomplete argument: ${a}`);
    }
  }
  if (!seedFile) throw new Error('--seed-file <path> is required');
  return { seedFile, ...(port !== undefined ? { port } : {}), statsSec };
}

const log = (o: Record<string, unknown>) => console.log(JSON.stringify({ ts: new Date().toISOString(), ...o }));

export async function main(argv: readonly string[]): Promise<void> {
  const args = parseDaemonArgs(argv);
  const seed = parseRelaySeedHex(readFileSync(args.seedFile, 'utf8'));
  const relay = await createBlindRelayServer({ seed, ...(args.port !== undefined ? { port: args.port } : {}) });
  log({ ev: 'listening', publicKey: relay.publicKey, ...relay.address() });

  // A relay that drifts into firewalled:true cannot serve peers behind randomized
  // NATs, so the address is part of every stats line, not only the first.
  const timer = setInterval(() => log({ ev: 'stats', ...relay.address(), stats: relay.stats() }), args.statsSec * 1000);
  const stop = async (signal: string) => {
    clearInterval(timer);
    log({ ev: 'stopping', signal });
    await relay.close().catch((e: unknown) => log({ ev: 'close-error', error: String(e) }));
    process.exit(0);
  };
  process.once('SIGTERM', () => void stop('SIGTERM'));
  process.once('SIGINT', () => void stop('SIGINT'));
}

// The bundle runs off-tree on the relay VM, so it cannot import operator-core's
// isCliEntry; pin our own basename (the sanctioned form for a copied-out entry).
function isDirectCliInvocation(entryPath = process.argv[1]): boolean {
  return typeof entryPath === 'string' && /(?:^|[\\/])blind-relay-daemon\.(?:mjs|ts)$/.test(entryPath);
}
if (isDirectCliInvocation()) {
  main(process.argv.slice(2)).catch((e: unknown) => {
    log({ ev: 'fatal', error: e instanceof Error ? e.message : String(e) });
    process.exit(1);
  });
}
