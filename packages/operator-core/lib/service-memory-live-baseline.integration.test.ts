/** P-011 live baseline. Reuses the maintained counter reader; no profiler or GC.
 * This observes the staging service's main process and ambient workload, not a
 * paired intervention or a census of every HTTP worker/retained-memory owner.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readlinkSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { closeInspector, createCdpClient, readPinnedState, readProcessMemory } from '../../../scripts/cdp-inspector.mjs';
import { serializeIdentitySafeJson } from '../../../scripts/lib/identity-leak-patterns.mjs';

const root = resolve(__dirname, '../../..');
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const executableHashes = new Map<string, string>();
function processSample(pid: number) {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  const rollup = readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8');
  const bytes = (name: string) => {
    const match = rollup.match(new RegExp(`^${name}:\\s+(\\d+) kB$`, 'm'));
    if (!match) throw Error(`Missing ${name} for ${pid}`);
    return Number(match[1]) * 1024;
  };
  const executable = readlinkSync(`/proc/${pid}/exe`);
  const metadata = statSync(`/proc/${pid}/exe`);
  const key = `${executable}:${metadata.dev}:${metadata.ino}:${metadata.size}:${metadata.mtimeMs}`;
  if (!executableHashes.has(key)) executableHashes.set(key, hash(readFileSync(`/proc/${pid}/exe`)));
  return { pid, startTicks: fields[19], parentPid: Number(fields[1]), executable,
    executableSha256: executableHashes.get(key)!,
    pssBytes: bytes('Pss'), rssBytes: bytes('Rss'), anonymousBytes: bytes('Anonymous') };
}

function assertIdentity(before: { pid: number; startTicks: string; executableSha256: string }, after: typeof before) {
  if (before.pid !== after.pid || before.startTicks !== after.startTicks ||
      before.executableSha256 !== after.executableSha256) throw Error('Serving process identity changed');
}

function listenerPorts(pid: number) {
  const inodes = new Set(readdirSync(`/proc/${pid}/fd`).flatMap(fd => {
    try { return [readlinkSync(`/proc/${pid}/fd/${fd}`).match(/^socket:\[(\d+)\]$/)?.[1]]; }
    catch { return []; }
  }).filter(Boolean));
  return [...new Set(['tcp', 'tcp6'].flatMap(kind =>
    readFileSync(`/proc/${pid}/net/${kind}`, 'utf8').trim().split('\n').slice(1).flatMap(line => {
      const fields = line.trim().split(/\s+/);
      return fields[3] === '0A' && inodes.has(fields[9]) ? [parseInt(fields[1].split(':').at(-1)!, 16)] : [];
    })))];
}

describe('actual current-build operator memory baseline', () => {
  it('rejects PID reuse and changed executable before accepting a resource comparison', () => {
    const before = { pid: 7, startTicks: '12', executableSha256: 'a' };
    expect(() => assertIdentity(before, { ...before, startTicks: '13' })).toThrow('identity changed');
    expect(() => assertIdentity(before, { ...before, executableSha256: 'b' })).toThrow('identity changed');
  });

  it.runIf(Boolean(process.env.PAPERCUSP_P011_LIVE_PID))('measures unforced live idle and ordinary HTTP windows on the named staging process', async () => {
    const pid = Number(process.env.PAPERCUSP_P011_LIVE_PID);
    const base = process.env.PAPERCUSP_P011_LIVE_URL;
    const expectedBuild = process.env.PAPERCUSP_P011_LIVE_BUILD;
    const destination = process.env.PAPERCUSP_P011_REPORT;
    const pinnedOwners = process.env.PAPERCUSP_P011_PINNED_OWNERS
      ? JSON.parse(process.env.PAPERCUSP_P011_PINNED_OWNERS) : undefined;
    if (pinnedOwners !== undefined && (!Array.isArray(pinnedOwners) || pinnedOwners.length < 1 ||
        pinnedOwners.some(owner => typeof owner !== 'string'))) throw Error('Exact pinned owners must be a nonempty string array');
    expect(Number.isInteger(pid) && pid > 0).toBe(true);
    expect(base).toBe('http://127.0.0.1:3170');
    expect(expectedBuild).toMatch(/^[a-f0-9]{7,40}$/);
    if (!destination || !existsSync(dirname(resolve(root, destination)))) throw Error('Canonical evidence parent required');
    const path = resolve(root, destination);
    const before = processSample(pid);
    const report: any = { schemaVersion: 1, plane: 'live-current-build-operator-api',
      incomplete: true, pid, buildSha: expectedBuild, startedAt: new Date().toISOString(),
      samples: [], windows: [], requests: [], operations: [], cleanup: {},
      metricDefinitions: { pssBytes: 'smaps_rollup Pss kernel kB times 1024',
        heapAndNative: 'V8/Node counters, overlapping with PSS; no additive native-residual estimate',
        pinnedState: 'Reachable logical payloads under named roots; not total retained heap/native bytes',
        observerMs: 'wall time for inspector counter read and proc descendant census' },
      limits: { windows: 3, idleMs: 2000, requestsPerWindow: 8, concurrency: 2, descendantsPerSample: 64 },
      pinnedOwners,
      limitations: ['Main service PID only; HTTP requests may be served by sibling workers.',
        'Ambient workload is uncontrolled; idle means no probe HTTP requests.',
        'No paired intervention, allocation profiler, retainer graph or physical-savings claim.',
        'Current disk bundle hash is recorded separately from the health-reported loaded build.'] };
    const publish = () => writeFileSync(path, serializeIdentitySafeJson(report));
    let client: ReturnType<typeof createCdpClient> | undefined;
    let port: number | undefined;
    let opened = false;
    const health = async () => {
      const response = await fetch(base + '/api/health', { signal: AbortSignal.timeout(10000) });
      expect(response.status).toBe(200);
      const value = await response.json();
      expect(value.sha).toBe(expectedBuild);
      expect(value.bundleStale).toBeUndefined();
      assertIdentity(before, processSample(pid));
      return { sha: value.sha, version: value.version, at: new Date().toISOString() };
    };
    const attach = async () => {
      for (const candidate of listenerPorts(pid).filter(value => value !== 3170)) {
        try {
          const response = await fetch(`http://127.0.0.1:${candidate}/json/list`, { signal: AbortSignal.timeout(500) });
          if (!response.ok) continue;
          const targets = await response.json();
          const target = targets.find((row: any) => row.type === 'node' && row.webSocketDebuggerUrl);
          if (!target) continue;
          const connection = createCdpClient(target.webSocketDebuggerUrl);
          try { await connection.connect(); await readProcessMemory(connection, { expectedPid: pid }); }
          catch (error) { connection.close(); throw error; }
          client = connection; port = candidate; return true;
        } catch { /* An unrelated listener is not an inspector. */ }
      }
      return false;
    };
    publish();
    try {
      report.healthBefore = await health();
      expect(listenerPorts(pid)).toContain(3170);
      const argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
      const entry = argv.find(value => value.endsWith('/hono-host.mjs'));
      if (!entry) throw Error('Serving bundle entry unobserved');
      const bundlePath = resolve(readlinkSync(`/proc/${pid}/cwd`), entry);
      report.bundle = { path: bundlePath, argvEntry: entry, diskSha256: hash(readFileSync(bundlePath)) };
      report.inspectorWasOpen = await attach();
      if (!client) {
        process.kill(pid, 'SIGUSR1'); opened = true;
        for (let attempt = 0; attempt < 20 && !client; attempt++) { await wait(250); await attach(); }
      }
      if (!client || !port) throw Error('PID-bound inspector unavailable');
      report.inspector = { pid, port, openedByProbe: opened };
      let remainingDescendants = 64;
      const descendants = (parent: number): ReturnType<typeof processSample>[] => {
        const children = readFileSync(`/proc/${parent}/task/${parent}/children`, 'utf8').trim();
        return (children ? children.split(/\s+/).map(Number) : []).flatMap(child => {
          if (remainingDescendants <= 0) { report.descendantCappedSamples = (report.descendantCappedSamples || 0) + 1; return []; }
          remainingDescendants--;
          try { return [processSample(child), ...descendants(child)]; }
          catch { report.descendantExitRaces = (report.descendantExitRaces || 0) + 1; return []; }
        });
      };
      const sample = async (label: string) => {
        const started = performance.now();
        const memory = await readProcessMemory(client!, { expectedPid: pid });
        const pinnedState = process.env.PAPERCUSP_P011_PINNED_STATE ? await readPinnedState(client!, {
          expectedPid: pid, owners: pinnedOwners,
        }) : undefined;
        const os = processSample(pid); assertIdentity(before, os);
        remainingDescendants = 64;
        report.samples.push({ label, at: new Date().toISOString(), ...memory, os, pinnedState,
          descendants: descendants(pid), observerMs: performance.now() - started }); publish();
      };
      const query = '/api/zero-harness/rest-query?name=workItems.byHarness&args=' +
        encodeURIComponent(JSON.stringify({ harnessSlug: 'papercusp', limit: 32 }));
      for (let window = 0; window < 3; window++) {
        await sample(`idle-${window}-start`); await wait(2000); await sample(`idle-${window}-end`);
        const startedAt = new Date().toISOString();
        for (let pair = 0; pair < 4; pair++) await Promise.all([0, 1].map(async index => {
          const started = performance.now();
          const response = await fetch(base + query, { headers: { 'x-papercusp-workspace': 'papercusp-workspace' },
            signal: AbortSignal.timeout(15000) });
          const bytes = Buffer.from(await response.arrayBuffer());
          expect(response.status).toBe(200);
          const body = JSON.parse(bytes.toString());
          expect(Array.isArray(body.rows)).toBe(true); expect(body.rows.length).toBeLessThanOrEqual(32);
          report.requests.push({ window, pair, index, status: response.status, rows: body.rows.length,
            responseBytes: bytes.length, responseSha256: hash(bytes), elapsedMs: performance.now() - started });
        }));
        await sample(`ordinary-${window}-end`);
        report.windows.push({ window, startedAt, endedAt: new Date().toISOString() }); publish();
        await health();
      }
      report.healthAfter = await health();
      report.bundle.diskSha256After = hash(readFileSync(bundlePath));
      expect(report.bundle.diskSha256After).toBe(report.bundle.diskSha256);
      expect(report.samples).toHaveLength(9); expect(report.requests).toHaveLength(24);
      expect(report.samples.every((row: any) => row.os.pssBytes > 0 && row.memory.heapUsed > 0)).toBe(true);
      if (process.env.PAPERCUSP_P011_PINNED_STATE) expect(report.samples.every((row: any) =>
        row.pinnedState.pid === pid && row.pinnedState.registryPresent &&
        row.pinnedState.population >= row.pinnedState.checked && row.pinnedState.checked > 0)).toBe(true);
      if (pinnedOwners) expect(report.samples.every((row: any) =>
        row.pinnedState.selection?.missingOwners.length === 0 &&
        row.pinnedState.selection?.selectedNotChecked === 0 &&
        row.pinnedState.checked === pinnedOwners.length)).toBe(true);
      report.incomplete = false;
    } catch (error) { report.error = error instanceof Error ? error.message : String(error); throw error; }
    finally {
      try {
        if (client && opened && port) report.cleanup.inspector = await closeInspector(client, port);
        else { client?.close(); report.cleanup.inspector = { preservedPreexisting: true }; }
        assertIdentity(before, processSample(pid)); report.cleanup.processIdentityPreserved = true;
      } catch (error) { report.cleanup.error = String(error); report.incomplete = true; throw error; }
      finally { report.endedAt = new Date().toISOString(); publish(); }
    }
    expect(report.cleanup.processIdentityPreserved).toBe(true);
    expect(report.operations).toEqual([]);
  }, 100_000);
});
