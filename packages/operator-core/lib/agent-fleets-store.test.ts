/**
 * Coverage for agent-fleets-store.fleetSlugFromName — the pure name→slug derivation
 * used by the psu "enter a new fleet name" step (the slug is the durable id, the
 * env-var value, and the presence label).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  asFleetType,
  FLEET_TYPES,
  fleetSlugFromName,
  measureFleetProductiveHeadcount,
  projectFleetHeadcountState,
} from './agent-fleets-store';

const LIB_ROOT = fileURLToPath(new URL('.', import.meta.url));
const STORE_MOCK_START_RE = /vi\.mock\(\s*(['"])[^'"]*agent-fleets-store\1/;
const STORE_OBJECT_MOCK_RE = /vi\.mock\(\s*(['"])[^'"]*agent-fleets-store\1\s*,[\s\S]*?\}\)\);/g;

function testSourcesBelow(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return testSourcesBelow(path);
    return entry.isFile() && entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

/**
 * A full vi.mock replaces every runtime export. goal-launch-settings builds its
 * fleetType schema from FLEET_TYPES at module scope, so omitting the value makes
 * any newly-connected import path fail during collection before a test can run.
 * Partial importOriginal/actual mocks keep the real export and are intentionally
 * exempt. This is the central recurrence guard for the strand that red-pinned
 * unrelated fleet, capability, bootstrap and coordination test files.
 */
function fullStoreMocksWithoutFleetTypes(): string[] {
  const offenders: string[] = [];
  for (const file of testSourcesBelow(LIB_ROOT)) {
    const source = readFileSync(file, 'utf8');
    if (!STORE_MOCK_START_RE.test(source)) continue;
    STORE_OBJECT_MOCK_RE.lastIndex = 0;
    const calls = [...source.matchAll(STORE_OBJECT_MOCK_RE)].map((match) => match[0]);
    if (calls.length === 0) {
      // Block-bodied partial mocks use `const actual = await orig()` and return
      // `{ ...actual, overrides }`; they preserve every unmentioned export.
      if (!/\.\.\.actual/.test(source)) offenders.push(`${file} (unparsed mock shape)`);
      continue;
    }
    for (const call of calls) {
      if (/importOriginal|\.\.\.actual/.test(call)) continue;
      if (!call.includes('FLEET_TYPES')) offenders.push(file);
    }
  }
  return [...new Set(offenders)].sort();
}

describe('fleetSlugFromName', () => {
  it('kebab-cases a human name', () => {
    expect(fleetSlugFromName('My Cool Fleet')).toBe('my-cool-fleet');
  });

  it('collapses runs of non-alphanumerics (incl. underscores) and trims the edges', () => {
    expect(fleetSlugFromName('  Front-End  Squad!! ')).toBe('front-end-squad');
    expect(fleetSlugFromName('a___b')).toBe('a-b');
    expect(fleetSlugFromName('Fleet #1 (alpha)')).toBe('fleet-1-alpha');
  });

  it('caps length to 60 chars', () => {
    expect(fleetSlugFromName('x'.repeat(100))).toHaveLength(60);
  });

  it('falls back to "fleet" for empty / all-symbol input', () => {
    expect(fleetSlugFromName('')).toBe('fleet');
    expect(fleetSlugFromName('   ')).toBe('fleet');
    expect(fleetSlugFromName('!!!')).toBe('fleet');
  });
});

/**
 * asFleetType — the defensive narrowing behind AgentFleetRecord.fleetType
 * (directed-pair-work-items-2026-08-25 D-008 / P-010, migration 964).
 *
 * The asymmetry is the whole point and is what these cases pin: 'paired' is the
 * ONLY value that opens the paired code paths, and every other input — a legacy
 * row that predates the column, a typo, a value written by a newer release, a
 * lookalike like 'Paired' or 'pair' — reads back 'single'. A fleet can therefore
 * never be treated as paired by accident, only by having explicitly said so.
 */
