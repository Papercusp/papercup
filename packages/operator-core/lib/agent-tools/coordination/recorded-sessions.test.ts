/**
 * recorded-sessions.test.ts — the pure session-log → roster-row projection
 * (presence-derive-from-session-log-2026-06-22 P-001). Asserts the dedup rules,
 * the synthesized record shape, and — central to the owner's requirement — that
 * the projection is CLI-AGNOSTIC (claude / codex / omp recorded sessions are all
 * surfaced identically; the only key is `coordOwnerId`).
 */

import { describe, it, expect } from 'vitest';
import { synthesizeRecordedRosterRows, reconcileRosterSources, RECORDED_SESSION_SOURCE } from './recorded-sessions';
import type { AdvSessionRow } from '../../adv-sessions';
import type { UnifiedPresenceRecord } from './federated-presence';

/** Minimal presence-row factory — only ownerId + stale drive the reconciliation. */
function pres(ownerId: string, stale: boolean): UnifiedPresenceRecord {
  return {
    ownerId, ownerLabel: ownerId, workspaceId: 'ws-1', source: 'omp-hook-session',
    intent: '', currentPlanSlug: null, currentFiles: [], host: '', pid: null,
    startedAt: '2026-06-22T19:00:00.000Z', heartbeatAt: '2026-06-22T19:00:00.000Z',
    lastActiveAt: null, agentRole: 'su', hiveSlug: null, stale, userId: null, revoked: false,
  };
}

/** Minimal AdvSessionRow factory — only the fields the projection reads matter. */
function adv(overrides: Partial<AdvSessionRow>): AdvSessionRow {
  return {
    id: 1,
    workspaceId: 'ws-1',
    planSlug: null,
    agent: 'claude',
    role: null,
    feature: null,
    mode: 'console',
    terminalBin: null,
    pid: null,
    windowId: null,
    ompThreadId: null,
    label: null,
    cwd: null,
    coordOwnerId: 's-1-aaaa',
    sessionId: null,
    display: null,
    launchArgv: null,
    launchedAt: null,
    startedAt: '2026-06-22T20:00:00.000Z',
    endedAt: null,
    exitCode: null,
    ...overrides,
  };
}

describe('synthesizeRecordedRosterRows', () => {
  it('projects a recorded live session into a roster row with the session-log marker', () => {
    const rows = synthesizeRecordedRosterRows(
      [adv({ coordOwnerId: 's-1-aaaa', role: 'mug', label: 'hive · papercusp/queen', planSlug: 'p-x', pid: 42 })],
      new Set(),
    );
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.ownerId).toBe('s-1-aaaa');
    expect(r.ownerLabel).toBe('hive · papercusp/queen');
    expect(r.source).toBe(RECORDED_SESSION_SOURCE);
    expect(r.agentRole).toBe('mug');
    expect(r.currentPlanSlug).toBe('p-x');
    expect(r.pid).toBe(42);
    // Authoritatively live: never heartbeat-stale, never a federated row.
    expect(r.stale).toBe(false);
    expect(r.federated).toBe(false);
    // No fabricated activity/intent.
    expect(r.intent).toBe('');
    expect(r.lastActiveAt).toBeNull();
  });

  it('skips rows with no coordOwnerId (unaddressable — can never be woken)', () => {
    expect(synthesizeRecordedRosterRows([adv({ coordOwnerId: null })], new Set())).toEqual([]);
  });

  it('skips a session already self-registered in coord_presence (richer row wins)', () => {
    const rows = synthesizeRecordedRosterRows(
      [adv({ coordOwnerId: 'su-registered' })],
      new Set(['su-registered']),
    );
    expect(rows).toEqual([]);
  });

  it('dedups within the recorded list (first / most-recent per owner wins)', () => {
    const rows = synthesizeRecordedRosterRows(
      [
        adv({ id: 2, coordOwnerId: 'dup', label: 'newer' }),
        adv({ id: 1, coordOwnerId: 'dup', label: 'older' }),
      ],
      new Set(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].ownerLabel).toBe('newer');
  });

  it('is CLI-AGNOSTIC — claude (s-…), codex (su-…) and omp recorded sessions all surface', () => {
    const rows = synthesizeRecordedRosterRows(
      [
        adv({ agent: 'claude', mode: 'console', coordOwnerId: 's-1782-claudehex', label: 'hive · papercusp/queen' }),
        adv({ agent: 'codex', mode: 'console', coordOwnerId: 'su-codex-uuid', role: 'kettle' }),
        adv({ agent: 'omp', mode: 'omp', coordOwnerId: 'su-omp-uuid', label: 'su · engineer' }),
      ],
      new Set(),
    );
    expect(rows.map((r) => r.ownerId).sort()).toEqual(['s-1782-claudehex', 'su-codex-uuid', 'su-omp-uuid']);
    // Every CLI gets the same marker + live-not-stale treatment.
    for (const r of rows) {
      expect(r.source).toBe(RECORDED_SESSION_SOURCE);
      expect(r.stale).toBe(false);
    }
  });

  it('label fallback chain: label → role → agent → "session"', () => {
    expect(synthesizeRecordedRosterRows([adv({ coordOwnerId: 'a', label: 'L', role: 'mug', agent: 'claude' })], new Set())[0].ownerLabel).toBe('L');
    expect(synthesizeRecordedRosterRows([adv({ coordOwnerId: 'b', label: null, role: 'mug', agent: 'claude' })], new Set())[0].ownerLabel).toBe('mug');
    expect(synthesizeRecordedRosterRows([adv({ coordOwnerId: 'c', label: '  ', role: null, agent: 'codex' })], new Set())[0].ownerLabel).toBe('codex');
    expect(synthesizeRecordedRosterRows([adv({ coordOwnerId: 'd', label: null, role: null, agent: null })], new Set())[0].ownerLabel).toBe('session');
  });

  it('empty input → empty output', () => {
    expect(synthesizeRecordedRosterRows([], new Set())).toEqual([]);
  });
});

