/**
 * WI-6554700010008492 / verification-system-improvements-2026-10-10#D-041, #D-042.
 *
 * The blind gap reviewer is confined to an exact tool ceiling. These tests pin three things:
 *   1. every ceiling entry names a real tool (a dead name grants nothing and reads like coverage);
 *   2. no ceiling entry belongs to a family that returns plan text, except the door itself;
 *   3. the mint launches under the system actor with the confinement attached under the
 *      launcher's symbol, so the dispatch seat sees it before the process starts.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { evaluateSessionConfinement } from './capability-envelope/session-confinement';
import type { BlindReviewBrief } from './blind-review-brief';
import { BLIND_REVIEW_TOOL } from './blind-review-gate';
import {
  BLIND_GAP_REVIEW_ACTOR,
  BLIND_REVIEWER_TOOL_CEILING,
  blindReviewerConfinement,
  buildBlindReviewerKickoff,
  mintBlindGapReviewer,
} from './blind-reviewer-mint';

const REPO = resolve(__dirname, '../../..');

/** Static discovery, as in capability-envelope/session-confinement.test.ts: importing the
 * registry would pull ~950 modules with side effects into a unit test. Accepts both quote
 * styles because some definitions (dev:service_health) use double quotes. */
function discoverToolNames(): Set<string> {
  const names = new Set<string>();
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.endsWith('.ts') || entry.includes('.test.') || entry.startsWith('index.')) continue;
      const src = readFileSync(full, 'utf8');
      if (!src.includes('defineTool(')) continue;
      for (const m of src.matchAll(/\bname:\s*['"]([^'"]+)['"]/g)) {
        if (m[1].includes(':')) names.add(m[1]);
      }
    }
  };
  walk(join(REPO, 'packages/agent-mcp/src/tools'));
  walk(join(REPO, 'packages/operator-core/lib/agent-tools'));
  return names;
}

/** Families whose tools return plan, rubric, evidence, or plan-derived text. */
const PLAN_TEXT_FAMILIES = [
  'plans', 'rubrics', 'scorecards', 'acceptance', 'search', 'sessions', 'memory',
  'work_items', 'cross_harness', 'docs', 'facts', 'orders', 'reports',
];

const SLUG = 'demo-plan-2026-10-11';
const CONFINEMENT = blindReviewerConfinement(SLUG);
const evaluate = (toolName: string) => evaluateSessionConfinement({ toolName, confinement: CONFINEMENT });

const BRIEF: BlindReviewBrief = {
  planSlug: SLUG,
  activationAuditSeq: 7,
  ownerTurns: [{ ref: 'claude:s1:3', text: 'Make the export button produce a CSV.' }],
  excludedRefs: [],
  text: 'Owner turn claude:s1:3:\nMake the export button produce a CSV.',
};

describe('blind reviewer tool ceiling — catalog truth', () => {
  const CATALOG = discoverToolNames();

  it('calibration: the static walk finds a real catalog, including double-quoted names', () => {
    expect(CATALOG.size).toBeGreaterThan(500);
    for (const control of ['plans:get', 'rubrics:get', 'work_items:complete', 'dev:service_health']) {
      expect(CATALOG.has(control), `control tool missing from walk: ${control}`).toBe(true);
    }
  });

  it('every ceiling entry names a tool that exists', () => {
    const dead = BLIND_REVIEWER_TOOL_CEILING.filter((name) => !CATALOG.has(name));
    expect(dead, `ceiling entries that resolve to no tool: ${dead.join(', ')}`).toEqual([]);
  });

  it('the ceiling holds no glob: denyOutside matches exact names only', () => {
    expect(BLIND_REVIEWER_TOOL_CEILING.filter((name) => name.includes('*'))).toEqual([]);
  });

  it('no ceiling entry is a plan-text family, except the door itself', () => {
    const leaks = BLIND_REVIEWER_TOOL_CEILING.filter(
      (name) => name !== BLIND_REVIEW_TOOL && PLAN_TEXT_FAMILIES.includes(name.split(':')[0]),
    );
    expect(leaks).toEqual([]);
    expect(BLIND_REVIEWER_TOOL_CEILING).toContain(BLIND_REVIEW_TOOL);
  });
});

