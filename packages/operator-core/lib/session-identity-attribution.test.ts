import { describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createPhaseTracker } from '@papercusp/tooldef';
import {
  recordCurrentSessionIdentityActivation,
  recordSessionIdentityReanchor,
  sessionIdentityStateRevision,
  sessionIdentityTransitionId,
} from './session-identity-attribution';

function sqlSequence(results: unknown[][]) {
  const calls: Array<{ statement: string; values: unknown[] }> = [];
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ statement: strings.join('?'), values });
    return Promise.resolve(results.shift() ?? []);
  }) as unknown as Sql;
  return { sql, calls };
}

const revision = { specificationRevision: 'a'.repeat(64), stateRevision: 'state-1' };

describe('session identity activation attribution', () => {
  it('distinguishes pending anchor, write and replay reads without recording identities', async () => {
    let now = 0;
    let settle!: (rows: unknown[]) => void;
    const phases = createPhaseTracker({ now: () => now });
    const sql = (() => new Promise<unknown[]>(resolve => { settle = resolve; })) as unknown as Sql;
    const result = recordSessionIdentityReanchor({ workspaceId: 'private-workspace', ownerId: 'private-owner',
      nativeSessionId: 'private-native', sql, phases });
    await Promise.resolve();
    now = 80;
    expect(phases.snapshot().activePhase).toBe('nativeReanchor:identityAnchorRead');
    settle([{ generation: 3, applied: JSON.stringify(revision), last_id: 1, last_native: 'old-native' }]);
    await viWaitForPhase('nativeReanchor:identityWrite');
    now = 100;
    settle([]);
    await viWaitForPhase('nativeReanchor:identityReplayRead');
    now = 130;
    settle([{ found: true }]);
    await expect(result).resolves.toBe('replayed');
    expect(phases.intervals().map(({ phase, durationMs }) => ({ phase, durationMs }))).toEqual([
      { phase: 'nativeReanchor:identityAnchorRead', durationMs: 80 },
      { phase: 'nativeReanchor:identityWrite', durationMs: 20 },
      { phase: 'nativeReanchor:identityReplayRead', durationMs: 30 },
    ]);
    expect(JSON.stringify(phases.toMetadata())).not.toMatch(/private-|old-native/);

    async function viWaitForPhase(expected: string) {
      for (let i = 0; i < 20 && phases.snapshot().activePhase !== expected; i++) await Promise.resolve();
      expect(phases.snapshot().activePhase).toBe(expected);
    }
  });

  it('does not write an identity event when the anchor already names the native incarnation', async () => {
    const phases = createPhaseTracker();
    const { sql, calls } = sqlSequence([[{ generation: 3, applied: JSON.stringify(revision),
      last_id: 1, last_native: 'same-native' }]]);
    await expect(recordSessionIdentityReanchor({ workspaceId: 'ws', ownerId: 'su-a',
      nativeSessionId: 'same-native', sql, phases })).resolves.toBe('replayed');
    expect(calls).toHaveLength(1);
    expect(phases.intervals().map(p => p.phase)).toEqual(['nativeReanchor:identityAnchorRead']);
  });

  it('hashes mutable worn-identity state canonically', () => {
    const a = sessionIdentityStateRevision({
      modes: ['auto', 'ideate'], stack: ['autonomy:su.mode-auto'], route: { kind: 'self' },
    });
    const b = sessionIdentityStateRevision({
      route: { kind: 'self' }, stack: ['autonomy:su.mode-auto'], modes: ['auto', 'ideate'],
    });
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(b).toBe(a);
  });

  it('keeps repeated revisions distinct across control generations', () => {
    expect(sessionIdentityTransitionId('su-a', 4, revision)).not.toBe(
      sessionIdentityTransitionId('su-a', 5, revision),
    );
  });

  it('reports inserted, idempotent replay, and stale/missing writes distinctly', async () => {
    const inserted = sqlSequence([[{ id: 1 }]]);
    await expect(recordCurrentSessionIdentityActivation({
      workspaceId: 'ws', ownerId: 'su-a', generation: 3,
      phase: 'applied', source: 'control', revision, sql: inserted.sql,
    })).resolves.toBe('inserted');
    expect(inserted.calls[0]!.statement).toContain('session_identity_activation_events');

    const replayed = sqlSequence([[], [{ found: true }]]);
    await expect(recordCurrentSessionIdentityActivation({
      workspaceId: 'ws', ownerId: 'su-a', generation: 3,
      phase: 'applied', source: 'control', revision, sql: replayed.sql,
    })).resolves.toBe('replayed');

    const missing = sqlSequence([[], []]);
    await expect(recordCurrentSessionIdentityActivation({
      workspaceId: 'ws', ownerId: 'su-a', generation: 99,
      phase: 'failed', source: 'control', revision, failure: 'render failed', sql: missing.sql,
    })).resolves.toBe('missing');
  });
});
