import { describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import {
  recordCurrentSessionIdentityActivation,
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