describe('asFleetType', () => {
  it('honours the one non-default value', () => {
    expect(asFleetType('paired')).toBe('paired');
  });

  it('passes the default through', () => {
    expect(asFleetType('single')).toBe('single');
  });

  it('narrows a legacy/absent value to single', () => {
    // Rows written before migration 964 have no fleet_type at all.
    expect(asFleetType(null)).toBe('single');
    expect(asFleetType(undefined)).toBe('single');
  });

  it('narrows an unrecognised or lookalike value to single, never to paired', () => {
    for (const bogus of ['Paired', 'PAIRED', ' paired', 'pair', 'pairs', 'duo', '', 'true']) {
      expect(asFleetType(bogus)).toBe('single');
    }
  });

  it('narrows non-string junk to single rather than throwing', () => {
    for (const junk of [0, 1, true, false, {}, [], NaN]) {
      expect(asFleetType(junk)).toBe('single');
    }
  });

  it('only ever returns a declared fleet type', () => {
    for (const input of ['paired', 'single', null, 'nonsense', 42]) {
      expect(FLEET_TYPES).toContain(asFleetType(input));
    }
  });
});

describe('agent-fleets-store full-mock contract', () => {
  it('preserves the runtime FLEET_TYPES vocabulary in every full vi.mock factory', () => {
    expect(fullStoreMocksWithoutFleetTypes()).toEqual([]);
  });
});

