/**
 * mug-persona-stub.test.ts — the D-007 anti-drift guard, applied to the role
 * that DISCOVERED the problem (EI-611).
 *
 * EI-611 (2026-06-14): under the pre-rename "Queen"/"hive" naming, there were
 * TWO full personas — a global fallback `prompts/queen.md` (~148 lines) and the
 * live `blueprints/hive/prompts/queen.md` (~527 lines) — that silently DRIFTED:
 * shared instructions repeatedly landed in the dead fallback while the live
 * blueprint role ran without them (hit ≥2x in 24h).
 *
 * blueprint-role-bundling-2026-06-15 Phase 0/5 (EI-621), the very next day,
 * restructured this: the global `prompts/` dir was DELETED outright, "Queen"
 * became "Mug", "hive" became per-domain pot blueprints (`coding`, `work`, …),
 * and the fallback role EI-611 asked for was rebuilt as a genuinely thin stub —
 * `blueprints/base/prompts/mug.md` — that explicitly refuses to grow into a
 * second persona. The kettle role (EI-611's other subject, ex-"overwatch") got
 * an explicit pinning test for this (`kettle-persona-stub.test.ts`) — this file
 * is the analogous guard for MUG ITSELF, the role the bug was originally filed
 * against, which never got its own pin.
 *
 * Mug's composition differs slightly from kettle's single canonical file: the
 * SHARED METHOD (triage, survey, the three placements, propose/dispose,
 * completion, idea-queue triage, grading, reflect, declare-wake) lives in
 * `mug.base.md` (composed into every Mug regardless of domain); `base/mug.md`
 * is the true no-domain-delta STUB; and each real pot supplies its OWN small
 * domain-decomposition delta (`coding/prompts/mug.md`,
 * `work/prompts/mug.md`) — genuinely different content per domain, not a
 * duplicate persona, so both are pinned as "substantial but bounded" rather
 * than compared 1:1 against a single canonical.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { harnessPath } from './harness-paths';

const BASE_METHOD = harnessPath('blueprints', 'base', 'prompts', 'mug.base.md');
const STUB = harnessPath('blueprints', 'base', 'prompts', 'mug.md');
const CODING_DELTA = harnessPath('blueprints', 'coding', 'prompts', 'mug.md');
const WORK_DELTA = harnessPath('blueprints', 'work', 'prompts', 'mug.md');

describe('Mug persona — the shared method lives once, the fallback stays a stub (D-007 / EI-611)', () => {
  it('the shared method (mug.base.md) is a SUBSTANTIAL, composed-into-every-Mug persona', () => {
    const method = readFileSync(BASE_METHOD, 'utf8');
    expect(method.split('\n').length).toBeGreaterThan(100);
  });

  it('the no-domain-delta fallback (base/prompts/mug.md) is a THIN STUB, not a second full persona', () => {
    const stub = readFileSync(STUB, 'utf8');
    const method = readFileSync(BASE_METHOD, 'utf8');
    // A stub is small in absolute terms…
    expect(stub.split('\n').length).toBeLessThan(60);
    // …and far smaller than the shared method (the anti-drift signal — if
    // someone copies persona instructions into the fallback, this ratio
    // collapses and the test trips, exactly like the original EI-611 failure).
    expect(stub.length).toBeLessThan(method.length / 3);
  });

  it('the stub announces itself as a stub AND names both real per-domain homes', () => {
    const stub = readFileSync(STUB, 'utf8');
    expect(stub).toMatch(/fallback|safety net/i);
    // The explicit anti-drift instruction (D-007's prescribed wording, "keep it
    // thin" / "not a place to grow a second persona").
    expect(stub).toMatch(/keep it thin|not a place to grow/i);
    // Points readers/authors at the two real, CURRENT domain-delta homes — not
    // the stale `blueprints/pot/…` / `blueprints/generic-pot/…` paths this same
    // file used to carry (fixed alongside this test; those blueprint ids don't
    // exist — the real ones are `coding` and `work`).
    expect(stub).toContain('blueprints/coding/prompts/mug.md');
    expect(stub).toContain('blueprints/work/prompts/mug.md');
  });

  it('each per-domain decomposition delta exists and is a genuinely small delta, not a duplicate full persona', () => {
    const method = readFileSync(BASE_METHOD, 'utf8');
    for (const path of [CODING_DELTA, WORK_DELTA]) {
      const delta = readFileSync(path, 'utf8');
      // Non-trivial (a real decomposition strategy)…
      expect(delta.split('\n').length).toBeGreaterThan(10);
      // …but nowhere near the size of the shared method (a delta that grows to
      // match the method's size is itself a duplicate-persona drift signal).
      expect(delta.length).toBeLessThan(method.length / 2);
    }
  });
});
