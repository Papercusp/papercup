/**
 * compaction-usage — the per-session context-size estimator's backend gating +
 * graceful degradation (agent-managed-compaction-2026-07-01 P-007/P-009). The
 * transcript-size path is exercised by integration; here we pin the pure guards:
 * unresolvable / non-Claude sessions must degrade to null, never throw.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { estimateContextTokens, tokensFromFileSize } from './compaction-usage';

describe('estimateContextTokens (backend gating + degradation)', () => {
  it('returns null for a null sessionId', async () => {
    expect(await estimateContextTokens({ agent: 'claude', sessionId: null })).toBeNull();
  });

  it('returns null for OMP (self-compacts natively — no v1 signal)', async () => {
    expect(await estimateContextTokens({ agent: 'omp', sessionId: 'omp-thread-123' })).toBeNull();
  });

  it('returns null for Codex (no compaction)', async () => {
    expect(await estimateContextTokens({ agent: 'codex', sessionId: 'codex-rollout-123' })).toBeNull();
  });

  it('returns null for an unresolvable Claude session (no transcript on disk)', async () => {
    const est = await estimateContextTokens({ agent: 'claude', sessionId: 'nonexistent-session-9999' });
    expect(est).toBeNull();
  });
});
