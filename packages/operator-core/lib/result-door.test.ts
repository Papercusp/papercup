/** Result door (deterministic-context-carry P-006 leg C) — cap a model-facing MCP
 *  tool result at the resultEach door, spill the FULL text to scratch behind a
 *  pointer; delta results and the kill-switch bypass; fail-soft on spill failure. */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BAKED_DOOR_CONSTANTS, CHARS_PER_TOKEN_ESTIMATE } from './context-doors';

// P-023: the door resolves its constants through the config surface per call — stub it
// (the config module has its own suite) so these tests run PG-free and one case can
// exercise a per-session override widening the budget.
const { doorConstantsMock } = vi.hoisted(() => ({ doorConstantsMock: vi.fn() }));
vi.mock('./context-doors-config', () => ({ getDoorConstantsSync: doorConstantsMock }));

import { applyResultDoor, RESULT_DOOR_TOKENS } from './result-door';

const BUDGET_CHARS = RESULT_DOOR_TOKENS * CHARS_PER_TOKEN_ESTIMATE;
const RUN_ID = '11111111-2222-4333-8444-555555555555';

let sandbox: string;
let prevScratchRoot: string | undefined;
let prevKillSwitch: string | undefined;

beforeEach(() => {
  // os.homedir() reads /etc/passwd not $HOME on Linux — the env-var override is
  // the one seam that redirects scratch writes (same setup as scratch-gc.test.ts).
  sandbox = mkdtempSync(join(tmpdir(), 'papercusp-result-door-test-'));
  prevScratchRoot = process.env.PAPERCUSP_SCRATCH_ROOT;
  process.env.PAPERCUSP_SCRATCH_ROOT = join(sandbox, 'scratch');
  prevKillSwitch = process.env.PAPERCUSP_RESULT_DOOR_OFF;
  delete process.env.PAPERCUSP_RESULT_DOOR_OFF;
  doorConstantsMock.mockReset();
  doorConstantsMock.mockReturnValue(BAKED_DOOR_CONSTANTS);
});

afterEach(() => {
  if (prevScratchRoot === undefined) delete process.env.PAPERCUSP_SCRATCH_ROOT;
  else process.env.PAPERCUSP_SCRATCH_ROOT = prevScratchRoot;
  if (prevKillSwitch === undefined) delete process.env.PAPERCUSP_RESULT_DOOR_OFF;
  else process.env.PAPERCUSP_RESULT_DOOR_OFF = prevKillSwitch;
  rmSync(sandbox, { recursive: true, force: true });
});

function longText(chars: number): string {
  return Array.from({ length: Math.ceil(chars / 40) }, (_, i) => `line ${i} of a very long tool result`)
    .join('\n')
    .slice(0, chars);
}

/** The single spill file written under <scratchRoot>/<ws>/<tool>/<runId>/. */
function readSpill(ws: string, tool: string, runId: string): string {
  const dir = join(process.env.PAPERCUSP_SCRATCH_ROOT!, ws, tool, runId);
  const files = readdirSync(dir);
  expect(files).toHaveLength(1);
  return readFileSync(join(dir, files[0]), 'utf8');
}

