#!/usr/bin/env node
/**
 * git-ext-bridge.mjs — the `ext::` transport helper for hive-git fetch (Phase 7
 * G-2, cross-machine-coord-parity-and-trust-2026-07-01 / P-026).
 *
 * `git fetch "ext::node <this> <sockPath>" …` spawns THIS process as the
 * connection command: git speaks the pkt-line protocol on our stdin/stdout. We
 * are pure plumbing — cross-pipe that stdio to a Unix-domain socket the PARENT
 * (fetchOverDuplex) is listening on, and the parent bridges that socket to the
 * peer's per-fetch Protomux stream. No git logic here; upload-pack runs on the
 * peer.
 *
 * Kept as a standalone .mjs (not bundled TS) precisely because git execs it as
 * an external command — it must be a runnable node script on disk. Everything is
 * best-effort/quiet: a broken pipe just ends the fetch.
 */
import net from 'node:net';

const sockPath = process.argv[2];
if (!sockPath) {
  process.stderr.write('git-ext-bridge: missing socket path arg\n');
  process.exit(2);
}

const sock = net.connect(sockPath);
sock.on('error', (e) => {
  process.stderr.write(`git-ext-bridge: socket error: ${e && e.message ? e.message : e}\n`);
  process.exit(1);
});
// Swallow EPIPE on our std streams (the far end can hang up first).
process.stdin.on('error', () => {});
process.stdout.on('error', () => {});

// git → us (stdin) → peer (socket); peer (socket) → us (stdout) → git.
process.stdin.pipe(sock);
sock.pipe(process.stdout);

// Propagate half-close both ways so pack negotiation terminates cleanly.
process.stdin.on('end', () => sock.end());
sock.on('end', () => {
  try {
    process.stdout.end();
  } catch {
    /* already closed */
  }
});
sock.on('close', () => process.exit(0));
