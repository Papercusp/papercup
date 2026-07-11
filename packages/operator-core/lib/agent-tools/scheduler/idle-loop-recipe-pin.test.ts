/**
 * idle-loop-recipe-pin.test.ts — the P-006 idle-loop recipe RECURRENCE GUARD
 * (composable-event-awaits-2026-07-11).
 *
 * The recipe (an idle self-puller parks on ONE await over the canonical
 * work-item:claimable key — the P-007 dual-emit that collapses the original
 * work-item:created / claim:released:* / work-item:unblocked:* 3-leaf composed
 * spec — with the ~30-min on_timeout backstop, instead of a ~60s re-poll; the
 * pull stays the authoritative claim) lives on THREE prompt surfaces that
 * drift independently:
 *   1. scheduler:get_next's miss advice (IDLE_PULL_MISS_ADVICE — the point of need),
 *   2. DEFAULT_LOOP_WAKE_PROMPT_TEMPLATE (the loop wake's empty-wake step),
 *   3. the su prompts (papercusp-su-engineer.tools.md / papercusp-su-power.tools.md).
 * This test PINS all three: a future edit that drops the recipe (or renames an event
 * family out from under it) reds here instead of silently reviving the poll cadence.
 * Marker style over full-text equality: wording may be tightened freely; the recipe's
 * load-bearing parts (the three event families, the backstop, the authoritative-claim
 * rule, the no-timer-poll mandate) must survive.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

vi.mock('@papercusp/agent-mcp', () => ({
  defineTool: (def: unknown) => def,
  SU_ROLES: ['operator'],
}));
vi.mock('../coordination/roles', () => ({ COORD_ROLES: ['operator'] }));
vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => ({ ownerId: 'su-idle', ownerLabel: 'i', source: 'static-client', workspaceId: 'ws-x', userId: null }),
}));
vi.mock('@papercusp/flags', () => ({ FLAGS: { SCHEDULER_SPEC_CLAIM: 'scheduler_spec_claim' } }));
vi.mock('@papercusp/flags/server', () => ({ getFlag: vi.fn(async () => true) }));
vi.mock('../../scheduler/claim-spec-store', () => ({
  getNextForBee: vi.fn(async () => null),
  resolveClaimSpecWorkspace: (w: unknown) => w ?? 'default',
}));
vi.mock('../../work-items', () => ({ CLAIM_STATES_ALLOWLIST: ['todo', 'open', 'failing'] }));
vi.mock('../../routing-gate-hints', () => ({ matchRoutingGateHint: () => null }));

import getNext, { IDLE_PULL_MISS_ADVICE } from './get_next';
import { DEFAULT_LOOP_WAKE_PROMPT_TEMPLATE } from '../../harness/routines/loop';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '../../../../../');
const PROMPTS_DIR = join(REPO, 'apps/operator/prompts');

/** The load-bearing recipe markers a surface must carry to count as teaching it. */
const RECIPE_MARKERS = [
  'work-item:claimable', // the canonical P-007 dual-emit key — `when`-narrowable
  '1800', // the ~30-min on_timeout backstop
];

describe('P-006 idle-loop recipe pin (composable-event-awaits-2026-07-11)', () => {
  it('IDLE_PULL_MISS_ADVICE carries the full recipe: claimable key, backstop, hint-not-claim, re-register, no timer poll', () => {
    for (const m of RECIPE_MARKERS) expect(IDLE_PULL_MISS_ADVICE).toContain(m);
    expect(IDLE_PULL_MISS_ADVICE).toContain('events:await');
    expect(IDLE_PULL_MISS_ADVICE).toContain('AUTHORITATIVE');
    expect(IDLE_PULL_MISS_ADVICE).toContain('re-register');
    expect(IDLE_PULL_MISS_ADVICE).toMatch(/do NOT re-poll/i);
    expect(IDLE_PULL_MISS_ADVICE).toContain('END YOUR TURN');
  });

  it('a get_next MISS delivers the recipe as `advice` (the point-of-need surface)', async () => {
    const ctx = { workspaceId: 'ws-x' } as unknown as Parameters<typeof getNext.handler>[1];
    const res = (await getNext.handler({ harness: 'h' } as never, ctx)) as { content: Array<{ text: string }> };
    const out = JSON.parse(res.content[0].text);
    expect(out.ok).toBe(false);
    expect(out.advice).toBe(IDLE_PULL_MISS_ADVICE);
  });

  it('the default loop wake template parks an idle self-puller on the composed await (no empty-wake spinning)', () => {
    for (const m of RECIPE_MARKERS) expect(DEFAULT_LOOP_WAKE_PROMPT_TEMPLATE).toContain(m);
    expect(DEFAULT_LOOP_WAKE_PROMPT_TEMPLATE).toContain('events:await');
    expect(DEFAULT_LOOP_WAKE_PROMPT_TEMPLATE).toContain('authoritative claim');
  });

  for (const file of ['papercusp-su-engineer.tools.md', 'papercusp-su-power.tools.md']) {
    it(`${file} teaches the composed-await idle recipe (the su prompt surface)`, () => {
      const text = readFileSync(join(PROMPTS_DIR, file), 'utf8');
      for (const m of RECIPE_MARKERS) expect(text).toContain(m);
      expect(text).toContain('composable-event-awaits P-006');
      // The P-004 tree-management verbs stay discoverable next to the recipe.
      expect(text).toContain('composed_awaits');
      expect(text).toContain('root_id');
      // The authoritative-claim rule (wake = hint, pull = claim) must survive rewording.
      expect(text).toMatch(/authoritative claim/i);
    });
  }
});
