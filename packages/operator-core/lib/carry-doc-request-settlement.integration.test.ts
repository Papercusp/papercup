/**
 * P-005 (goal-agent-behavior-feedback-2026-09-06, AUTO-BAR-R-9-P-005): an owner
 * request stays unresolved until a MATCHING substantive delivered answer.
 *
 * Integration layer: a real Claude transcript file on disk is read by the
 * production tail reader (turn-journal `readVerbatimTail`), classified by the
 * production provenance classifier, and settled by `buildCarryDoc` →
 * `deriveContinuation`. Only the DB-backed legs that are unrelated to request
 * settlement (brief, recovery, modes, plan items, asks, background tasks,
 * owner-speech census) are replaced, so the subject path is the one a real
 * carry-respawn walks from transcript to successor continuation.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCarryDoc, type BuildCarryDocOpts } from './carry-doc';

const OWNER = 'su-request-settlement-fixture';
let sandbox: string;

type Line = Record<string, unknown>;
const owner = (uuid: string, parentUuid: string | null, text: string): Line => ({
  type: 'user', uuid, parentUuid, message: { role: 'user', content: text },
});
const loopWake = (uuid: string, parentUuid: string | null): Line => ({
  type: 'user', uuid, parentUuid,
  message: { role: 'user', content: '⟦turn-origin:loop-fire nonce:0123456789abcdef⟧\nCOLD LOOP WAKE — continue the standing work.' },
});
const assistant = (
  uuid: string,
  parentUuid: string,
  text: string,
  stopReason: 'end_turn' | 'tool_use' | 'stop_sequence',
  extra: Line = {},
): Line => ({
  type: 'assistant', uuid, parentUuid, ...extra,
  message: { role: 'assistant', stop_reason: stopReason, content: [{ type: 'text', text }] },
});

function transcript(name: string, lines: Line[]): string {
  const path = join(sandbox, `${name}.jsonl`);
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return path;
}

function opts(transcriptPath: string): BuildCarryDocOpts {
  return {
    workspaceId: 'request-settlement-ws',
    transcriptPath,
    transcriptSourceKind: 'claude',
    boundaryDeliberate: false,
    buildCarryBriefFn: async () => ({
      ownerId: OWNER, loop: null, heldItems: [], directives: [], directivesTotalOpen: 0,
      walls: [], facts: [], awaits: [], fleet: null,
    }),
    buildAutomaticRecoveryFn: async () => null,
    getModesFn: async () => [],
    getPlanItemsFn: async () => [],
    getAsksFn: async () => [],
    getBackgroundTasksFn: async () => [],
    ownerSpeechCensusFn: async () => 'unknown',
    projectedToolsFn: () => [],
  } as BuildCarryDocOpts;
}

beforeAll(() => { sandbox = mkdtempSync(join(tmpdir(), 'carry-request-settlement-')); });
afterAll(() => { rmSync(sandbox, { recursive: true, force: true }); });

describe('P-005-request-settlement: transcript → carry continuation', () => {
  it('a delivered answer to a LATER machine wake does not settle the earlier owner request', async () => {
    const path = transcript('wake-answer', [
      owner('o1', null, 'Please audit the release gate and report what blocks main.'),
      assistant('a1', 'o1', 'Looking into it now.', 'tool_use'),
      loopWake('w1', 'a1'),
      assistant('a2', 'w1', 'Loop wake handled; nothing new on the lane.', 'end_turn'),
    ]);
    const doc = await buildCarryDoc(OWNER, opts(path));
    expect(doc.tail.map((t) => t.provenance?.verdict ?? null)).toEqual(
      ['owner-typed', null, 'agent-injected', null],
    );
    expect(doc.continuation.lastOwnerMessage?.text).toContain('audit the release gate');
    expect(doc.continuation.answered).toBe(false);
  });

  it('an acknowledgement (non-final progress) does not settle the owner request', async () => {
    const path = transcript('ack-only', [
      owner('o1', null, 'Summarize the open walls for me.'),
      assistant('a1', 'o1', 'On it.', 'tool_use'),
    ]);
    const doc = await buildCarryDoc(OWNER, opts(path));
    expect(doc.continuation.answered).toBe(false);
  });

  it('an interrupted reply does not settle the owner request', async () => {
    const path = transcript('interrupted', [
      owner('o1', null, 'Summarize the open walls for me.'),
      // Real shape (measured on 37 recorded Claude transcripts): isApiErrorMessage,
      // stop_reason 'stop_sequence', model '<synthetic>'.
      {
        ...assistant('a1', 'o1', 'API Error: overloaded', 'stop_sequence', { isApiErrorMessage: true }),
        message: { role: 'assistant', model: '<synthetic>', stop_reason: 'stop_sequence', content: [{ type: 'text', text: 'API Error: overloaded' }] },
      },
    ]);
    const doc = await buildCarryDoc(OWNER, opts(path));
    expect(doc.continuation.answered).toBe(false);
  });

  it('the matching delivered answer settles the owner request (calibration)', async () => {
    const path = transcript('answered', [
      owner('o1', null, 'Summarize the open walls for me.'),
      assistant('a1', 'o1', 'Checking the walls.', 'tool_use'),
      assistant('a2', 'a1', 'Open walls: R-16 and R-18 await the leader ruling.', 'end_turn'),
    ]);
    const doc = await buildCarryDoc(OWNER, opts(path));
    expect(doc.continuation.lastOwnerMessage?.text).toContain('Summarize the open walls');
    expect(doc.continuation.answered).toBe(true);
  });
});
