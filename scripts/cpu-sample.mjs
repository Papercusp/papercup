#!/usr/bin/env node
// Attach to a running node process's inspector (opened via SIGUSR1), run the V8
// CPU profiler for a window, and print the top self-time call-sites. Companion to
// leak-sample.mjs (heap allocation) — this one is for CPU/event-loop attribution.
// Mirrors the manual method in the agent-insight
// "attributing-loop-saturation-via-cpuprofiles": subtracts the profiler's own
// observer-effect (node:inspector / (idle) / (program) frames) before ranking.
//
// Usage: node scripts/cpu-sample.mjs <pid> [durationMs] [inspectorPort] [--save <path>]
import { setTimeout as sleep } from 'node:timers/promises';
import { readFileSync, readdirSync, readlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  closeInspector,
  createCdpClient,
  discoverInspector,
  redactDiagnosticUrl,
} from './cdp-inspector.mjs';
import { aggregateCpuProfile } from './lib/cpu-profile.mjs';
import { listProcesses, parseArgv } from './proc-guard.mjs';

// Startup may not yet service Runtime.evaluate. On Linux, bind the loopback
// listener to its owning process and exact OS argv instead; never trust a port
// or matching filename alone. The start tick also detects PID reuse.
export function readInspectorProcessIdentity({ pid, port, expectedEntry, expectedArg }) {
  const inodes = new Set();
  const loopback = new Set(['0100007F', '00000000',
    '00000000000000000000000000000000', '0000000000000000FFFF00000100007F']);
  for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text;
    try { text = readFileSync(table, 'utf8'); } catch { continue; }
    for (const line of text.split('\n').slice(1)) {
      const fields = line.trim().split(/\s+/);
      const [address, hexPort] = (fields[1] ?? '').split(':');
      if (fields[3] === '0A' && Number.parseInt(hexPort, 16) === port
          && loopback.has(address) && fields[9] && fields[9] !== '0') inodes.add(fields[9]);
    }
  }
  if (inodes.size !== 1) throw new Error('inspector target identity mismatch: listener ownership unavailable or ambiguous');
  const [listenerInode] = inodes;
  const candidates = pid ? [{ pid }] : listProcesses().map(row => ({ pid: row.pid }));
  const matches = [];
  for (const candidate of candidates) {
    try {
      const root = '/proc/' + candidate.pid;
      const argv = parseArgv(readFileSync(root + '/cmdline'));
      const entryIndex = argv.indexOf(expectedEntry);
      if (entryIndex < 1 || argv.lastIndexOf(expectedEntry) !== entryIndex
          || (expectedArg && !argv.slice(entryIndex + 1).includes(expectedArg))) continue;
      if (!readdirSync(root + '/fd').some(fd => {
        try { return readlinkSync(root + '/fd/' + fd) === 'socket:[' + listenerInode + ']'; }
        catch { return false; }
      })) continue;
      const stat = readFileSync(root + '/stat', 'utf8');
      const startTicks = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)[19];
      if (!/^\d+$/.test(startTicks ?? '')) continue;
      matches.push({ pid: candidate.pid, entry: expectedEntry, argv: argv.slice(entryIndex + 1),
        startTicks, listenerInode, identity: 'proc' });
    } catch { /* Exited or unreadable processes cannot supply identity proof. */ }
  }
  if (matches.length !== 1) throw new Error('inspector target identity mismatch: exact process does not own listener');
  return matches[0];
}

/**
 * Collect before a startup probe's deadline kills its child. --cpu-prof alone
 * writes at normal exit and loses the profile on spawnSync's default SIGTERM.
 * Existing-inspector mode pins one port and checks entry/arguments before sampling;
 * it disconnects its own socket without closing the target's pre-opened inspector.
 * @param {{ pid: number, durationMs?: number, startPort?: number, attachExisting?: boolean,
 *   expectedEntry?: string, expectedArg?: string, deadlineMs?: number, procIdentity?: boolean }} options
 */
