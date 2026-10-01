import { describe, expect, it } from 'vitest';

import { stateSha256 } from '@papercusp/decision-model';

// The hook's real digest: the replay must rebuild what the client actually shipped.
// @ts-expect-error -- plain .mjs hook module, no declaration file
import { buildDigest } from '../../../../../apps/operator/scripts/hooks/inject/core.mjs';
import { deriveBatchQuery, splitLegQueries, type BatchCall } from '../../endpoint-route/routes/agent-mcp/mid-turn-context';
import { dropQuality, gateStateSha, midTurnQueryOf, pYesByIndex, transcriptBatches } from './jev-live-drop-quality';

const digest = buildDigest as (calls: BatchCall[]) => BatchCall[];

const assistant = (messageId: string, ts: string, uses: { id: string; name: string; input: unknown }[]) => ({
  type: 'assistant',
  timestamp: ts,
  message: { id: messageId, content: uses.map((u) => ({ type: 'tool_use', ...u })) },
});
const result = (useId: string, toolUseResult: unknown) => ({
  type: 'user',
  toolUseResult,
  message: { content: [{ type: 'tool_result', tool_use_id: useId, content: 'raw block' }] },
});

describe('transcriptBatches', () => {
  it('groups the tool calls of one assistant message, split across JSONL lines, into one batch', () => {
    const batches = transcriptBatches([
      assistant('msg_A', '2026-10-01T02:00:00Z', [{ id: 't1', name: 'Grep', input: { pattern: 'runJevMemoryGate' } }]),
      assistant('msg_A', '2026-10-01T02:00:01Z', [{ id: 't2', name: 'Bash', input: { command: 'git status' } }]),
      result('t1', { mode: 'files_with_matches', numFiles: 0, filenames: [] }),
      result('t2', { stdout: 'clean', stderr: '' }),
      assistant('msg_B', '2026-10-01T02:01:00Z', [{ id: 't3', name: 'Read', input: { file_path: '/x/y/z.ts' } }]),
    ]);
    expect(batches.map((b) => b.calls.map((c) => c.tool))).toEqual([['Grep', 'Bash'], ['Read']]);
    expect(batches[0].at).toBe('2026-10-01T02:00:00Z');
    // The structured toolUseResult is what the hook receives as tool_response.
    expect(batches[0].calls[1].toolResponse).toEqual({ stdout: 'clean', stderr: '' });
    // A call whose result never arrived keeps an undefined response, not a borrowed one.
    expect(batches[1].calls[0].toolResponse).toBeUndefined();
  });

  it('ignores prose-only messages, malformed lines and results for unknown tool ids', () => {
    const batches = transcriptBatches([
      null,
      'not an object',
      { type: 'assistant', message: { id: 'm', content: [{ type: 'text', text: 'hello' }] } },
      result('nope', { stdout: 'x' }),
    ]);
    expect(batches).toEqual([]);
  });
});

describe('midTurnQueryOf', () => {
  it('is the server pipeline over the hook digest: derive, clamp, cosine leg', () => {
    const calls: BatchCall[] = [
      { tool: 'Grep', toolInput: { pattern: 'judgeAdmission', path: 'packages/operator-core/lib/memory' }, toolResponse: 'No matches found' },
      { tool: 'Bash', toolInput: { command: 'psql -c "select 1"' }, toolResponse: { stdout: '1' } },
    ];
    const expected = splitLegQueries(deriveBatchQuery(digest(calls)).slice(0, 1000)).cosine;
    expect(expected).not.toBe('');
    expect(midTurnQueryOf(calls, digest)).toBe(expected);
  });

  it('returns empty for a batch with no signal', () => {
    expect(midTurnQueryOf([], digest)).toBe('');
  });
});

describe('gateStateSha', () => {
  it('equals the decision ledger hash of the instructions-encoding state { message }', () => {
    expect(gateStateSha('jev timeout')).toBe(stateSha256({ message: 'jev timeout' }));
    // Positive control: a different message must not collide, or every match would be vacuous.
    expect(gateStateSha('jev timeout')).not.toBe(gateStateSha('jev timeouts'));
  });
});

describe('dropQuality', () => {
  it('counts drops below the threshold and splits them by the judge verdict', () => {
    const q = dropQuality(
      [
        { pYes: 0.1, relevant: false }, // correct drop
        { pYes: 0.2, relevant: true }, // wrong drop: a relevant memory lost
        { pYes: 0.35, relevant: true }, // at the threshold: kept
        { pYes: 0.9, relevant: false }, // kept noise
      ],
      0.35,
    );
    expect(q).toMatchObject({ candidates: 4, relevant: 2, drops: 2, dropsRelevant: 1, keeps: 2, keepsRelevant: 1 });
    expect(q.dropRate).toBe(0.5);
    expect(q.dropPrecision).toBe(0.5);
    expect(q.relevantLossRate).toBe(0.5);
    expect(q.precisionWithout).toBe(0.5);
    expect(q.precisionWith).toBe(0.5);
  });

  it('reports null, not zero, for ratios with nothing to divide by', () => {
    const q = dropQuality([{ pYes: 0.9, relevant: false }], 0.35);
    expect(q.dropPrecision).toBeNull();
    expect(q.relevantLossRate).toBeNull();
    expect(dropQuality([], 0.35).dropRate).toBeNull();
  });
});

describe('pYesByIndex', () => {
  it('reads m1..mN in subject order and never invents a missing score', () => {
    expect(pYesByIndex({ m1: { pYes: 0.2 }, m3: { pYes: 0.9 }, m2: { pYes: 'x' } }, 4)).toEqual([0.2, null, 0.9, null]);
    expect(pYesByIndex(null, 2)).toEqual([null, null]);
  });
});