describe('blind reviewer confinement — gate decisions', () => {
  it('refuses the plan-artifact reads the reviewer must not see', () => {
    for (const tool of [
      'plans:get', 'plans:get-specs', 'plans:get-spec-evidence', 'plans:items', 'plans:search',
      'rubrics:get', 'scorecards:list', 'search:semantic', 'search:fulltext', 'sessions:search',
      'sessions:read', 'memory:search', 'work_items:get', 'cross_harness:plans_get', 'coord:feed',
    ]) {
      const decision = evaluate(tool);
      expect(decision.allowed, `${tool} must be refused`).toBe(false);
      expect(decision.applied).toBe(true);
      expect(decision.matchedGlob).toBe('outside-exact-ceiling');
    }
  });

  it('refuses a mangled client spelling of a refused tool', () => {
    expect(evaluate('mcp__papercusp-su__plans_get').allowed).toBe(false);
  });

  it('refuses a tool registered after the ceiling was written', () => {
    expect(evaluate('plans:some-future-reader').allowed).toBe(false);
  });

  it('allows the door and every other ceiling entry', () => {
    for (const tool of BLIND_REVIEWER_TOOL_CEILING) {
      expect(evaluate(tool).allowed, `${tool} must be allowed`).toBe(true);
    }
  });

  it('names the imposer and the plan in a refusal', () => {
    const decision = evaluate('plans:get');
    expect(decision.reason).toContain(BLIND_GAP_REVIEW_ACTOR);
    expect(decision.reason).toContain(SLUG);
  });

  it('suppresses ambient context, which also carries plan text', () => {
    expect(CONFINEMENT.denyAmbientContext).toBe(true);
    expect(Object.isFrozen(CONFINEMENT)).toBe(true);
    expect(Object.isFrozen(BLIND_REVIEWER_TOOL_CEILING)).toBe(true);
  });
});

describe('buildBlindReviewerKickoff', () => {
  it('carries the owner words, the run hint and the post call, and no plan text', () => {
    const kickoff = buildBlindReviewerKickoff(BRIEF, 'Boot it with scripts/verify-tauri-headless.sh');
    expect(kickoff).toContain('Make the export button produce a CSV.');
    expect(kickoff).toContain('Boot it with scripts/verify-tauri-headless.sh');
    expect(kickoff).toContain(`${BLIND_REVIEW_TOOL} { op: 'post', slug: '${SLUG}'`);
  });

  it('falls back to a discovery hint when no run hint is given', () => {
    expect(buildBlindReviewerKickoff(BRIEF, '  ')).toContain('dev:service_health');
    expect(buildBlindReviewerKickoff(BRIEF)).toContain('dev:service_health');
  });
});

describe('mintBlindGapReviewer', () => {
  const KEY = Symbol('test-confinement-key');

  function deps(brief: BlindReviewBrief | null = BRIEF) {
    const handler = vi.fn(async () => ({ ok: true, ownerId: 'su-reviewer-1' }));
    const loadBrief = vi.fn(async () => brief);
    return { handler, loadBrief, deps: { loadBrief, launcher: async () => ({ handler, confinementKey: KEY }) } };
  }

  it('launches headless under the system actor with the confinement on the launcher key', async () => {
    const d = deps();
    const result = await mintBlindGapReviewer(
      { slug: SLUG, harness: 'papercusp', howToRun: 'run it', ctx: { workspaceId: 'ws-1', ownerId: 'su-author', isSuperuser: true } },
      d.deps,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.activationAuditSeq).toBe(7);
    expect(d.loadBrief).toHaveBeenCalledWith({ workspaceId: 'ws-1', planSlug: SLUG, harnessSlug: 'papercusp' });
    expect(d.handler).toHaveBeenCalledTimes(1);
    const [args, ctx] = d.handler.mock.calls[0] as unknown as [Record<string, unknown>, Record<PropertyKey, unknown>];
    expect(args).toEqual({ brief: result.kickoff, harness: 'papercusp', headless: true });
    // The caller's identity must not leak into the launch: the door rejects the author's lineage.
    expect(ctx.ownerId).toBe(BLIND_GAP_REVIEW_ACTOR);
    expect(ctx.isSuperuser).toBe(false);
    expect(ctx.principal).toEqual({ kind: 'system', slug: BLIND_GAP_REVIEW_ACTOR, workspaceId: 'ws-1' });
    expect(ctx[KEY]).toEqual(blindReviewerConfinement(SLUG));
  });

  it('refuses without a concrete workspace and loads nothing', async () => {
    for (const workspaceId of [undefined, '', '*']) {
      const d = deps();
      const result = await mintBlindGapReviewer({ slug: SLUG, harness: 'papercusp', ctx: { workspaceId } }, d.deps);
      expect(result).toMatchObject({ ok: false, code: 'workspace_required' });
      expect(d.loadBrief).not.toHaveBeenCalled();
      expect(d.handler).not.toHaveBeenCalled();
    }
  });

  it('refuses a plan with no activation audit and launches nothing', async () => {
    const d = deps(null);
    const result = await mintBlindGapReviewer({ slug: SLUG, harness: 'papercusp', ctx: { workspaceId: 'ws-1' } }, d.deps);
    expect(result).toMatchObject({ ok: false, code: 'no_activation_audit' });
    expect(d.handler).not.toHaveBeenCalled();
  });
});
