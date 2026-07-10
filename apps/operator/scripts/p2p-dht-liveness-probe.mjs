#!/usr/bin/env node
/**
 * p2p-dht-liveness-probe.mjs — a real 2-swarm hyperswarm announce/lookup probe
 * against the isolated DHT testnet's bootstrap node (EI-8892).
 *
 * WHY: `papercup-isolated-dht.service` can wedge (unit stays `active`, bootstrap
 * node stops actually accepting/servicing DHT traffic) with ZERO signal — a plain
 * "is the unit active" check cannot see this, and hyperswarm rides UDX/UDP so
 * `ss`/`netstat` show nothing useful either (2026-07-06→07-09: wedged for 3 days,
 * cross-machine federation dead the whole time, caught only by a hand-rolled
 * probe). This is that probe, made durable — design + gotchas from su-4dc3befd's
 * live incident response (msg mre8bpam, 2026-07-09):
 *
 *   - a WEDGED bootstrap still ACCEPTS joins and flush() still completes — the
 *     ONLY reliable health signal is "did the second swarm actually receive a
 *     'connection' event within the timeout". Nothing weaker works (join()
 *     resolving, flush() resolving, and even peer-discovery events can all fire
 *     against a bootstrap that can't actually route traffic).
 *   - hyperswarm is UDX/UDP — do not attempt any socket-level (`ss`/`netstat`)
 *     liveness check; it will show nothing either way.
 *   - always destroy() both swarms in a `finally`, with a hard `process.exit`
 *     backstop — a wedged DHT can hang teardown too, so a plain `await destroy()`
 *     without a timeout can itself hang the probe forever.
 *
 * Usage: node p2p-dht-liveness-probe.mjs --host <ip> --port <port> [--timeout-ms 15000]
 * Exit 0 = healthy (swarm B saw a connection). Exit 1 = probe failed (wedged /
 * unreachable / timed out). Exit 2 = bad usage.
 *
 * Bootstrap host/port should be read from the LIVE unit, never hardcoded here —
 * see the `--host`/`--port` args and the wrapper script that resolves them via
 * `systemctl --user show papercup-isolated-dht.service`.
 */
import Hyperswarm from 'hyperswarm';
import { randomBytes } from 'node:crypto';

function parseArgs(argv) {
  const out = { host: null, port: null, timeoutMs: 15_000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--host') out.host = argv[++i];
    else if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--timeout-ms') out.timeoutMs = Number(argv[++i]);
  }
  return out;
}

async function withHardExit(promise, hardExitMs, exitCode) {
  // A wedged DHT can hang teardown (destroy()) too — never let cleanup itself
  // hang the probe forever. This backstop fires ONLY if the promise doesn't
  // settle in time; it does not affect a normal, fast destroy().
  const timer = setTimeout(() => {
    process.stderr.write(`[p2p-dht-probe] teardown did not complete within ${hardExitMs}ms — hard exit\n`);
    process.exit(exitCode);
  }, hardExitMs);
  timer.unref?.();
  try {
    await promise;
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const { host, port, timeoutMs } = parseArgs(process.argv.slice(2));
  if (!host || !Number.isFinite(port) || port <= 0) {
    process.stderr.write('usage: p2p-dht-liveness-probe.mjs --host <ip> --port <port> [--timeout-ms 15000]\n');
    process.exit(2);
  }
  const bootstrap = [{ host, port }];
  // RANDOM topic per run (never the prod harness topic) — this probe must never
  // be discoverable by / interfere with real hive traffic on the testnet.
  const topic = randomBytes(32);

  const swarmA = new Hyperswarm({ bootstrap });
  const swarmB = new Hyperswarm({ bootstrap });

  let settled = false;
  let connected = false;
  // Every connection socket MUST get its own 'error' listener — an unhandled
  // 'error' event on a Node stream crashes the whole process (this bit the
  // first version: a genuine ECONNRESET after connect looked like a fatal
  // script crash instead of a probe FAIL). A reset AFTER a 'connection' event
  // already fired still counts as a successful probe — the DHT did its job
  // (found + connected the peer); a reset is a transport-layer hiccup on an
  // already-healthy path, not evidence of a wedged bootstrap.
  const result = new Promise((resolve) => {
    swarmA.on('connection', (conn) => conn.on('error', () => {}));
    swarmB.on('connection', (conn) => {
      conn.on('error', () => {});
      connected = true;
      if (!settled) {
        settled = true;
        resolve(true);
      }
    });
    setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(false);
      }
    }, timeoutMs);
  });

  try {
    // Sequenced per the hyperswarm README's exact pattern — do NOT parallelize
    // this: the server must be fully announced (discovery.flushed()) BEFORE the
    // client joins, and the client uses swarm.flush() (not discovery.flushed(),
    // which has different — and here, hanging — semantics on the client side).
    const discA = swarmA.join(topic, { server: true, client: false });
    await discA.flushed();
    swarmB.join(topic, { server: false, client: true });
    await swarmB.flush();

    connected = await result;
  } catch (err) {
    process.stderr.write(`[p2p-dht-probe] error during probe: ${err instanceof Error ? err.stack || err.message : String(err)}\n`);
    connected = false;
  } finally {
    // 5s teardown budget, then hard-exit rather than hang forever on a wedged DHT.
    await withHardExit(Promise.allSettled([swarmA.destroy(), swarmB.destroy()]), 5_000, connected ? 0 : 1);
  }

  if (connected) {
    process.stdout.write(`[p2p-dht-probe] OK — bootstrap ${host}:${port} healthy (connection established within ${timeoutMs}ms)\n`);
    process.exit(0);
  } else {
    process.stdout.write(`[p2p-dht-probe] FAIL — bootstrap ${host}:${port} did not establish a connection within ${timeoutMs}ms (wedged or unreachable)\n`);
    process.exit(1);
  }
}

main().catch((err) => {
  process.stderr.write(`[p2p-dht-probe] fatal: ${err instanceof Error ? err.stack || err.message : String(err)}\n`);
  process.exit(1);
});
