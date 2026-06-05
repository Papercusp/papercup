import { describe, it, expect } from 'vitest';
import { gymRunIdentity, type GymRunKey } from '../run-identity';

/**
 * The run identity is the spine of hermetic isolation: every (task × variant ×
 * cycle) gets its own throwaway harness (→ its own `harness_<slug>` PG schema),
 * its own filed feature, and its own substrate clone dir. The slug must be safe
 * to splice into a PG schema name, gym-prefixed so the gym-operator's autoloop
 * scope (`PAPERCUSP_DBOS_ORCHESTRATOR_HARNESSES`) can match it, and collision-free
 * across distinct run keys.
 */
describe('gymRunIdentity', () => {
  const key: GymRunKey = { taskId: 'task-alpha', variantId: 'variant-baseline', cycle: 0 };

  it('is deterministic — same key yields the same identity', () => {
    expect(gymRunIdentity(key)).toEqual(gymRunIdentity({ ...key }));
  });

  it('produces a gym-prefixed, PG-schema-safe harness slug', () => {
    const { harnessSlug } = gymRunIdentity(key);
    expect(harnessSlug).toMatch(/^gym[a-z0-9]+$/); // hyphen-free (valid unquoted PG schema)
    // `harness_<slug>` is spliced into a PG schema name; PG identifiers cap at 63.
    expect(`harness_${harnessSlug}`.length).toBeLessThanOrEqual(63);
  });

  it('produces an F-GYM- shaped feature id derived from the task', () => {
    const { featureId } = gymRunIdentity(key);
    expect(featureId).toMatch(/^F-GYM-[A-Z0-9]+$/);
    // Feature id depends only on the task, not the variant/cycle (one synthetic
    // feature per task; the throwaway harness is what differs per variant/cycle).
    const other = gymRunIdentity({ taskId: 'task-alpha', variantId: 'variant-candidate', cycle: 3 });
    expect(other.featureId).toBe(featureId);
  });

  it('gives a filesystem-safe clone dir name unique to the run', () => {
    const { cloneDirName, harnessSlug } = gymRunIdentity(key);
    expect(cloneDirName).toMatch(/^[a-z0-9-]+$/);
    expect(cloneDirName).toBe(harnessSlug);
  });

  it('yields distinct slugs when any component of the key differs', () => {
    const slugs = new Set(
      [
        { taskId: 'task-alpha', variantId: 'variant-baseline', cycle: 0 },
        { taskId: 'task-beta', variantId: 'variant-baseline', cycle: 0 },
        { taskId: 'task-alpha', variantId: 'variant-candidate', cycle: 0 },
        { taskId: 'task-alpha', variantId: 'variant-baseline', cycle: 1 },
      ].map((k) => gymRunIdentity(k).harnessSlug),
    );
    expect(slugs.size).toBe(4);
  });

  it('treats repeat as part of the identity (P-014 variance): distinct slugs per repeat; repeat 0 == no repeat', () => {
    const base = gymRunIdentity({ taskId: 'task-alpha', variantId: 'variant-baseline', cycle: 0 });
    const r0 = gymRunIdentity({ taskId: 'task-alpha', variantId: 'variant-baseline', cycle: 0, repeat: 0 });
    const r1 = gymRunIdentity({ taskId: 'task-alpha', variantId: 'variant-baseline', cycle: 0, repeat: 1 });
    const r2 = gymRunIdentity({ taskId: 'task-alpha', variantId: 'variant-baseline', cycle: 0, repeat: 2 });
    // repeat 0 / undefined resolve identically — back-compat: existing slugs unchanged.
    expect(r0.harnessSlug).toBe(base.harnessSlug);
    // distinct repeats → distinct slugs (so each variance run gets its own schema + clone).
    expect(new Set([base.harnessSlug, r1.harnessSlug, r2.harnessSlug]).size).toBe(3);
    // feature id stays task-derived (stable across repeats; each repeat is its own harness).
    expect(r1.featureId).toBe(base.featureId);
    expect(r1.harnessSlug).toMatch(/^gym[a-z0-9]+$/);
  });

  it('sanitizes unsafe characters in the key into a safe slug', () => {
    const { harnessSlug } = gymRunIdentity({
      taskId: 'Repo/Path With Spaces!!',
      variantId: 'UPPER_Case变体',
      cycle: 2,
    });
    expect(harnessSlug).toMatch(/^gym[a-z0-9]+$/); // hyphen-free (valid unquoted PG schema)
    expect(`harness_${harnessSlug}`.length).toBeLessThanOrEqual(63);
  });
});