describe('projectFleetHeadcountState — productive worker population (EI-212754)', () => {
  const enabled = {
    workspaceId: 'ws',
    fleetSlug: 'fleet-a',
    enabled: true,
    target: 4,
    config: {},
    nextAttemptAt: null,
    backoffMs: 0,
    lastError: null,
  } as never;

  it('counts live members attested by recent agent-origin execution', () => {
    expect(measureFleetProductiveHeadcount(
      { workerReadyMemberIds: ['su-ready-live'] } as never,
      ['su-ready-live', 'su-other-live', 'su-idle-live', 'su-other-live'],
      new Set(['su-ready-live', 'su-other-live', 'su-not-on-roster']),
    )).toEqual({
      current: 2,
      basis: {
        kind: 'agent-origin-execution-attested',
        liveRosterMembers: 3,
        executingMembers: 2,
        transactionWorkerReadyMembers: 1,
      },
    });
    expect(projectFleetHeadcountState(
      enabled,
      { workerReadyMemberIds: ['su-ready-live'] } as never,
      ['su-ready-live', 'su-other-live', 'su-idle-live'],
      new Set(['su-ready-live', 'su-other-live']),
    )).toEqual({
      enabled: true,
      target: 4,
      current: 2,
      shortfall: 2,
      underStrength: true,
      verdict: 'under-strength',
      basis: {
        kind: 'agent-origin-execution-attested',
        liveRosterMembers: 3,
        executingMembers: 2,
        transactionWorkerReadyMembers: 1,
      },
    });
  });

  // WI-2034624 REGRESSION. `current` was the live roster INTERSECT the CURRENT
  // launch transaction's worker-ready ids, so a member opened by a prior
  // transaction — or rebuilt by a carry-respawn — was invisible however hard it
  // was working. Reproduced at the measured incident ratio: 37 live, 3 recorded
  // worker-ready, 22 demonstrably executing. The old code answered 3.
  it('counts an executing member the current launch transaction never recorded', () => {
    const live = Array.from({ length: 37 }, (_, i) => `su-live-${i}`);
    const transactionWorkerReady = live.slice(0, 3);
    const executing = new Set(live.slice(0, 22));
    const measured = measureFleetProductiveHeadcount(
      { workerReadyMemberIds: transactionWorkerReady } as never,
      live,
      executing,
    );
    expect(measured.current).toBe(22);
    expect(measured.basis).toEqual({
      kind: 'agent-origin-execution-attested',
      liveRosterMembers: 37,
      executingMembers: 22,
      transactionWorkerReadyMembers: 3,
    });
    // The transaction population is retained ONLY as a diagnostic; it must never
    // be able to cap the count.
    expect(measured.current).toBeGreaterThan(measured.basis.transactionWorkerReadyMembers!);
  });

  // The RECURRENCE GUARD for the whole class, stated as the invariant rather
  // than as one shape: while the attestation is readable, the launch
  // transaction must be unable to influence `current` AT ALL. Any future edit
  // that lets transaction state back into the count — an intersection, a cap, a
  // filter, a "prefer the recorded set when present" branch — breaks this
  // without needing anyone to have anticipated its particular shape.
  it('never lets launch-transaction state change the attested count', () => {
    const live = ['su-a', 'su-b', 'su-c'];
    const executing = new Set(['su-a', 'su-b']);
    const transactions: unknown[] = [
      null,
      undefined,
      {},
      { workerReadyMemberIds: [] },
      { workerReadyMemberIds: ['su-c'] },                       // disjoint from executing
      { workerReadyMemberIds: ['su-a'] },                       // a strict subset
      { workerReadyMemberIds: [...live, 'su-not-live'] },       // a superset
      { workerAttestations: [], governor: {} },
      { workerReadyMemberIds: ['su-c'], workerAttestations: [], governor: {} },
    ];
    for (const transaction of transactions) {
      const measured = measureFleetProductiveHeadcount(
        transaction as never,
        live,
        executing,
      );
      expect({ transaction, current: measured.current, kind: measured.basis.kind }).toEqual({
        transaction,
        current: 2,
        kind: 'agent-origin-execution-attested',
      });
      expect(measured.basis.executingMembers).toBe(2);
    }
  });

  it('measures headcount even when the launch-transaction read itself failed', () => {
    expect(measureFleetProductiveHeadcount(undefined, ['su-a', 'su-b'], new Set(['su-a'])))
      .toEqual({
        current: 1,
        basis: {
          kind: 'agent-origin-execution-attested',
          liveRosterMembers: 2,
          executingMembers: 1,
          transactionWorkerReadyMembers: null,
        },
      });
  });

  it('treats an empty executing set as a measured zero, not unknown', () => {
    expect(projectFleetHeadcountState(
      enabled,
      { workerReadyMemberIds: ['su-live-but-silent'] } as never,
      ['su-live-but-silent'],
      new Set<string>(),
    )).toMatchObject({
      current: 0,
      shortfall: 4,
      verdict: 'under-strength',
      basis: {
        kind: 'agent-origin-execution-attested',
        liveRosterMembers: 1,
        executingMembers: 0,
        transactionWorkerReadyMembers: 1,
      },
    });
  });

  it('retains the old live-roster count only for a transaction predating worker attestation', () => {
    expect(projectFleetHeadcountState(enabled, null, ['su-a', 'su-b'], null)).toMatchObject({
      current: 2,
      shortfall: 2,
      verdict: 'under-strength',
      basis: {
        kind: 'legacy-live-roster-fallback',
        liveRosterMembers: 2,
        executingMembers: null,
        transactionWorkerReadyMembers: null,
      },
    });
  });

  // The failure this replaces silently narrowed to the transaction population.
  // Unknown is the only honest answer, and it makes the governor fail closed.
  it('keeps a modern transaction with unreadable telemetry unknown, never worker-ready-scoped', () => {
    expect(projectFleetHeadcountState(
      enabled,
      { workerReadyMemberIds: ['su-recorded'] } as never,
      ['su-recorded', 'su-live-from-a-prior-transaction'],
      null,
    )).toMatchObject({
      current: null,
      shortfall: null,
      underStrength: null,
      verdict: 'unknown',
      basis: {
        kind: 'unknown',
        liveRosterMembers: 2,
        executingMembers: null,
        transactionWorkerReadyMembers: 1,
      },
    });
  });

  it('keeps a failed roster read unknown with the observed side in its basis', () => {
    expect(projectFleetHeadcountState(enabled, undefined, ['su-live'], null)).toMatchObject({
      current: null,
      verdict: 'unknown',
      basis: {
        kind: 'unknown',
        liveRosterMembers: 1,
        executingMembers: null,
        transactionWorkerReadyMembers: null,
      },
    });
    expect(projectFleetHeadcountState(
      enabled,
      { workerReadyMemberIds: ['su-ready'] } as never,
      null,
      new Set(['su-ready']),
    )).toMatchObject({
      current: null,
      verdict: 'unknown',
      basis: {
        kind: 'unknown',
        liveRosterMembers: null,
        executingMembers: null,
        transactionWorkerReadyMembers: 1,
      },
    });
  });
});
