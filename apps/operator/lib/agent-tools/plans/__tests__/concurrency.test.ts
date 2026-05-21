/**
 * Concurrency test for plans:* write verbs.
 *
 * Per agent-plan-tracking-2026-05-20.md §4.4 + P-206: two parallel
 * calls that allocate IDs against the same plan MUST produce
 * sequential non-colliding IDs. The lock around read-modify-write is
 * the load-bearing piece.
 *
 * Prereqs (same as the locks/__tests__/su-lock-store.test.ts suite):
 *   - Embedded PG reachable.
 *   - `harness_admin` role has CREATEDB.
 *
 * The test runs against a temp plans directory so it doesn't disturb
 * the canonical apps/operator/docs/plans/ tree.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ensureBootstrap, _resetForTests } from '../../locks/su-lock-store';
import { withPlanLock } from '../with-plan-lock';
import { allocateNextDecisionId, appendDecisionToBody } from '../add-decision';
import { allocateNextItemId, appendItemToBody, buildItemLine } from '../add-item';

const SUITE = `plans-conc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const FAKE_CTX = {
  principal: null,
  isSuperuser: true,
  uiClientId: '11111111-1111-4111-8111-111111111111',
};

let tmpRoot: string;

beforeAll(async () => {
  await ensureBootstrap();
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'plans-test-'));
  // Create a plans/ dir under the tmp root the same way the real repo does.
  await fs.mkdir(path.join(tmpRoot, 'apps', 'operator', 'docs', 'plans'), { recursive: true });
});

afterAll(async () => {
  if (tmpRoot) {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

async function seedPlan(slug: string): Promise<void> {
  const fp = path.join(tmpRoot, 'apps', 'operator', 'docs', 'plans', slug + '.md');
  const body = `---
title: ${slug}
slug: ${slug}
status: active
created: 2026-05-20
updated: 2026-05-20
---

# ${slug}

## Now

**State:** test
**Next:** test

## Phase 1

- **P-001** \`done\` seed item

## Decisions

### D-001 — seed decision
Date: 2026-05-20
seed body
`;
  await fs.writeFile(fp, body, 'utf8');
}

/** Result payload for the test mutators — passed as the explicit
 *  `withPlanLock<T>` type argument so `T` is fixed, not inferred from
 *  the union-returning mutator (which TS would narrow to one branch). */
type LockTestValue = { ok: true; id: string } | { ok: false };

describe('plans:* concurrent ID allocation', () => {
  it('two parallel add-decision calls produce sequential non-colliding D-NNN', async () => {
    const slug = `${SUITE}-decisions`;
    await seedPlan(slug);

    const opA = withPlanLock<LockTestValue>(
      FAKE_CTX,
      { slug, intent: 'add-decision A', repoRoot: tmpRoot, ttlSec: 30 },
      async (current) => {
        if (current === null) return { newBody: null, value: { ok: false as const } };
        // Simulate the same RMW the real tool does.
        const id = allocateNextDecisionId(current);
        const next = appendDecisionToBody(current, id, 'A', 'body A', '2026-05-20', []);
        return { newBody: next, value: { ok: true as const, id } };
      },
    );

    const opB = withPlanLock<LockTestValue>(
      FAKE_CTX,
      { slug, intent: 'add-decision B', repoRoot: tmpRoot, ttlSec: 30 },
      async (current) => {
        if (current === null) return { newBody: null, value: { ok: false as const } };
        const id = allocateNextDecisionId(current);
        const next = appendDecisionToBody(current, id, 'B', 'body B', '2026-05-20', []);
        return { newBody: next, value: { ok: true as const, id } };
      },
    );

    const [resA, resB] = await Promise.all([opA, opB]);

    // Both should succeed (one was queued behind the other on the lock).
    expect(resA.kind).toBe('applied');
    expect(resB.kind).toBe('applied');
    if (resA.kind !== 'applied' || resB.kind !== 'applied') return;
    expect(resA.value.ok).toBe(true);
    expect(resB.value.ok).toBe(true);
    if (!resA.value.ok || !resB.value.ok) return;

    const ids = [resA.value.id, resB.value.id].sort();
    expect(ids).toEqual(['D-002', 'D-003']);

    const finalBody = await fs.readFile(
      path.join(tmpRoot, 'apps', 'operator', 'docs', 'plans', slug + '.md'),
      'utf8',
    );
    expect(finalBody).toContain('### D-002');
    expect(finalBody).toContain('### D-003');
  }, 60_000);

  it('two parallel add-item calls produce sequential non-colliding P-NNN', async () => {
    const slug = `${SUITE}-items`;
    await seedPlan(slug);

    const op = (label: string) =>
      withPlanLock<LockTestValue>(
        FAKE_CTX,
        { slug, intent: `add-item ${label}`, repoRoot: tmpRoot, ttlSec: 30 },
        async (current) => {
          if (current === null) return { newBody: null, value: { ok: false as const } };
          const id = allocateNextItemId(current);
          const line = buildItemLine(id, `item ${label}`, []);
          const { newBody } = appendItemToBody(current, 'Phase 1', line);
          return { newBody, value: { ok: true as const, id } };
        },
      );

    const [resA, resB] = await Promise.all([op('A'), op('B')]);

    expect(resA.kind).toBe('applied');
    expect(resB.kind).toBe('applied');
    if (resA.kind !== 'applied' || resB.kind !== 'applied') return;
    if (!resA.value.ok || !resB.value.ok) return;

    const ids = [resA.value.id, resB.value.id].sort();
    // Seed had P-001 (item) + D-001 (decision). allocateNextItemId
    // scans for ALL P-NNN tokens, so it should return P-002, P-003.
    expect(ids).toEqual(['P-002', 'P-003']);
  }, 60_000);
});
