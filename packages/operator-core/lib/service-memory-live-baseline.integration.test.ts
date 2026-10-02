/** P-011 live baseline. Reuses the maintained counter reader; no profiler or GC.
 * This observes the staging service's main process and ambient workload, not a
 * paired intervention or a census of every HTTP worker/retained-memory owner.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readlinkSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { closeInspector, createCdpClient, readPinnedState, readProcessMemory, validatePinnedStateOptions } from '../../../scripts/cdp-inspector.mjs';
import { serializeIdentitySafeJson } from '../../../scripts/lib/identity-leak-patterns.mjs';
import { requestOnlyHost } from './background-workers';

const root = resolve(__dirname, '../../..');
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const executableHashes = new Map<string, string>();
type PinnedLimits = Omit<Parameters<typeof readPinnedState>[1], 'expectedPid' | 'owners' | 'operatorCacheEntries'>;
function parsePinnedLimits(raw?: string): PinnedLimits | undefined {
  if (!raw) return undefined;
  const value = JSON.parse(raw);
  const allowed = ['maxSlots', 'maxObjects', 'maxEntries', 'maxFields', 'maxDepth', 'budgetMs',
    'maxCacheEntries', 'maxEntryEntries', 'maxEntryObjects', 'maxKeyCodeUnits', 'cacheEntryOffset', 'cacheKeyDigests'];
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !allowed.includes(key) ||
        (key === 'cacheKeyDigests' ? !Array.isArray(value[key]) || value[key].length < 1 ||
          value[key].some((digest: unknown) => typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) :
          !Number.isInteger(value[key]) || value[key] < (key === 'cacheEntryOffset' ? 0 : 1)))) {
    throw Error('Pinned limits must contain only positive integer reader limits');
  }
  // Reuse the reader's exact bounds before acquiring/opening a target inspector.
  // Selection is structurally checked here; the caller's actual opt-in is checked
  // with the full options below before any process observation.
  validatePinnedStateOptions({ ...value, expectedPid: 1, operatorCacheEntries: true });
  return value;
}
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
  const argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
  const command = processCommand(argv, readlinkSync(`/proc/${pid}/cwd`), executable);
  const key = `${executable}:${metadata.dev}:${metadata.ino}:${metadata.size}:${metadata.mtimeMs}`;
  if (!executableHashes.has(key)) executableHashes.set(key, hash(readFileSync(`/proc/${pid}/exe`)));
  const afterStat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  const after = afterStat.slice(afterStat.lastIndexOf(')') + 2).split(' ');
  const afterExe = statSync(`/proc/${pid}/exe`);
  if (after[19] !== fields[19] || after[1] !== fields[1] ||
      afterExe.dev !== metadata.dev || afterExe.ino !== metadata.ino) {
    throw Error('Process changed during resource sample');
  }
  return { pid, startTicks: fields[19], parentPid: Number(fields[1]), executable,
    executableSha256: executableHashes.get(key)!,
    command,
    pssBytes: bytes('Pss'), rssBytes: bytes('Rss'), anonymousBytes: bytes('Anonymous') };
}

// Parse only the executable entry, not an argument which happens to name the
// host. Unknown option forms fail closed. Never persist arbitrary argv/env.
function nodeEntry(argv: string[], cwd: string): string | null {
  const takesValue = new Set(['-r', '--require', '--import', '--loader', '--experimental-loader',
    '--conditions', '--title', '--inspect-port']);
  const switches = /^(?:--inspect(?:-brk)?(?:=.*)?|--enable-source-maps|--no-warnings|--expose-gc|--max-old-space-size=\d+)$/;
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') return argv[i + 1] ? resolve(cwd, argv[i + 1]) : null;
    if (takesValue.has(arg)) { if (!argv[++i]) return null; continue; }
    if (switches.test(arg) || /^(?:--require|--import|--loader|--conditions|--title|--inspect-port)=/.test(arg)) continue;
    if (arg.startsWith('-')) return null;
    return resolve(cwd, arg);
  }
  return null;
}

function processCommand(argv: string[], cwd: string, executable: string) {
  return { sha256: hash(argv.join('\0')), script: nodeEntry(argv, cwd),
    esbuildService: executable.endsWith('/esbuild') &&
      argv.slice(1).some(arg => /^--service=\d+\.\d+\.\d+$/.test(arg)) };
}

type ResourceRow = ReturnType<typeof processSample>;
function descendantEntryRole(main: ResourceRow, row: ResourceRow) {
  const entry = main.command.script;
  if (!entry?.endsWith('/hono-host.mjs') || row.executableSha256 !== main.executableSha256) return 'other-descendant';
  if (row.command.script === entry) return 'same-entry-operator-descendant';
  // The production resolver opts only the spawner into this exact sibling.
  // A similarly named file elsewhere is not an identified serving artifact.
  if (row.command.script === join(dirname(entry), 'spawner-sidecar.mjs')) return 'maintained-spawner-descendant';
  return 'other-descendant';
}

function processInventory(main: ResourceRow, children: ResourceRow[],
  missed: { pid: number; parentPid: number; reason: string }[], previous: ResourceRow[] = []) {
  const rows = [main, ...children];
  const byPid = new Map(rows.map(row => [row.pid, row]));
  if (byPid.size !== rows.length) throw Error('Duplicate process identity in census');
  for (const child of children) {
    const seen = new Set([child.pid]);
    let parent = child.parentPid;
    while (parent !== main.pid) {
      if (seen.has(parent) || !byPid.has(parent)) throw Error('Unverified descendant ancestry');
      seen.add(parent); parent = byPid.get(parent)!.parentPid;
    }
  }
  const identities = new Set(rows.map(row => `${row.pid}:${row.startTicks}:${row.executableSha256}`));
  const priorIdentities = new Set(previous.map(row => `${row.pid}:${row.startTicks}:${row.executableSha256}`));
  const classified = rows.map(row => ({ pid: row.pid, startTicks: row.startTicks,
    executableSha256: row.executableSha256,
    role: row.pid === main.pid ? 'named-main' : row.command.esbuildService ? 'native-esbuild-service' :
      descendantEntryRole(main, row),
    pssBytes: row.pssBytes }));
  return { observed: classified, notChecked: missed,
    censusComplete: missed.length === 0,
    observedPssBytes: rows.reduce((sum, row) => sum + row.pssBytes, 0),
    appeared: rows.filter(row => !priorIdentities.has(`${row.pid}:${row.startTicks}:${row.executableSha256}`))
      .map(row => ({ pid: row.pid, startTicks: row.startTicks })),
    notObservedSincePrevious: previous.filter(row => !identities.has(`${row.pid}:${row.startTicks}:${row.executableSha256}`))
      .map(row => ({ pid: row.pid, startTicks: row.startTicks })),
    definition: 'Serial PSS observations of the named process and bounded descendant tree; not cgroup memory or an atomic service total.',
    allocationOwner: 'unknown',
    compilerCaller: 'unknown',
    workerRequestAssignment: 'unknown',
    lifetimeDefinition: 'Not observed is not proof of exit. Roles identify executable/entry only, not retained allocation owners or HTTP routing.' };
}

function assertIdentity(before: { pid: number; startTicks: string; executableSha256: string }, after: typeof before) {
  if (before.pid !== after.pid || before.startTicks !== after.startTicks ||
      before.executableSha256 !== after.executableSha256) throw Error('Serving process identity changed');
}

function counterTarget(main: ResourceRow, rows: ResourceRow[], pid: number) {
  const inventory = processInventory(main, rows, []);
  const target = pid === main.pid ? main : rows.find(row => row.pid === pid);
  const role = inventory.observed.find(row => row.pid === pid)?.role;
  if (!target || (pid !== main.pid && role !== 'same-entry-operator-descendant' &&
      role !== 'maintained-spawner-descendant')) throw Error('Counter target must be the main or exact maintained descendant');
  return target;
}

function assertCounterRole(main: ResourceRow, target: ResourceRow, facts: any) {
  const role = configuredHostRole(facts);
  if (target.pid !== main.pid && descendantEntryRole(main, target) === 'maintained-spawner-descendant' &&
      role.configuredSidecar !== 'spawner') throw Error('Maintained spawner entry did not report the configured spawner role');
  return role;
}

function configuredHostRole(facts: any) {
  if (!facts || typeof facts.cluster?.isPrimary !== 'boolean' ||
      typeof facts.cluster?.isWorker !== 'boolean' || facts.cluster.isPrimary === facts.cluster.isWorker ||
      !['unset', 'disabled', 'enabled'].includes(facts.backgroundWorkersOverride) ||
      typeof facts.stagingPort !== 'boolean' ||
      ['substrate', 'spawner', 'gateway', 'embed', 'resourceHealth'].some(key => typeof facts.sidecarFlags?.[key] !== 'boolean')) {
    throw Error('Incomplete host configuration facts');
  }
  const requestOnly = requestOnlyHost({
    PAPERCUSP_BACKGROUND_WORKERS: facts.backgroundWorkersOverride === 'unset' ? undefined :
      facts.backgroundWorkersOverride === 'disabled' ? '0' : '1',
    PAPERCUSP_HONO_PORT: facts.stagingPort ? '3170' : undefined,
  });
  // Priority is the observed hono-host entry's boot divert, not inferred from
  // argv, port inheritance or the presence of another host in its ancestry.
  const sidecar = ['substrate', 'spawner', 'gateway', 'embed', 'resourceHealth']
    .find(key => facts.sidecarFlags[key]);
  return { clusterRole: facts.cluster.isWorker ? 'worker' : 'primary',
    requestOnly, configuredSidecar: sidecar ?? null,
    requestAssignment: 'unknown', allocationOwner: 'unknown' };
}

function parseDiscoveryNamespace(raw?: string, limits?: PinnedLimits): string | undefined {
  if (raw === undefined) return undefined;
  if (raw.length > 120 || raw.startsWith('jev-memory:') || !/^[a-z][a-z0-9_.-]*:[a-z][a-z0-9_.-]*$/.test(raw) ||
      limits?.cacheKeyDigests !== undefined || (limits?.cacheEntryOffset ?? 0) !== 0) {
    throw Error('Cache discovery requires one exact tool namespace and no prior selection');
  }
  return raw;
}

function selectDiscoveredDigests(pages: any[], namespace: string): string[] {
  if (pages.length < 1 || pages.length > 2 || pages.some(page => page.status !== 'map' ||
      page.selection.selectedNotChecked !== 0 || page.undigestibleKeys !== 0) ||
      pages.at(-1).selection.nextOffset !== null) throw Error('Incomplete bounded cache discovery');
  const candidates = new Map<string, number>();
  for (const page of pages) for (const value of page.values) {
    if (value.toolNamespace !== namespace) continue;
    if (!/^[a-f0-9]{64}$/.test(value.keyDigest)) throw Error('Undigestible cache discovery candidate');
    candidates.set(value.keyDigest, Math.max(candidates.get(value.keyDigest) ?? 0, value.stringCodeUnits));
  }
  // This ranks visited logical strings, including partially traversed values.
  // It neither ranks physical memory nor proves a single atomic cache census.
  const selected = [...candidates].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 2).map(([key]) => key);
  if (selected.length === 0) throw Error('No matching current cache discovery values');
  return selected;
}

function assertCacheSelection(cache: any, digests: string[]) {
  if (cache.status !== 'map' || cache.checked !== digests.length ||
      cache.selection.selectedNotChecked !== 0 || cache.selection.unresolvedKeyDigests.length !== 0 ||
      new Set(cache.values.map((value: any) => value.keyDigest)).size !== digests.length ||
      cache.values.some((value: any) => !digests.includes(value.keyDigest))) {
    throw Error('Current cache digest selection did not match exactly');
  }
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
  it('keeps PID and exact owner selection outside configurable traversal limits', () => {
    expect(parsePinnedLimits('{"maxDepth":8,"maxEntries":32768,"budgetMs":200}'))
      .toEqual({ maxDepth: 8, maxEntries: 32768, budgetMs: 200 });
    expect(parsePinnedLimits('{"cacheEntryOffset":0,"cacheKeyDigests":["' + 'a'.repeat(64) + '"]}'))
      .toEqual({ cacheEntryOffset: 0, cacheKeyDigests: ['a'.repeat(64)] });
    for (const raw of ['{"expectedPid":7}', '{"owners":["other"]}', '[]', 'null',
      '{"operatorCacheEntries":true}', '{"maxDepth":0}', '{"budgetMs":"200"}',
      '{"cacheEntryOffset":-1}', '{"cacheKeyDigests":["private-key"]}']) {
      expect(() => parsePinnedLimits(raw)).toThrow('only positive integer reader limits');
    }
  });

  it('rejects reader caps and incompatible selection in preflight before any target interaction', () => {
    const caps = { maxSlots: 512, maxObjects: 16384, maxEntries: 32768, maxFields: 64,
      maxDepth: 8, budgetMs: 200, maxCacheEntries: 256, maxEntryEntries: 32768,
      maxEntryObjects: 16384, maxKeyCodeUnits: 65536, cacheEntryOffset: 32768 };
    for (const [name, cap] of Object.entries(caps)) {
      expect(() => parsePinnedLimits(JSON.stringify({ [name]: cap }))).not.toThrow();
      expect(() => parsePinnedLimits(JSON.stringify({ [name]: cap + 1 }))).toThrow('invalid pinned-state');
    }
    expect(() => parsePinnedLimits(JSON.stringify({ maxFields: 256 }))).toThrow('invalid pinned-state');
    expect(() => validatePinnedStateOptions({ expectedPid: 7, cacheEntryOffset: 1 })).toThrow('invalid pinned-state');
    expect(() => parsePinnedLimits(JSON.stringify({ cacheKeyDigests: ['a'.repeat(64)], cacheEntryOffset: 1 })))
      .toThrow('invalid pinned-state');
  });

  it('rejects PID reuse and changed executable before accepting a resource comparison', () => {
    const before = { pid: 7, startTicks: '12', executableSha256: 'a' };
    expect(() => assertIdentity(before, { ...before, startTicks: '13' })).toThrow('identity changed');
    expect(() => assertIdentity(before, { ...before, executableSha256: 'b' })).toThrow('identity changed');
  });

  it('parses the Node entry without accepting host paths hidden in options or application arguments', () => {
    expect(nodeEntry(['/node', '--inspect=127.0.0.1:0', '--require', '/hook.mjs',
      '--enable-source-maps', './hono-host.mjs', '--user-arg'], '/runtime')).toBe('/runtime/hono-host.mjs');
    expect(nodeEntry(['/node', './other.mjs', '/runtime/hono-host.mjs'], '/runtime')).toBe('/runtime/other.mjs');
    expect(nodeEntry(['/node', '--', './hono-host.mjs'], '/runtime')).toBe('/runtime/hono-host.mjs');
    for (const argv of [['/node', '--eval', '/runtime/hono-host.mjs'], ['/node', '--require'],
      ['/node', '--unknown-option', '/runtime/hono-host.mjs'], ['/node', '--']]) {
      expect(nodeEntry(argv, '/runtime')).toBeNull();
    }
  });

  it('requires both native executable identity and an exact esbuild service argument', () => {
    expect(processCommand(['/native/esbuild', '--service=0.27.3', '--ping'], '/runtime',
      '/native/esbuild').esbuildService).toBe(true);
    for (const [exe, args] of [
      ['/native/node', ['--service=0.27.3']],
      ['/native/esbuild', ['--service=unverified']],
      ['/native/esbuild', ['--other=--service=0.27.3']],
      ['/native/esbuild', ['--service=0.27.3-suffix']],
      ['/native/esbuild-helper', ['--service=0.27.3']],
    ] as [string, string[]][]) {
      expect(processCommand([exe, ...args], '/runtime', exe).esbuildService).toBe(false);
    }
  });

  it('requires exact entry, executable and ancestry for a descendant role and keeps native ownership unknown', () => {
    const main = { pid: 1, parentPid: 0, startTicks: '1', executable: '/node',
      executableSha256: 'a', command: { script: '/runtime/hono-host.mjs', sha256: 'x', esbuildService: false },
      pssBytes: 100, rssBytes: 200, anonymousBytes: 80 };
    const child = { ...main, pid: 2, parentPid: 1, startTicks: '2', pssBytes: 50 };
    const compiler = { ...child, pid: 3, parentPid: 2, executableSha256: 'b',
      command: { ...child.command, script: null, esbuildService: true }, pssBytes: 25 };
    const inventory = processInventory(main, [child, compiler], []);
    expect(inventory.observed.map(row => row.role))
      .toEqual(['named-main', 'same-entry-operator-descendant', 'native-esbuild-service']);
    expect(inventory.observedPssBytes).toBe(175);
    expect(inventory.allocationOwner).toBe('unknown');
    expect(inventory.compilerCaller).toBe('unknown');
    expect(inventory.workerRequestAssignment).toBe('unknown');
    for (const decoy of [{ ...child, executableSha256: 'different' },
      { ...child, command: { ...child.command, script: '/other/hono-host.mjs' } }]) {
      expect(processInventory(main, [decoy], []).observed[1].role).toBe('other-descendant');
    }
    expect(() => processInventory(main, [{ ...child, parentPid: 99 }], [])).toThrow('ancestry');
    expect(() => processInventory(main, [child, { ...compiler, parentPid: 3 }], [])).toThrow('ancestry');
    expect(() => processInventory(main, [child, child], [])).toThrow('Duplicate');
  });

  it('preserves capped or raced census residue and distinguishes PID reuse from proven exit', () => {
    const main = { pid: 1, parentPid: 0, startTicks: '1', executable: '/node',
      executableSha256: 'a', command: { script: '/runtime/hono-host.mjs', sha256: 'x', esbuildService: false },
      pssBytes: 100, rssBytes: 200, anonymousBytes: 80 };
    const oldChild = { ...main, pid: 2, parentPid: 1, startTicks: '2' };
    const newChild = { ...oldChild, startTicks: '3' };
    const missed = [{ pid: 4, parentPid: 1, reason: 'cap' }, { pid: 5, parentPid: 1, reason: 'read-race-or-unavailable' }];
    const inventory = processInventory(main, [newChild], missed, [main, oldChild]);
    expect(inventory.censusComplete).toBe(false);
    expect(inventory.notChecked).toEqual(missed);
    expect(inventory.appeared).toEqual([{ pid: 2, startTicks: '3' }]);
    expect(inventory.notObservedSincePrevious).toEqual([{ pid: 2, startTicks: '2' }]);
    expect(inventory.lifetimeDefinition).toContain('not proof of exit');
  });

  it('selects counter targets only through checked exact-entry ancestry', () => {
    const main = { pid: 1, parentPid: 0, startTicks: '1', executable: '/node', executableSha256: 'a',
      command: { script: '/runtime/hono-host.mjs', sha256: 'x', esbuildService: false },
      pssBytes: 100, rssBytes: 200, anonymousBytes: 80 };
    const wrapper = { ...main, pid: 2, parentPid: 1, command: { ...main.command, script: '/wrapper.mjs' } };
    const child = { ...main, pid: 3, parentPid: 2 };
    expect(counterTarget(main, [wrapper, child], 3)).toBe(child);
    expect(counterTarget(main, [], 1)).toBe(main);
    for (const rows of [[wrapper], [wrapper, { ...child, executableSha256: 'b' }],
      [wrapper, { ...child, command: { ...child.command, script: '/other/hono-host.mjs' } }]]) {
      expect(() => counterTarget(main, rows, 3)).toThrow('Counter target');
    }
    expect(() => counterTarget(main, [child], 3)).toThrow('ancestry');
  });

  it('binds standalone counters to the exact maintained sibling, executable, ancestry and configured role', () => {
    const main = { pid: 1, parentPid: 0, startTicks: '1', executable: '/node', executableSha256: 'a',
      command: { script: '/runtime/hono-host.mjs', sha256: 'x', esbuildService: false },
      pssBytes: 100, rssBytes: 200, anonymousBytes: 80 };
    const spawner = { ...main, pid: 2, parentPid: 1, startTicks: '2',
      command: { ...main.command, script: '/runtime/spawner-sidecar.mjs' } };
    const child = { ...spawner, pid: 3, parentPid: 2, startTicks: '3' };
    const facts = { cluster: { isPrimary: true, isWorker: false }, backgroundWorkersOverride: 'disabled',
      stagingPort: false, sidecarFlags: { substrate: false, spawner: true, gateway: false, embed: false, resourceHealth: false } };
    expect(counterTarget(main, [spawner, child], 3)).toBe(child);
    expect(processInventory(main, [spawner, child], []).observed.map(row => row.role))
      .toEqual(['named-main', 'maintained-spawner-descendant', 'maintained-spawner-descendant']);
    expect(assertCounterRole(main, child, facts)).toMatchObject({ configuredSidecar: 'spawner', allocationOwner: 'unknown' });
    expect(() => assertCounterRole(main, child, { ...facts, sidecarFlags: { ...facts.sidecarFlags, spawner: false } }))
      .toThrow('configured spawner role');
    for (const decoy of [{ ...child, executableSha256: 'other' },
      { ...child, command: { ...child.command, script: '/other/spawner-sidecar.mjs' } },
      { ...child, command: { ...child.command, script: '/runtime/spawner-sidecar.mjs.backup' } }]) {
      expect(() => counterTarget(main, [spawner, decoy], 3)).toThrow('Counter target');
    }
    expect(() => counterTarget(main, [child], 3)).toThrow('ancestry');
    expect(() => assertIdentity(child, { ...child, startTicks: 'reused' })).toThrow('identity changed');
  });

  it('distinguishes request-only primaries, actual cluster workers and configured sidecars without assigning requests', () => {
    const facts = { cluster: { isPrimary: true, isWorker: false }, backgroundWorkersOverride: 'unset',
      stagingPort: true, sidecarFlags: { substrate: false, spawner: false, gateway: false, embed: false, resourceHealth: false } };
    expect(configuredHostRole(facts)).toEqual({ clusterRole: 'primary', requestOnly: true,
      configuredSidecar: null, requestAssignment: 'unknown', allocationOwner: 'unknown' });
    expect(configuredHostRole({ ...facts, backgroundWorkersOverride: 'enabled' }).requestOnly).toBe(false);
    expect(configuredHostRole({ ...facts, stagingPort: false }).requestOnly).toBe(false);
    expect(configuredHostRole({ ...facts, stagingPort: false, backgroundWorkersOverride: 'disabled',
      cluster: { isPrimary: false, isWorker: true } })).toMatchObject({ clusterRole: 'worker', requestOnly: true });
    expect(configuredHostRole({ ...facts, sidecarFlags: { ...facts.sidecarFlags, spawner: true } }))
      .toMatchObject({ configuredSidecar: 'spawner', clusterRole: 'primary', requestAssignment: 'unknown' });
    expect(() => configuredHostRole({ ...facts, cluster: { isPrimary: true, isWorker: true } })).toThrow('Incomplete');
    expect(() => configuredHostRole({ ...facts, sidecarFlags: {} })).toThrow('Incomplete');
  });

  it('rejects stale, incomplete and private discovery selections before claiming payload coverage', () => {
    const a = 'a'.repeat(64), b = 'b'.repeat(64), other = 'c'.repeat(64);
    const page = { status: 'map', undigestibleKeys: 0,
      selection: { selectedNotChecked: 0, nextOffset: null },
      values: [{ toolNamespace: 'coord:inbox', keyDigest: a, stringCodeUnits: 20 },
        { toolNamespace: 'coord:inbox', keyDigest: b, stringCodeUnits: 30 },
        { toolNamespace: 'plans:get', keyDigest: other, stringCodeUnits: 100 }] };
    expect(parseDiscoveryNamespace('coord:inbox')).toBe('coord:inbox');
    for (const raw of ['private|argument', '', 'jev-memory:' + a]) {
      expect(() => parseDiscoveryNamespace(raw)).toThrow('exact tool namespace');
    }
    expect(() => parseDiscoveryNamespace('coord:inbox', { cacheKeyDigests: [a] })).toThrow('no prior selection');
    expect(selectDiscoveredDigests([page], 'coord:inbox')).toEqual([b, a]);
    expect(() => selectDiscoveredDigests([page], 'work_items:list')).toThrow('No matching');
    expect(() => selectDiscoveredDigests([{ ...page, undigestibleKeys: 1 }], 'coord:inbox')).toThrow('Incomplete');
    expect(() => selectDiscoveredDigests([{ ...page, selection: { ...page.selection, nextOffset: 256 } }],
      'coord:inbox')).toThrow('Incomplete');
    expect(() => selectDiscoveredDigests([{ ...page, values: [{ ...page.values[0], keyDigest: 'private' }] }],
      'coord:inbox')).toThrow('Undigestible');
    const matched = { status: 'map', checked: 2,
      selection: { selectedNotChecked: 0, unresolvedKeyDigests: [] }, values: [{ keyDigest: a }, { keyDigest: b }] };
    expect(() => assertCacheSelection(matched, [a, b])).not.toThrow();
    expect(() => assertCacheSelection({ ...matched, checked: 0, values: [] }, [a, b])).toThrow('match exactly');
    expect(() => assertCacheSelection({ ...matched, values: [{ keyDigest: a }, { keyDigest: other }] },
      [a, b])).toThrow('match exactly');
  });

  it.runIf(Boolean(process.env.PAPERCUSP_P011_LIVE_PID))('measures unforced live idle and ordinary HTTP windows on the named staging process', async () => {
    const pid = Number(process.env.PAPERCUSP_P011_LIVE_PID);
    const counterPid = Number(process.env.PAPERCUSP_P011_COUNTER_PID ?? pid);
    const base = process.env.PAPERCUSP_P011_LIVE_URL;
    const expectedBuild = process.env.PAPERCUSP_P011_LIVE_BUILD;
    const destination = process.env.PAPERCUSP_P011_REPORT;
    const pinnedOwners = process.env.PAPERCUSP_P011_PINNED_OWNERS
      ? JSON.parse(process.env.PAPERCUSP_P011_PINNED_OWNERS) : undefined;
    const pinnedLimits = parsePinnedLimits(process.env.PAPERCUSP_P011_PINNED_LIMITS);
    const discoveryNamespace = parseDiscoveryNamespace(process.env.PAPERCUSP_P011_CACHE_DISCOVERY_NAMESPACE, pinnedLimits);
    const operatorCacheEntries = process.env.PAPERCUSP_P011_CACHE_ENTRIES === '1';
    if (discoveryNamespace && !operatorCacheEntries) throw Error('Cache discovery requires cache-entry attribution');
    if (operatorCacheEntries && (!process.env.PAPERCUSP_P011_PINNED_STATE ||
        pinnedOwners?.length !== 1 || pinnedOwners[0] !== '@papercusp/operator-core.operatorCache')) {
      throw Error('Cache-entry attribution requires the exact operator-cache owner');
    }
    if (pinnedOwners !== undefined && (!Array.isArray(pinnedOwners) || pinnedOwners.length < 1 ||
        pinnedOwners.some(owner => typeof owner !== 'string'))) throw Error('Exact pinned owners must be a nonempty string array');
    if (process.env.PAPERCUSP_P011_PINNED_STATE) validatePinnedStateOptions({
      ...pinnedLimits, expectedPid: pid, owners: pinnedOwners, operatorCacheEntries,
    });
    expect(Number.isInteger(pid) && pid > 0).toBe(true);
    expect(Number.isInteger(counterPid) && counterPid > 0).toBe(true);
    expect(base).toBe('http://127.0.0.1:3170');
    expect(expectedBuild).toMatch(/^[a-f0-9]{7,40}$/);
    if (!destination || !existsSync(dirname(resolve(root, destination)))) throw Error('Canonical evidence parent required');
    const path = resolve(root, destination);
    const before = processSample(pid);
    // Check only the selected target's ancestry before opening its inspector;
    // unrelated deep utility subtrees cannot turn valid selection into a cap.
    const initialRows: ResourceRow[] = [];
    let ancestor = counterPid;
    while (ancestor !== pid) {
      if (ancestor <= 1 || initialRows.length >= 16 || initialRows.some(row => row.pid === ancestor)) {
        throw Error('Initial counter-target ancestry cap or unrelated target');
      }
      const row = processSample(ancestor); initialRows.push(row); ancestor = row.parentPid;
    }
    const counterBefore = counterTarget(before, initialRows, counterPid);
    const report: any = { schemaVersion: 1, plane: 'live-current-build-operator-api',
      incomplete: true, pid, counterPid, buildSha: expectedBuild, startedAt: new Date().toISOString(),
      samples: [], windows: [], requests: [], operations: [], cleanup: {},
      metricDefinitions: { pssBytes: 'smaps_rollup Pss kernel kB times 1024',
        heapAndNative: 'V8/Node counters, overlapping with PSS; no additive native-residual estimate',
        heapSpaces: 'V8 getHeapSpaceStatistics per-space bytes; space membership can change across GC',
        heapCode: 'V8 getHeapCodeStatistics bytes; code/source counters overlap heap/external and do not identify retainers',
        pinnedState: 'Reachable logical payloads under named roots; not total retained heap/native bytes',
        observerMs: 'wall time for inspector counter read and proc descendant census' },
      limits: { windows: 3, idleMs: 2000, requestsPerWindow: 8, concurrency: 2, descendantsPerSample: 64 },
      pinnedOwners, pinnedLimits, operatorCacheEntries,
      limitations: ['Counters cover one explicitly selected main/descendant PID; HTTP request assignment remains unknown.',
        'Ambient workload is uncontrolled; idle means no probe HTTP requests.',
        'No paired intervention, allocation profiler, retainer graph or physical-savings claim.',
        'A maintained sibling entry is bound to the main build only by its observed path/executable/ancestry; its loaded build is not advertised separately.',
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
      assertIdentity(counterBefore, processSample(counterPid));
      return { sha: value.sha, version: value.version, at: new Date().toISOString() };
    };
    const attach = async () => {
      for (const candidate of listenerPorts(counterPid).filter(value => value !== 3170)) {
        try {
          const response = await fetch(`http://127.0.0.1:${candidate}/json/list`, { signal: AbortSignal.timeout(500) });
          if (!response.ok) continue;
          const targets = await response.json();
          const target = targets.find((row: any) => row.type === 'node' && row.webSocketDebuggerUrl);
          if (!target) continue;
          const connection = createCdpClient(target.webSocketDebuggerUrl);
          try { await connection.connect(); await readProcessMemory(connection, { expectedPid: counterPid }); }
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
      const entry = before.command.script;
      if (!entry) throw Error('Serving bundle entry unobserved');
      const bundlePath = entry;
      report.bundle = { path: bundlePath, argvEntry: entry, diskSha256: hash(readFileSync(bundlePath)) };
      const counterEntry = counterBefore.command.script;
      if (!counterEntry) throw Error('Counter bundle entry unobserved');
      report.counterBundle = { path: counterEntry, argvEntry: counterEntry,
        diskSha256: hash(readFileSync(counterEntry)), loadedBuild: 'unknown',
        role: counterPid === pid ? 'named-main' : descendantEntryRole(before, counterBefore) };
      report.inspectorWasOpen = await attach();
      if (!client) {
        process.kill(counterPid, 'SIGUSR1'); opened = true;
        for (let attempt = 0; attempt < 20 && !client; attempt++) { await wait(250); await attach(); }
      }
      if (!client || !port) throw Error('PID-bound inspector unavailable');
      report.inspector = { pid: counterPid, port, openedByProbe: opened };
      let effectivePinnedLimits = pinnedLimits;
      if (discoveryNamespace) {
        const pages: any[] = [];
        let offset = 0;
        for (let page = 0; page < 2; page++) {
          const discovery = await readPinnedState(client, { ...pinnedLimits, expectedPid: counterPid,
            owners: pinnedOwners, operatorCacheEntries, maxCacheEntries: 256,
            maxEntryEntries: 128, maxEntryObjects: 64, cacheEntryOffset: offset });
          assertIdentity(before, processSample(pid));
          const cache = discovery.roots[0]?.cacheEntries;
          if (!cache) throw Error('Cache discovery root unavailable');
          pages.push(cache);
          report.cacheDiscovery = { namespace: discoveryNamespace, pages,
            definition: 'At most two bounded insertion-order pages on the same PID; membership can change between pages. Ranking uses visited logical strings, not physical bytes.' };
          publish();
          if (cache.selection.nextOffset === null) break;
          offset = cache.selection.nextOffset;
        }
        const selectedKeyDigests = selectDiscoveredDigests(pages, discoveryNamespace);
        effectivePinnedLimits = { ...pinnedLimits, maxCacheEntries: selectedKeyDigests.length, cacheKeyDigests: selectedKeyDigests };
        report.cacheDiscovery.selectedKeyDigests = selectedKeyDigests;
        report.effectivePinnedLimits = effectivePinnedLimits;
        publish();
      }
      let remainingDescendants = 64;
      let missedDescendants: { pid: number; parentPid: number; reason: string }[] = [];
      let previousProcesses: ResourceRow[] = [];
      const descendants = (parent: number): ReturnType<typeof processSample>[] => {
        const children = readFileSync(`/proc/${parent}/task/${parent}/children`, 'utf8').trim();
        return (children ? children.split(/\s+/).map(Number) : []).flatMap(child => {
          if (remainingDescendants <= 0) {
            report.descendantCappedSamples = (report.descendantCappedSamples || 0) + 1;
            missedDescendants.push({ pid: child, parentPid: parent, reason: 'cap' }); return [];
          }
          remainingDescendants--;
          let row: ResourceRow;
          try {
            row = processSample(child);
            if (row.parentPid !== parent) throw Error('Descendant parent changed');
          } catch {
            report.descendantExitRaces = (report.descendantExitRaces || 0) + 1;
            missedDescendants.push({ pid: child, parentPid: parent, reason: 'read-race-or-unavailable' }); return [];
          }
          // Preserve a checked parent's resource row even if listing its own
          // children races; otherwise the aggregate silently drops known PSS.
          let nested: ResourceRow[] = [];
          try { nested = descendants(child); }
          catch { missedDescendants.push({ pid: child, parentPid: parent, reason: 'children-list-unavailable' }); }
          return [row, ...nested];
        });
      };
      const sample = async (label: string) => {
        const started = performance.now();
        const memory = await readProcessMemory(client!, { expectedPid: counterPid, hostFacts: true, allocationDetails: true });
        const pinnedState = process.env.PAPERCUSP_P011_PINNED_STATE ? await readPinnedState(client!, {
          ...effectivePinnedLimits,
          expectedPid: counterPid, owners: pinnedOwners, operatorCacheEntries,
        }) : undefined;
        if (effectivePinnedLimits?.cacheKeyDigests) assertCacheSelection(pinnedState!.roots[0].cacheEntries,
          effectivePinnedLimits!.cacheKeyDigests!);
        const os = processSample(pid); assertIdentity(before, os);
        remainingDescendants = 64;
        missedDescendants = [];
        const childRows = descendants(pid);
        const inventory = processInventory(os, childRows, missedDescendants, previousProcesses);
        const counterOs = counterTarget(os, childRows, counterPid);
        assertIdentity(counterBefore, counterOs);
        previousProcesses = [os, ...childRows];
        report.samples.push({ label, at: new Date().toISOString(), ...memory, os, counterOs,
          configuredHostRole: assertCounterRole(before, counterOs, memory.hostFacts), pinnedState,
          descendants: childRows, inventory, observerMs: performance.now() - started }); publish();
        expect(memory.heapSpaces.length).toBeGreaterThan(0);
        expect(memory.heapSpaces.every((space: any) => typeof space.space_name === 'string' &&
          Number.isFinite(space.space_used_size) && space.space_used_size >= 0)).toBe(true);
        expect(Number.isFinite(memory.heapCode.code_and_metadata_size)).toBe(true);
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
        row.pinnedState.pid === counterPid && row.pinnedState.registryPresent &&
        row.pinnedState.population >= row.pinnedState.checked && row.pinnedState.checked > 0)).toBe(true);
      if (pinnedOwners) expect(report.samples.every((row: any) =>
        row.pinnedState.selection?.missingOwners.length === 0 &&
        row.pinnedState.selection?.selectedNotChecked === 0 &&
        row.pinnedState.checked === pinnedOwners.length)).toBe(true);
      if (operatorCacheEntries) expect(report.samples.every((row: any) => {
        const cache = row.pinnedState.roots[0].cacheEntries;
        return cache?.status === 'map' && cache.population === cache.checked + cache.notChecked &&
          cache.values.every((value: any) => (value.keyDigest === null || /^[a-f0-9]{64}$/.test(value.keyDigest)) &&
            value.entries <= row.pinnedState.limits.maxEntryEntries &&
            value.objects <= row.pinnedState.limits.maxEntryObjects);
      })).toBe(true);
      report.incomplete = false;
    } catch (error) { report.error = error instanceof Error ? error.message : String(error); throw error; }
    finally {
      try {
        if (client && opened && port) report.cleanup.inspector = await closeInspector(client, port);
        else { client?.close(); report.cleanup.inspector = { preservedPreexisting: true }; }
        assertIdentity(before, processSample(pid)); report.cleanup.processIdentityPreserved = true;
        assertIdentity(counterBefore, processSample(counterPid)); report.cleanup.counterIdentityPreserved = true;
      } catch (error) { report.cleanup.error = String(error); report.incomplete = true; throw error; }
      finally { report.endedAt = new Date().toISOString(); publish(); }
    }
    expect(report.cleanup.processIdentityPreserved).toBe(true);
    expect(report.cleanup.counterIdentityPreserved).toBe(true);
    expect(report.operations).toEqual([]);
  }, 100_000);
});
