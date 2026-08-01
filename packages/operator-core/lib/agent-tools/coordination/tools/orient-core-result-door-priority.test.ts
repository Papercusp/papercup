/**
 * orient-core-result-door-priority.test.ts — EI-18689334534773965 regression.
 *
 * coord:orient's whole value proposition is "bootstrap in ONE round-trip":
 * assignments (`me`), the claimable backlog, and the inbox summary. Those
 * arrived at assembleOrientOutput bundled inside `result`, spread in DEAD
 * LAST — behind ownerDirectives / modes / instructionPrecedence / ideate /
 * captureMiss / configIntegrity / codexLocks / taskToolSchemaPack. Any one of
 * those preamble legs being large enough (a real taskToolSchemaPack + a real
 * instructionPrecedence trace routinely are) starves `me`/`claimable`/`inbox`
 * entirely once result-door.ts caps the serialized text — degrading the
 * advertised one-call bootstrap into several follow-up calls
 * (fleet:assignments, work_items:list, coord:inbox) to reconstruct exactly
 * what orient was supposed to hand over, on the turn (often
 * post-compaction) an agent has the least spare context to even notice the
 * gap.
 *
 * This exercises the real `assembleOrientOutput` + the real `applyResultDoor`
 * — proving `ok`/`me`/`claimable`/`inbox` survive the door even when every
 * discretionary preamble leg is individually large enough to exceed the
 * whole budget on its own, and that `recovery` still outranks them.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/coordination/tools/orient-core-result-door-priority.test.ts
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHARS_PER_TOKEN_ESTIMATE } from '../../../context-doors';

// Same PG-free door-config stub pattern as result-door.test.ts.
const { doorConstantsMock } = vi.hoisted(() => ({ doorConstantsMock: vi.fn() }));
vi.mock('../../../context-doors-config', () => ({ getDoorConstantsSync: doorConstantsMock }));

import { BAKED_DOOR_CONSTANTS } from '../../../context-doors';
import { applyResultDoor, RESULT_DOOR_TOKENS } from '../../../result-door';
import { assembleOrientOutput } from './orient';

const BUDGET_CHARS = RESULT_DOOR_TOKENS * CHARS_PER_TOKEN_ESTIMATE;

let sandbox: string;
let prevScratchRoot: string | undefined;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'papercusp-orient-core-result-door-test-'));
  prevScratchRoot = process.env.PAPERCUSP_SCRATCH_ROOT;
  process.env.PAPERCUSP_SCRATCH_ROOT = join(sandbox, 'scratch');
  doorConstantsMock.mockReset();
  doorConstantsMock.mockReturnValue(BAKED_DOOR_CONSTANTS);
});

afterEach(() => {
  if (prevScratchRoot === undefined) delete process.env.PAPERCUSP_SCRATCH_ROOT;
  else process.env.PAPERCUSP_SCRATCH_ROOT = prevScratchRoot;
  rmSync(sandbox, { recursive: true, force: true });
});

/** Every discretionary preamble leg blown up well past the WHOLE door budget
 *  on its own — a real taskToolSchemaPack (tool descriptions + arg schemas)
 *  and a real instructionPrecedence trace (decisions + suppressed + reasons)
 *  both routinely reach this size. */
function bigPreamble(marker: string) {
  const filler = (n: number) => `${marker}-filler-`.repeat(Math.ceil(n / 16)).slice(0, n);
  return {
    ownerDirectives: filler(BUDGET_CHARS),
    modes: { active: filler(BUDGET_CHARS / 4) },
    instructionPrecedence: { blob: filler(BUDGET_CHARS) },
    ideate: { blob: filler(BUDGET_CHARS / 2) },
    captureMiss: { blob: filler(BUDGET_CHARS / 4) },
    configIntegrity: { blob: filler(BUDGET_CHARS / 4) },
    codexLocks: { blob: filler(BUDGET_CHARS / 4) },
    taskToolSchemaPack: { blob: filler(BUDGET_CHARS) },
  };
}

