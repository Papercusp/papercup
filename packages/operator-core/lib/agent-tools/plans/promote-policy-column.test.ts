/**
 * promote-policy-column.test.ts — v2 plan-templates-and-rubric-v2-2026-06-20 P-001.
 *
 * Pins the WRITE-TIME populate: deriveIndexFromContent parses the `## Promote` policy ONCE into
 * the derived index (→ stored in harness_plans.promote_policy by withPlanLock, mig 331), so the
 * consumers (lint / expand-generators / promote) read it structured instead of re-parsing the
 * markdown at read time. The parse itself + its fail-safe contract are pinned by promote-policy.test.ts;
 * this pins that the index CARRIES it.
 */
import { describe, it, expect } from 'vitest';
import { deriveIndexFromContent } from './source';

const PLAN_WITH_PROMOTE = `---
title: T
slug: s
status: ready
---

## Now
**State:** x

**Next:** y

## Promote
\`\`\`yaml
target_harness: foo
waves:
  - id: w1
    features:
      - title: "Do a thing"
\`\`\`
`;

const PLAN_NO_PROMOTE = `---
title: T
slug: s
status: ready
---

## Now
**State:** x

**Next:** y
`;

describe('P-001: deriveIndexFromContent populates promotePolicy (write-time parse)', () => {
  it('parses the `## Promote` policy into promotePolicy.policy', () => {
    const idx = deriveIndexFromContent(PLAN_WITH_PROMOTE);
    expect(idx.promotePolicy.policy).not.toBeNull();
    expect(idx.promotePolicy.policy?.target_harness).toBe('foo');
    expect(idx.promotePolicy.policy?.waves[0]?.id).toBe('w1');
    expect(idx.promotePolicy.warnings).toEqual([]);
  });

  it('yields { policy: null, warnings: [] } for a plan with no `## Promote` section', () => {
    const idx = deriveIndexFromContent(PLAN_NO_PROMOTE);
    expect(idx.promotePolicy).toEqual({ policy: null, warnings: [] });
  });

  it('surfaces malformed-policy warnings instead of throwing (fail-safe carried through the index)', () => {
    // schema-invalid (not YAML-invalid): a wave declaring neither features[] nor generate.
    const bad = PLAN_WITH_PROMOTE.replace('features:\n      - title: "Do a thing"', 'blocked_by: nope');
    const idx = deriveIndexFromContent(bad);
    // A malformed `## Promote` block parses to policy:null + warnings (never throws) — the index
    // carries the warnings so lint can surface them without re-parsing.
    expect(idx.promotePolicy.policy).toBeNull();
    expect(idx.promotePolicy.warnings.length).toBeGreaterThan(0);
  });
});
