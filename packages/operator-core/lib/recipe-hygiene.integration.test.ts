/**
 * recipe-hygiene.integration.test.ts — the weekly code-recipes hygiene pass
 * (recipes-reuse-activation-2026-06-22 P-003) against real Postgres. Asserts the sweep
 * retires a stale never-reused one-off while leaving a hot recipe active, and that the
 * pass surfaces the graduation worklist counts (so the scheduled routine has something
 * to log).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrgTestDb } from '../test/_org-test-db';
import { upsertRecipe, recordRecipeRun, getRecipe } from './code-recipes-store';
import { runRecipeHygieneOnce } from './recipe-hygiene';
import type { CaptureImprovementInput, CaptureImprovementResult } from './harness/improvements/capture-core';

const { createOrgTestDb } = await import('../test/_org-test-db');

describe('runRecipeHygieneOnce (real PG)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it('retires a stale never-reused one-off, leaves a hot recipe active, surfaces the worklist', async () => {
    const ws = 'ws-hygiene';

    // STALE one-off: run once, then backdate last_run_at past the 30d window so the
    // conservative default sweep (run_count<=1 AND last_run older than 30d) retires it.
    await upsertRecipe(db.adminSql, {
      potSlug: null,
      id: 'stale-oneoff-recipe',
      title: 'Stale one-off',
      description: 'run once, never reused',
      script: 's',
      toolsUsed: ['plans:list'],
    });
    await recordRecipeRun(db.adminSql, {
      recipeId: 'stale-oneoff-recipe', workspaceId: ws, potSlug: 'alpha', agentOwner: 'a', success: true,
    });
    await db.adminSql`UPDATE harness_shared.code_recipes SET last_run_at = now() - interval '40 days' WHERE id = 'stale-oneoff-recipe'`;

    // HOT recipe: several recent runs across distinct agents — must NOT be swept.
    await upsertRecipe(db.adminSql, {
      potSlug: null,
      id: 'hot-recipe',
      title: 'Hot recipe',
      description: 'reused a lot',
      script: 's',
      toolsUsed: ['work_items:list', 'work_items:set_state'],
    });
    for (const agent of ['a', 'b', 'c']) {
      await recordRecipeRun(db.adminSql, {
        recipeId: 'hot-recipe', workspaceId: ws, potSlug: 'alpha', agentOwner: agent, success: true,
      });
    }

    const r = await runRecipeHygieneOnce(db.adminSql);

    // the stale one-off was retired (reversible status flip) …
    expect(r.sweptIds).toContain('stale-oneoff-recipe');
    expect((await getRecipe(db.adminSql, 'stale-oneoff-recipe'))?.status).toBe('retired');

    // … the hot recipe was left ACTIVE (never sweep a reused recipe) …
    expect(r.sweptIds).not.toContain('hot-recipe');
    expect((await getRecipe(db.adminSql, 'hot-recipe'))?.status).toBe('active');

    // … and the graduation worklist counts are surfaced for the scheduled log.
    expect(typeof r.promoteCandidates).toBe('number');
    expect(r.promoteCandidates).toBeGreaterThanOrEqual(0);
    expect(typeof r.mergeClusters).toBe('number');
    expect(r.mergeClusters).toBeGreaterThanOrEqual(0);

    // The promotion leg is OFF unless a filing seam is wired — and reports that as
    // null, never as a zero that would read like "it ran and found nothing".
    expect(r.sequences).toBeNull();
  });

  /**
   * The loop-closing leg, end to end against real SQL (okf-frontmatter §D): a
   * repeated cross-agent tool dance recorded in `tool_invocations` becomes a filed
   * work-item with no human between the two.
   *
   * Worth doing at integration level rather than with a fake `sql`: the mining
   * query carries the provenance filter and the workspace discovery is a real
   * window function, and both are exactly the parts a unit test would stub out.
   */
  it('files a work-item for a persistent cross-agent tool dance — no human in the loop', async () => {
    const ws = 'ws-sequences';
    const DAY = 24 * 3600_000;
    const now = Date.now();

    let n = 0;
    const invoke = async (agent: string, tool: string, at: number) => {
      await db.adminSql`
        INSERT INTO harness_shared.tool_invocations
          (workspace_id, harness_slug, plugin_name, tool_name, role, spawn_id, window_key,
           invoked_at, status, transport, coord_owner_id)
        VALUES (${ws}, ${'seqharness'}, ${'agentmcp'}, ${tool}, ${'su'}, ${`sp-${n++}`}, ${'w'},
                ${new Date(at).toISOString()}::timestamptz, 'ok', 'mcp', ${agent})
      `;
    };

    // A dance performed by 3 agents in each of the last 5 daily windows: it clears
    // the cohort/occurrence floors AND persists, so it graduates.
    for (let d = 0; d < 5; d++) {
      const base = now - (d + 0.5) * DAY;
      for (const agent of ['sq-a', 'sq-b', 'sq-c']) {
        for (let rep = 0; rep < 2; rep++) {
          const t0 = base + rep * 10 * 60_000;
          await invoke(agent, 'seq:alpha', t0);
          await invoke(agent, 'seq:beta', t0 + 3_000);
          await invoke(agent, 'seq:gamma', t0 + 6_000);
        }
      }
    }
    // Background traffic, so the lift marginals are not degenerate.
    for (let d = 0; d < 7; d++) {
      const base = now - (d + 0.8) * DAY;
      for (const agent of ['sq-a', 'sq-b', 'sq-c', 'sq-d']) {
        for (let rep = 0; rep < 8; rep++) {
          const t0 = base + rep * 7 * 60_000;
          await invoke(agent, 'noise:x', t0);
          await invoke(agent, 'noise:y', t0 + 2_000);
        }
      }
    }

    const filings: CaptureImprovementInput[] = [];
    const r = await runRecipeHygieneOnce(db.adminSql, {
      sequenceDeps: {
        capture: async (input) => {
          filings.push(input);
          return { ok: true, created: true, possibleDuplicates: [] } as CaptureImprovementResult;
        },
      },
      // Floors sized for THIS fixture; the shipped defaults assume fleet volume.
      sequenceOpts: { windows: 7, windowHours: 24, minStreak: 3, minOccurrences: 4, minAgents: 3, minLift: 2, minWorkspaceRows: 10 },
    });

    expect(r.sequenceError).toBeUndefined();
    expect(r.sequences).not.toBeNull();
    // Discovery found the workspace from the DATA — nothing was configured.
    expect(r.sequences!.targets.map((t) => t.workspaceId)).toContain(ws);

    const filed = filings.find((f) => f.title.includes('seq:alpha'));
    expect(filed, `expected a filing for the dance; got ${JSON.stringify(filings.map((f) => f.title))}`).toBeDefined();
    expect(filed!.body).toContain('seq:beta');
    // Scoped to the harness the traffic belongs to, or no agent could claim it.
    expect(filed!.scope).toBe('harness:seqharness');
    // And carrying the stable coalesce key, so next week's sweep updates instead of duplicating.
    expect(filed!.watchdogKey).toMatch(/^tool-sequence-graduation:/);
    expect(filed!.dedupScope).toBe('open');
  }, 120_000);
});