const ME_MARKER = 'EI-18689334534773965-ME-CANARY';
const CLAIMABLE_MARKER = 'EI-18689334534773965-CLAIMABLE-CANARY';
const INBOX_MARKER = 'EI-18689334534773965-INBOX-CANARY';

function doorify(out: Record<string, unknown>) {
  return applyResultDoor(
    { content: [{ type: 'text' as const, text: JSON.stringify(out) }] },
    { toolName: 'coord:orient', workspaceId: 'ws-1', runId: '11111111-2222-4333-8444-555555555556' },
  );
}

describe('EI-18689334534773965: coord:orient core result (me/claimable/inbox) survives the result-door under a large preamble', () => {
  it('ok/me/claimable/inbox are present in the KEPT (in-context) text, not only the spill', () => {
    const out = assembleOrientOutput({
      self: { ownerId: 'su-test' },
      result: {
        ok: true,
        me: ME_MARKER,
        claimable: [{ id: CLAIMABLE_MARKER, title: 'a claimable bug' }],
        inbox: { summary: { unread: 1 }, recent: [{ summary: INBOX_MARKER }] },
        // discretionary result-tail legs — these are the ones allowed to spill.
        memory: { query: 'x', hits: ['DISCRETIONARY-TAIL-SHOULD-SPILL'.repeat(200)] },
      },
      ...bigPreamble('preamble'),
    });

    const doored = doorify(out);
    expect(doored.content).toHaveLength(2); // truncation DID occur — a meaningful test of the door
    const kept = (doored.content[0] as { text: string }).text;
    expect(kept.length).toBeLessThanOrEqual(BUDGET_CHARS);

    // The whole point of orient: the core mandate result must be IN-CONTEXT,
    // not merely recoverable via follow-up calls.
    expect(kept).toContain(ME_MARKER);
    expect(kept).toContain(CLAIMABLE_MARKER);
    expect(kept).toContain(INBOX_MARKER);
  });

  it('recovery still outranks the core result when both are present', () => {
    const RECOVERY_MARKER = 'EI-18689334534773965-RECOVERY-CANARY';
    const out = assembleOrientOutput({
      self: { ownerId: 'su-test' },
      recovery: { checkpoints: [{ id: RECOVERY_MARKER }], blob: 'x'.repeat(BUDGET_CHARS) },
      result: { ok: true, me: ME_MARKER, claimable: [], inbox: { summary: {}, recent: [] } },
      ...bigPreamble('preamble'),
    });

    const doored = doorify(out);
    const kept = (doored.content[0] as { text: string }).text;
    // recovery is genuinely unrecoverable any other way, so it wins the race
    // when it alone is large enough to consume the whole budget.
    expect(kept).toContain(RECOVERY_MARKER);
  });

  it('regression guard: with the core result spread LAST (the pre-fix shape), the canaries are lost to the spill', () => {
    // Mirrors the pre-fix key order (me/claimable/inbox bundled inside
    // `result`, spread dead last behind every preamble leg) to prove this
    // suite actually discriminates the bug.
    const preamble = bigPreamble('preamble');
    const preFixOrder = {
      self: { ownerId: 'su-test' },
      ownerDirectives: preamble.ownerDirectives,
      modes: preamble.modes,
      instructionPrecedence: preamble.instructionPrecedence,
      ideate: preamble.ideate,
      captureMiss: preamble.captureMiss,
      configIntegrity: preamble.configIntegrity,
      codexLocks: preamble.codexLocks,
      taskToolSchemaPack: preamble.taskToolSchemaPack,
      // <- pre-fix: the whole result object, core mandate included, last.
      ok: true,
      me: ME_MARKER,
      claimable: [{ id: CLAIMABLE_MARKER, title: 'a claimable bug' }],
      inbox: { summary: { unread: 1 }, recent: [{ summary: INBOX_MARKER }] },
    };

    const doored = doorify(preFixOrder);
    const kept = (doored.content[0] as { text: string }).text;
    expect(kept).not.toContain(ME_MARKER); // the defect EI-18689334534773965 reported
  });
});