export async function captureCpuProfile({ pid, durationMs = 30000, startPort = 9229,
  attachExisting = false, expectedEntry, expectedArg, deadlineMs = 50000, procIdentity = false }) {
  if (!Number.isInteger(pid) || pid < 0 || (!attachExisting && pid === 0))
    throw new TypeError('a positive target pid is required unless attaching by exact entry');
  if (!Number.isInteger(durationMs) || durationMs <= 0 || !Number.isInteger(deadlineMs) || deadlineMs <= 5000)
    throw new TypeError('positive duration and a deadline above 5000ms are required');
  if (!Number.isInteger(startPort) || startPort < 1 || startPort > 65535)
    throw new TypeError('invalid inspector port');
  if (attachExisting && (typeof expectedEntry !== 'string' || !expectedEntry))
    throw new TypeError('existing inspector capture requires an exact expected entry');
  if (procIdentity && (!attachExisting || process.platform !== 'linux' || !isAbsolute(expectedEntry ?? '')))
    throw new TypeError('proc identity requires an existing Linux inspector and absolute expected entry');

  const deadline = Date.now() + deadlineMs;
  if (!attachExisting) {
    process.kill(pid, 'SIGUSR1');
    await sleep(1200);
  }
  let inspector;
  const discoveryDeadline = Math.min(deadline - 5000, Date.now() + 10000);
  do {
    inspector = await discoverInspector({ startPort, portCount: attachExisting ? 1 : 6,
      requestTimeoutMs: 500 });
    if (inspector) break;
    await sleep(100);
  } while (Date.now() < discoveryDeadline);
  if (!inspector) throw new Error('could not find inspector within the capture deadline');

  let target;
  if (procIdentity) {
    const endpoint = new URL(inspector.wsUrl);
    if (endpoint.protocol !== 'ws:' || endpoint.hostname !== '127.0.0.1' || Number(endpoint.port) !== inspector.port)
      throw new Error('inspector target identity mismatch: nonlocal endpoint');
    target = readInspectorProcessIdentity({ pid, port: inspector.port, expectedEntry, expectedArg });
  }

  const client = createCdpClient(inspector.wsUrl, {
    requestTimeoutMs: 2000,
    webSocketOptions: { handshakeTimeout: 2000, maxPayload: 64 * 1024 * 1024 },
  });
  try {
    await client.connect();
    // --inspect starts listening before Node has initialized process.argv.
    // Wait for that measured startup boundary before comparing the identity.
    if (!procIdentity) {
      const identityDeadline = Math.min(deadline - 5000, Date.now() + 5000);
      do {
        const evaluated = await client.evaluate('({pid:process.pid, entry:process.argv?.[1], argv:process.argv?.slice(2)})',
          { returnByValue: true });
        target = evaluated.result?.value;
        if (typeof target?.entry === 'string') break;
        await sleep(100);
      } while (Date.now() < identityDeadline);
    }
    if (!Number.isInteger(target?.pid) || (pid && target.pid !== pid)
        || (expectedEntry && target.entry !== expectedEntry)
        || (expectedArg && !target.argv?.includes(expectedArg)))
      throw new Error('inspector target identity mismatch');
    await client.send('Profiler.enable');
    await client.send('Profiler.setSamplingInterval', { interval: attachExisting ? 1000 : 200 });
    await client.send('Profiler.start');
    const captureMs = Math.min(durationMs, deadline - Date.now() - 5000);
    if (captureMs <= 0) throw new Error('no capture window remains before the deadline');
    await sleep(captureMs);
    const { profile } = await client.send('Profiler.stop');
    if (!profile?.nodes?.length || !profile.samples?.length)
      throw new Error('inspector returned an empty CPU profile');
    if (procIdentity) {
      const after = readInspectorProcessIdentity({ pid: target.pid, port: inspector.port, expectedEntry, expectedArg });
      if (after.startTicks !== target.startTicks || after.listenerInode !== target.listenerInode)
        throw new Error('inspector target identity mismatch: process changed during capture');
    }
    return { profile, target, captureMs, inspector: redactDiagnosticUrl(inspector.wsUrl) };
  } finally {
    if (attachExisting) client.close();
    else await closeInspector(client, inspector.port);
  }
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    save: { type: 'string' }, 'attach-existing': { type: 'boolean' },
    'expect-entry': { type: 'string' }, 'expect-arg': { type: 'string' },
    'proc-identity': { type: 'boolean' },
  } });
  const pid = Number(positionals[0]);
  const durationMs = Number(positionals[1] || 30000);
  const startPort = Number(positionals[2] || 9229);
  const { profile, captureMs, target } = await captureCpuProfile({ pid, durationMs, startPort,
    attachExisting: values['attach-existing'] ?? false,
    expectedEntry: values['expect-entry'], expectedArg: values['expect-arg'],
    procIdentity: values['proc-identity'] ?? false,
    deadlineMs: values['attach-existing'] ? 50000 : durationMs + 20000 });
  if (values.save) {
    writeFileSync(values.save, JSON.stringify(profile));
    console.error(`saved raw profile to ${values.save}`);
  }
  console.error(JSON.stringify({ target, captureMs }));
  const { totalUs, excludedUs, realUs, frames } = aggregateCpuProfile(profile);
  const excludedPct = totalUs ? ((excludedUs / totalUs) * 100).toFixed(1) : '0.0';
  console.log(`\n=== TOP CPU SELF-TIME (sampled ${(captureMs / 1000).toFixed(1)}s, total ${(totalUs / 1e6).toFixed(1)}s, observer/non-work excluded ${(excludedUs / 1e6).toFixed(1)}s [${excludedPct}%], real workload ${(realUs / 1e6).toFixed(1)}s) ===`);
  for (const [site, us] of frames.slice(0, 30)) {
    const seconds = (us / 1e6).toFixed(2);
    const pct = ((us / (realUs || 1)) * 100).toFixed(1);
    console.log(`${seconds.padStart(7)}s  ${pct.padStart(5)}%  ${site}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
