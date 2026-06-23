/**
 * EI-2826 regression: the doc-freshness sweep used to broadcast ONE coord message per
 * drifted doc to `*` — a single substantive commit could fire 50+ in seconds, burying
 * directed peer messages in every agent's inbox. The fix coalesces a sweep into ONE
 * digest line. These tests pin the pure digest builder (the sweep orchestration around it
 * is best-effort PG/git glue; the COALESCING — N drifted docs → exactly one message — is
 * the behavior that matters and is fully captured here).
 */
import { describe, it, expect } from 'vitest';
import { buildDocDriftDigest, DOC_DRIFT_DIGEST_MAX_NAMED } from './sweep-after-sync';
import type { DriftedDoc } from './doc-steward-dispatch';

const doc = (docId: string, source: string): DriftedDoc => ({
  docId,
  anchorPaths: [],
  reason: 'subject code changed',
  source,
});

describe('buildDocDriftDigest (EI-2826 — coalesce the per-doc doc-drift flood)', () => {
  it('returns null when nothing drifted (→ send no message at all)', () => {
    expect(buildDocDriftDigest('papercusp', [])).toBeNull();
  });

  it('a single manual doc → one digest that names it as RE-VERIFY, no "+more"', () => {
    const d = buildDocDriftDigest('papercusp', [doc('agent-insights/foo.mdx', 'manual')]);
    expect(d).not.toBeNull();
    expect(d).toContain('papercusp');
    expect(d).toContain('1 doc(s) drifted');
    expect(d).toContain('1 manual need RE-VERIFY');
    expect(d).toContain('agent-insights/foo.mdx');
    expect(d).not.toContain('more)');
    expect(d).not.toContain('regen'); // no generated docs in this batch
  });

  it('splits manual (re-verify) vs generated/augmented (regen) in ONE message', () => {
    const d = buildDocDriftDigest('papercusp', [
      doc('a.mdx', 'manual'),
      doc('b.mdx', 'manual'),
      doc('c.mdx', 'generated'),
      doc('d.mdx', 'augmented'), // augmented routes to regen (status 'stale'), not re-verify
    ]);
    expect(d).toContain('4 doc(s) drifted');
    expect(d).toContain('2 manual need RE-VERIFY');
    expect(d).toContain('2 generated STALE → regen enqueued');
  });

  it('caps the inline names at DOC_DRIFT_DIGEST_MAX_NAMED and folds the rest into "+N more"', () => {
    const n = DOC_DRIFT_DIGEST_MAX_NAMED + 5;
    const docs = Array.from({ length: n }, (_, i) => doc(`d${i}.mdx`, 'manual'));
    const d = buildDocDriftDigest('papercusp', docs)!;
    expect(d).toContain(`${n} doc(s) drifted`);
    expect(d).toContain('d0.mdx');
    expect(d).toContain(`d${DOC_DRIFT_DIGEST_MAX_NAMED - 1}.mdx`); // last named
    expect(d).not.toContain(`d${DOC_DRIFT_DIGEST_MAX_NAMED}.mdx`); // first folded
    expect(d).toContain(`(+5 more)`);
  });

  it('a batch of any size collapses to exactly ONE string — the whole point (no per-doc flood)', () => {
    const docs = Array.from({ length: 50 }, (_, i) => doc(`doc${i}.mdx`, i % 2 ? 'manual' : 'generated'));
    const d = buildDocDriftDigest('papercusp', docs);
    expect(typeof d).toBe('string');
    expect(d).toContain('50 doc(s) drifted');
  });
});