describe('applyResultDoor', () => {
  it('a result within the budget passes through as the SAME object (no copy, no spill)', () => {
    const result = { content: [{ type: 'text' as const, text: 'small result' }] };
    expect(applyResultDoor(result, { toolName: 'plans:get', workspaceId: 'ws-1', runId: RUN_ID })).toBe(result);
  });

  it('an over-door result is capped + pointered, and the spill file holds the WHOLE original', () => {
    const original = longText(BUDGET_CHARS * 3);
    const doored = applyResultDoor(
      { content: [{ type: 'text' as const, text: original }] },
      { toolName: 'plans:get', workspaceId: 'ws-1', runId: RUN_ID },
    );
    expect(doored.content).toHaveLength(2); // kept head + pointer
    const kept = (doored.content[0] as { text: string }).text;
    const pointer = (doored.content[1] as { text: string }).text;
    expect(kept.length).toBeLessThanOrEqual(BUDGET_CHARS);
    expect(original.startsWith(kept)).toBe(true);
    expect(pointer).toContain('[result-door:');
    expect(pointer).toContain('papercusp://scratch/ws-1/plans:get/' + RUN_ID);
    const spill = readSpill('ws-1', 'plans:get', RUN_ID);
    expect(spill).toContain('# tool: plans:get');
    expect(spill.endsWith(original)).toBe(true);
  });

  it('non-text items pass through intact; text budget is consumed in order', () => {
    const img = { type: 'image', data: 'aaaa', mimeType: 'image/png' };
    const doored = applyResultDoor(
      {
        content: [
          { type: 'text' as const, text: longText(BUDGET_CHARS * 2) },
          img,
          { type: 'text' as const, text: 'trailing text fully over budget' },
        ],
      },
      { toolName: 'plans:get', workspaceId: 'ws-1', runId: RUN_ID },
    );
    expect(doored.content).toContainEqual(img);
    // the trailing text item fell entirely into the spill
    expect(doored.content.filter((c) => (c as { type?: string }).type === 'text')).toHaveLength(2);
    const spill = readSpill('ws-1', 'plans:get', RUN_ID);
    expect(spill).toContain('trailing text fully over budget');
  });

  it('a delta-protocol result (_meta.delta set) is NEVER doored — its text is client-parsed JSON', () => {
    const result = {
      content: [{ type: 'text' as const, text: longText(BUDGET_CHARS * 2) }],
      _meta: { delta: { mode: 'reconstructed' } },
    };
    expect(applyResultDoor(result, { toolName: 'plans:get', workspaceId: 'ws-1', runId: RUN_ID })).toBe(result);
  });

  it('kill-switch PAPERCUSP_RESULT_DOOR_OFF=1 bypasses entirely', () => {
    process.env.PAPERCUSP_RESULT_DOOR_OFF = '1';
    const result = { content: [{ type: 'text' as const, text: longText(BUDGET_CHARS * 2) }] };
    expect(applyResultDoor(result, { toolName: 'plans:get', workspaceId: 'ws-1', runId: RUN_ID })).toBe(result);
  });

  it("an unscoped caller ('*' workspace) spills under 'unscoped'; a non-UUID runId gets a fresh UUID", () => {
    const doored = applyResultDoor(
      { content: [{ type: 'text' as const, text: longText(BUDGET_CHARS * 2) }] },
      { toolName: 'plans:get', workspaceId: '*', runId: 'not-a-uuid' },
    );
    const pointer = (doored.content.at(-1) as { text: string }).text;
    expect(pointer).toContain('papercusp://scratch/unscoped/plans:get/');
    expect(pointer).not.toContain('not-a-uuid');
  });

  it('P-023: a per-session override widens the door — the same over-baked result passes through', () => {
    const original = longText(BUDGET_CHARS * 2); // over the BAKED 1500-token door
    // The session's resolved constants double the floor → resultEach 3000 tokens.
    doorConstantsMock.mockReturnValue({ ...BAKED_DOOR_CONSTANTS, maxTurnFloorTokens: 16_000 });
    const result = { content: [{ type: 'text' as const, text: original }] };
    expect(applyResultDoor(result, { toolName: 'plans:get', workspaceId: 'ws-1', runId: RUN_ID, ownerId: 'su-x' })).toBe(result);
    expect(doorConstantsMock).toHaveBeenCalledWith('su-x'); // keyed on the caller's identity
  });

  it('fail-soft: an unwritable scratch root returns the ORIGINAL result untouched', () => {
    // A regular FILE where the scratch root dir should be → mkdirSync throws.
    writeFileSync(join(sandbox, 'scratch'), 'not a directory');
    const result = { content: [{ type: 'text' as const, text: longText(BUDGET_CHARS * 2) }] };
    expect(applyResultDoor(result, { toolName: 'plans:get', workspaceId: 'ws-1', runId: RUN_ID })).toBe(result);
  });

  // EI-13918: `result.data` may have ALREADY been replaced upstream by a lossy
  // payload-tier projection (payload-tier.ts) before this door ever ran — in
  // which case the "FULL result is at <path>" footer is FALSE: the spilled
  // file holds only that already-partial projection, and the genuinely
  // omitted content was never serialized, so paging can never recover it.
  // `_meta.payloadProjection` (serialize-result.ts) is how the door learns
  // this without parsing the body.
  describe('upstream payload-tier truncation (_meta.payloadProjection)', () => {
    const payloadProjection = {
      truncated: true as const,
      tier: 'trimmed',
      forced: true,
      originalChars: 37343,
      returnedChars: 7058,
      omittedCount: 39,
    };

    it('does NOT claim the spill is the "FULL" result — footer + spill header say it is already-projected and unrecoverable-by-paging', () => {
      const doored = applyResultDoor(
        {
          content: [{ type: 'text' as const, text: longText(BUDGET_CHARS * 3) }],
          _meta: { payloadProjection },
        },
        { toolName: 'coord:orient', workspaceId: 'ws-1', runId: RUN_ID },
      );
      const pointer = (doored.content.at(-1) as { text: string }).text;
      expect(pointer).not.toContain('The FULL result is at');
      expect(pointer).toContain('NOT the tool');
      expect(pointer).toContain('omittedCount=39');
      expect(pointer).toContain("payloadTier:'full'");

      const spill = readSpill('ws-1', 'coord:orient', RUN_ID);
      expect(spill).not.toContain('FULL tool result');
      expect(spill).toContain('ALREADY-PROJECTED');
      expect(spill).toContain('originalChars=37343');
      expect(spill).toContain('returnedChars=7058');
      expect(spill).toContain('NOT recoverable from this file');
    });

    it('a result WITHOUT the marker keeps the original truthful "FULL result" wording (no false positives)', () => {
      const doored = applyResultDoor(
        { content: [{ type: 'text' as const, text: longText(BUDGET_CHARS * 3) }] },
        { toolName: 'plans:get', workspaceId: 'ws-1', runId: RUN_ID },
      );
      const pointer = (doored.content.at(-1) as { text: string }).text;
      expect(pointer).toContain('The FULL result is at');
      const spill = readSpill('ws-1', 'plans:get', RUN_ID);
      expect(spill).toContain('# result-door spill — FULL tool result');
    });

    it('a projected result that ALSO fits under the door budget is untouched (no false-positive spill)', () => {
      const result = { content: [{ type: 'text' as const, text: 'small already-projected result' }], _meta: { payloadProjection } };
      expect(applyResultDoor(result, { toolName: 'coord:orient', workspaceId: 'ws-1', runId: RUN_ID })).toBe(result);
    });
  });
});