/** A LEADER's fleet briefing is the same class of defect as the core result above,
 *  and it bit a live leader on 2026-08-01: `me.summary.agents` counts only resolved
 *  PRESENCE (self, on a monitor tick), so a leader whose `leaderBrief` was spilled
 *  reads `agents: 1` and concludes the whole fleet is dead. Two consecutive wakes
 *  reported "my 11-member fleet is gone" while the spilled tail of that very orient
 *  said `members: 11, dead: 0`.
 *
 *  EI-19282566865609166 had already fixed the FOLD (monitor OR afterCompaction) but
 *  left the assembled key in `resultRest` — dead last — so on a trimmed payload tier
 *  the door ate it anyway. Fold-enabled and never-delivered are indistinguishable to
 *  the reader, which is why folding it is not sufficient on its own. */
describe('leaderBrief survives the result-door for a fleet leader under a large preamble', () => {
  const LEADER_BRIEF_MARKER = 'LEADER-BRIEF-MEMBERS-CANARY';

  function leaderResult() {
    return {
      ok: true,
      me: ME_MARKER,
      claimable: [],
      inbox: { summary: {}, recent: [] },
      leaderBrief: {
        ok: true,
        summary: { fleet: 'f', members: 11, dead: 0, note: LEADER_BRIEF_MARKER },
      },
      memory: { hits: ['DISCRETIONARY-TAIL-SHOULD-SPILL'.repeat(200)] },
    };
  }

  it('is present in the KEPT text, not only the spill', () => {
    const out = assembleOrientOutput({
      self: { ownerId: 'su-test' },
      result: leaderResult(),
      ...bigPreamble('preamble'),
    });

    const doored = doorify(out);
    expect(doored.content).toHaveLength(2); // truncation DID occur — the door was exercised
    const kept = (doored.content[0] as { text: string }).text;
    expect(kept).toContain(LEADER_BRIEF_MARKER);
  });

  it('regression guard: with leaderBrief left in the result tail (the pre-fix shape), it is lost to the spill', () => {
    // Proves this suite discriminates the bug rather than passing vacuously.
    const preamble = bigPreamble('preamble');
    const preFixOrder = {
      self: { ownerId: 'su-test' },
      ok: true,
      me: ME_MARKER,
      claimable: [],
      inbox: { summary: {}, recent: [] },
      ownerDirectives: preamble.ownerDirectives,
      instructionPrecedence: preamble.instructionPrecedence,
      taskToolSchemaPack: preamble.taskToolSchemaPack,
      // <- pre-fix: leaderBrief rode `resultRest`, spread after every preamble leg.
      leaderBrief: { ok: true, summary: { members: 11, dead: 0, note: LEADER_BRIEF_MARKER } },
    };

    const doored = doorify(preFixOrder);
    const kept = (doored.content[0] as { text: string }).text;
    expect(kept).not.toContain(LEADER_BRIEF_MARKER);
  });

  it('a FAILED fold (leaderBrief: null) stays distinguishable from "not a leader" (key absent)', () => {
    // `null` means "I tried and could not tell you"; absent means "not applicable".
    // A truthiness spread would collapse both to absent and silently recreate the
    // exact ambiguity this fix removes.
    const withNull = assembleOrientOutput({
      self: { ownerId: 'su-test' },
      result: { ok: true, me: ME_MARKER, leaderBrief: null },
    });
    expect('leaderBrief' in withNull).toBe(true);
    expect(withNull.leaderBrief).toBeNull();

    const notALeader = assembleOrientOutput({
      self: { ownerId: 'su-test' },
      result: { ok: true, me: ME_MARKER },
    });
    expect('leaderBrief' in notALeader).toBe(false);
  });
});
