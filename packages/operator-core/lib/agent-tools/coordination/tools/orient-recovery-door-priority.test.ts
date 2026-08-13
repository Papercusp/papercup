/**
 * orient-recovery-door-priority.test.ts — WI-5656 regression.
 *
 * coord:orient {afterCompaction} folds a `recovery` block (held-item
 * checkpoints, armed-loop status, staleness warnings, the self-recall
 * pointer) — the ONE payload a just-compacted successor cannot get any other
 * way. result-door.ts caps a tool result's serialized text at a fixed
 * per-result token budget and keeps only the HEAD (context-doors.ts
 * capInjectionText), spilling the tail to scratch. So the assembled
 * response's KEY ORDER is the survival priority for what's actually in
 * context — a large preamble (ownerDirectives/modes/instructionPrecedence/
 * taskToolSchemaPack/…) serialized AHEAD of `recovery` silently starves it,
 * defeating the entire purpose of `afterCompaction`.
 *
 * This test exercises `assembleOrientOutput` (the real, exported assembly
 * function orient.ts's handler calls) together with the real `applyResultDoor`
 * — proving recovery survives the door even when every other preamble leg is
 * individually large enough to exceed the whole budget on its own.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/coordination/tools/orient-recovery-door-priority.test.ts
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
  sandbox = mkdtempSync(join(tmpdir(), 'papercusp-orient-recovery-door-test-'));
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

/** Every non-recovery preamble leg blown up well past the WHOLE door budget on
 *  its own — the exact shape that starved `recovery` pre-fix (a big
 *  taskToolSchemaPack + instructionPrecedence + ownerDirectives easily exceeds
 *  ~6000 chars before `recovery` is ever reached). */
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

const RECOVERY_MARKER = 'WI-5656-RECOVERY-CANARY-CHECKPOINT-ID';

function doorify(out: Record<string, unknown>) {
  return applyResultDoor(
    { content: [{ type: 'text' as const, text: JSON.stringify(out) }] },
    { toolName: 'coord:orient', workspaceId: 'ws-1', runId: '11111111-2222-4333-8444-555555555555' },
  );
}

describe('WI-5656: coord:orient recovery block survives the result-door under a large preamble', () => {
  it('recovery (checkpoints + loop + selfRecall) is present in the KEPT (in-context) text, not only the spill', () => {
    const recovery = {
      selfRecall: 'recover pre-compaction turns via sessions:search',
      selfSession: { sourceKind: 'claude', sessionId: 'sid-1' },
      loop: { active: true, intervalSec: 60 },
      checkpoints: [{ id: RECOVERY_MARKER, title: 'held item', checkpoint: 'in-flight state' }],
    };

    const out = assembleOrientOutput({
      self: { ownerId: 'su-test' },
      recovery,
      result: { ok: true, me: 'me-toon', claimable: [], inbox: { summary: {}, recent: [] } },
      ...bigPreamble('preamble'),
    });

    const doored = doorify(out);
    expect(doored.content).toHaveLength(1); // structural JSON replaces the old kept-head + footer pair
    const kept = (doored.content[0] as { text: string }).text;
    expect(kept.length).toBeLessThanOrEqual(BUDGET_CHARS);
    expect(() => JSON.parse(kept)).not.toThrow();

    // The whole point of afterCompaction: this must be IN-CONTEXT, not merely
    // recoverable via a second paging round-trip to the spill file.
    expect(kept).toContain(RECOVERY_MARKER);
    expect(kept).toContain('"active":true'); // armed-loop status survives too
  });

  it('regression guard: with recovery pushed to the TAIL (the pre-fix shape), the canary is lost to the spill', () => {
    // Mirrors the pre-fix key order (recovery serialized after every other
    // preamble leg) to prove this test suite actually discriminates the bug —
    // i.e. it is not just a permissive fixture that always keeps everything.
    const recovery = {
      selfRecall: 'recover pre-compaction turns via sessions:search',
      loop: { active: true, intervalSec: 60 },
      checkpoints: [{ id: RECOVERY_MARKER, title: 'held item', checkpoint: 'in-flight state' }],
    };
    const preamble = bigPreamble('preamble');
    const preFixOrder = {
      ownerDirectives: preamble.ownerDirectives,
      self: { ownerId: 'su-test' },
      modes: preamble.modes,
      instructionPrecedence: preamble.instructionPrecedence,
      ideate: preamble.ideate,
      captureMiss: preamble.captureMiss,
      configIntegrity: preamble.configIntegrity,
      codexLocks: preamble.codexLocks,
      taskToolSchemaPack: preamble.taskToolSchemaPack,
      recovery, // <- last, pre-fix
      ok: true,
      me: 'me-toon',
      claimable: [],
      inbox: { summary: {}, recent: [] },
    };

    const doored = doorify(preFixOrder);
    const kept = (doored.content[0] as { text: string }).text;
    expect(kept).not.toContain(RECOVERY_MARKER); // the defect WI-5656 reported
  });
});
