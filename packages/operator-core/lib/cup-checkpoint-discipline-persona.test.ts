/**
 * cup-checkpoint-discipline-persona.test.ts — bee/cup checkpoint discipline
 * anti-drift guard (autonomous-loop-prod-audit-2026-07-02 P-008 / D-001, WI-4628).
 *
 * The canonical cup ("bee") persona (`blueprints/base/prompts/cup.base.md`) is prompt
 * TEXT, not runtime code — there is no compiler that enforces an LLM actually calls
 * `work_items:checkpoint` at the right moments, so the persona wording IS the contract
 * (same rationale as kettle-scorecard-persona.test.ts's B7 guard). Before this WI the
 * persona only instructed a checkpoint at three CLEAN, end-of-turn boundaries (task
 * completion / task boundary / graceful evict) — a cup mid a long or risky operation
 * that never reaches one of those boundaries had no instruction to checkpoint, so a
 * hard kill (SIGTERM) lost everything since the last one. This guard pins the fourth,
 * PRE-risk boundary so a future edit can't quietly drop it back to three.
 *
 * Root-cause context (the plan's D-001): a checkpoint write bumps the work-item's
 * `last_progress_at` (work-item-checkpoint.ts's bumpCheckpointProgressAnchor) — a
 * checkpoint IS progress, so a checkpointing cup's claim never reads as stalled to the
 * reclaim sweep (work-items-stale-claims.ts's STALLED leg). That plumbing is covered by
 * work-item-checkpoint.integration.test.ts; THIS test pins the prompt-level half: the
 * cup is actually TOLD to checkpoint before a risky/long step, not just at the end.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { harnessPath } from './harness-paths';

const CANONICAL = harnessPath('blueprints', 'base', 'prompts', 'cup.base.md');

describe('cup ("bee") persona — checkpoint discipline (D-001)', () => {
  const persona = readFileSync(CANONICAL, 'utf8');

  it('still instructs the three clean end-of-turn boundaries', () => {
    expect(persona).toMatch(/\*\*Task completion\*\*/);
    expect(persona).toMatch(/\*\*Task boundary\*\*/);
    expect(persona).toMatch(/\*\*Graceful evict\*\*/);
  });

  it('ALSO instructs a checkpoint BEFORE a risky or long-running step — not just at the end', () => {
    // The fourth boundary this WI adds: a PRE-emptive checkpoint ahead of a step that
    // might run long or fail destructively, distinct from the three reactive/clean ones.
    expect(persona).toMatch(/\*\*Before a risky or long step/i);
    expect(persona).toMatch(/write a checkpoint FIRST/i);
  });

  it('explains WHY a pre-risk checkpoint matters: progress anchor + no eviction warning on a hard kill', () => {
    // (a) checkpoint-is-progress — ties directly to the stale-claim reclaim sweep so a
    // live, checkpointing cup is never misread as stalled.
    expect(persona).toMatch(/bumps the\s+work-item's progress anchor/i);
    expect(persona).toMatch(/stalled/i);
    // (b) a hard SIGTERM gives no graceful-evict warning — the whole reason "wait until
    // graceful-evict" is not sufficient and a PRE-step checkpoint is needed instead.
    expect(persona).toMatch(/SIGTERM/);
    expect(persona).toMatch(/won't always get a graceful-evict warning/i);
  });

  it('the top-level checkpoint summary and the Don\'t section both mention the pre-risk case (no drift between the two mentions)', () => {
    // The lead-in paragraph under "## End of turn" and the "## Don't" reminder must both
    // carry the updated discipline, not just one of the two copies.
    const endOfTurnIdx = persona.indexOf('## End of turn');
    const dontIdx = persona.indexOf('## Don\'t');
    expect(endOfTurnIdx).toBeGreaterThan(-1);
    expect(dontIdx).toBeGreaterThan(endOfTurnIdx);

    const leadIn = persona.slice(endOfTurnIdx, persona.indexOf('### When to write a carry-note'));
    expect(leadIn).toMatch(/before a risky or long-running step/i);

    const dontSection = persona.slice(dontIdx);
    expect(dontSection).toMatch(/before a\s+risky or long-running step/i);
  });

  it('keeps the carry-note write call + work-item-scoped store reference intact', () => {
    // Unrelated-regression guard: this WI only ADDS a boundary, it must not disturb the
    // existing mechanics (the tool call shape + D-002/D-003 store reference).
    expect(persona).toContain('work_items:checkpoint { id: <work-item-id>, checkpoint:');
    expect(persona).toMatch(/D-002\/D-003/);
  });
});