describe('reconcileRosterSources', () => {
  it('a FRESH presence row wins — the session-log record never shadows it', () => {
    const out = reconcileRosterSources([pres('a', false)], [adv({ coordOwnerId: 'a', label: 'from-log' })]);
    expect(out).toHaveLength(1);
    expect(out[0].source).toBe('omp-hook-session'); // the presence row, not the synthesized one
  });

  it('a live session-log record SUPERSEDES a STALE presence row (the resume case)', () => {
    const out = reconcileRosterSources([pres('b', true)], [adv({ coordOwnerId: 'b', label: 'resumed' })]);
    // The stale heartbeat row is dropped; the live record wins.
    expect(out).toHaveLength(1);
    expect(out[0].ownerId).toBe('b');
    expect(out[0].source).toBe(RECORDED_SESSION_SOURCE);
    expect(out[0].stale).toBe(false);
  });

  it('an owner with ONLY a live record gets a synthesized recorded row', () => {
    const out = reconcileRosterSources([], [adv({ coordOwnerId: 'c' })]);
    expect(out.map((r) => [r.ownerId, r.source])).toEqual([['c', RECORDED_SESSION_SOURCE]]);
  });

  it('a STALE presence row with NO live record is kept as-is (still ended/stale)', () => {
    const out = reconcileRosterSources([pres('d', true)], []);
    expect(out).toHaveLength(1);
    expect(out[0].ownerId).toBe('d');
    expect(out[0].source).toBe('omp-hook-session');
    expect(out[0].stale).toBe(true);
  });

  it('mixed roster: fresh wins, stale superseded, log-only synthesized, stale-no-log kept', () => {
    const out = reconcileRosterSources(
      [pres('fresh', false), pres('stale-resumed', true), pres('stale-dead', true)],
      [adv({ coordOwnerId: 'fresh' }), adv({ coordOwnerId: 'stale-resumed' }), adv({ coordOwnerId: 'log-only' })],
    );
    const byOwner = Object.fromEntries(out.map((r) => [r.ownerId, r.source]));
    expect(byOwner['fresh']).toBe('omp-hook-session');        // fresh presence wins
    expect(byOwner['stale-resumed']).toBe(RECORDED_SESSION_SOURCE); // live record supersedes stale
    expect(byOwner['stale-dead']).toBe('omp-hook-session');   // stale kept (no live record)
    expect(byOwner['log-only']).toBe(RECORDED_SESSION_SOURCE); // synthesized
    expect(out).toHaveLength(4); // no double-listing
  });
});
