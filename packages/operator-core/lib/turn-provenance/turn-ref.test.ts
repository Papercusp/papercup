/** Turn refs (deterministic-context-carry P-014) — ref format/parse, recorded-
 *  turn owner-vs-agent classification, and transcript verification. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  classifyRecordedTurn,
  formatTurnRef,
  parseTurnRefs,
  parseUserTurns,
  resolveCurrentTurnStamp,
  verifyTurnRefs,
} from './turn-ref';

const SID = 'bf1881bc-9fd9-4875-bb24-3b40796205db';

const userLine = (text: string, ts: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'user', timestamp: ts, message: { role: 'user', content: text }, ...extra });
const assistantLine = (text: string, ts: string) =>
  JSON.stringify({ type: 'assistant', timestamp: ts, message: { role: 'assistant', content: [{ type: 'text', text }] } });

describe('formatTurnRef / parseTurnRefs', () => {
  it('round-trips: format produces what parse recognizes', () => {
    const ref = formatTurnRef(SID, '2026-07-14T17:42:41.307Z');
    expect(ref).toBe('[turn:bf1881bc@2026-07-14T17:42:41.307Z]');
    const parsed = parseTurnRefs(`the owner said to ship dark ${ref}`);
    expect(parsed).toEqual([
      { sessionPrefix: 'bf1881bc', ts: '2026-07-14T17:42:41.307Z', raw: ref },
    ]);
  });

  it('finds multiple refs; empty/none yields []', () => {
    const text = `a [turn:abcd1234@2026-07-14T10:00:00Z] b [turn:ffff0000@2026-07-13T09:30:00.123Z] c`;
    expect(parseTurnRefs(text)).toHaveLength(2);
    expect(parseTurnRefs('no refs here')).toEqual([]);
    expect(parseTurnRefs(null)).toEqual([]);
  });
});

describe('classifyRecordedTurn', () => {
  it('an enrolled-injector envelope is decisive: agent-injected, origin extracted', () => {
    const r = classifyRecordedTurn('⟦turn-origin:wake-pump nonce:a1b2c3d4e5f60718⟧\ndo the thing');
    expect(r).toEqual({ verdict: 'agent-injected', origin: 'wake-pump' });
  });

  it('system-notification banners and compaction continuations are machine-surface', () => {
    expect(
      classifyRecordedTurn('[SYSTEM NOTIFICATION - NOT USER INPUT]\nbackground task done').verdict,
    ).toBe('machine-surface');
    expect(
      classifyRecordedTurn('This session is being continued from a previous conversation that ran out of context.')
        .verdict,
    ).toBe('machine-surface');
  });

  it('local-command plumbing is synthetic; a plain prompt is owner-typed', () => {
    expect(classifyRecordedTurn('<local-command-stdout>ok</local-command-stdout>').verdict).toBe('synthetic');
    expect(classifyRecordedTurn('please ship the release')).toEqual({
      verdict: 'owner-typed',
      origin: null,
    });
  });

  it('a mid-text envelope (quoted content) does NOT classify the turn', () => {
    expect(
      classifyRecordedTurn('note: injectors prefix ⟦turn-origin:loop-fire nonce:aabbccdd00112233⟧ to turns').verdict,
    ).toBe('owner-typed');
  });
});

describe('verifyTurnRefs / resolveCurrentTurnStamp (tmp transcript)', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'papercusp-turn-ref-test-'));
    file = join(dir, `${SID}.jsonl`);
    writeFileSync(
      file,
      [
        userLine('ship the release when green', '2026-07-14T10:00:00.000Z'),
        assistantLine('on it', '2026-07-14T10:00:05.000Z'),
        userLine('⟦turn-origin:loop-fire nonce:a1b2c3d4e5f60718⟧\ncontinue the loop', '2026-07-14T11:00:00.000Z'),
        userLine('<local-command-stdout>ok</local-command-stdout>', '2026-07-14T11:30:00.000Z'),
      ].join('\n') + '\n',
    );
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('verifies an owner-typed ref (found + owner-typed + snippet)', async () => {
    const refs = parseTurnRefs(formatTurnRef(SID, '2026-07-14T10:00:00.000Z'));
    const [v] = await verifyTurnRefs('owner-x', refs, { filePath: file, sessionId: SID });
    expect(v.found).toBe(true);
    expect(v.verdict).toBe('owner-typed');
    expect(v.snippet).toContain('ship the release');
  });

  it('classifies a machine-injected ref agent-injected with its origin', async () => {
    const refs = parseTurnRefs(formatTurnRef(SID, '2026-07-14T11:00:00.000Z'));
    const [v] = await verifyTurnRefs('owner-x', refs, { filePath: file, sessionId: SID });
    expect(v.found).toBe(true);
    expect(v.verdict).toBe('agent-injected');
    expect(v.origin).toBe('loop-fire');
  });

  it('matches a seconds-truncated ref timestamp', async () => {
    const refs = parseTurnRefs(`[turn:bf1881bc@2026-07-14T10:00:00Z]`);
    const [v] = await verifyTurnRefs('owner-x', refs, { filePath: file, sessionId: SID });
    // ref ts 'T10:00:00Z' vs recorded 'T10:00:00.000Z' — prefix-to-seconds match
    expect(v.found).toBe(true);
  });

  it('a ref into a DIFFERENT session never matches this transcript', async () => {
    const refs = parseTurnRefs('[turn:deadbeef@2026-07-14T10:00:00.000Z]');
    const [v] = await verifyTurnRefs('owner-x', refs, { filePath: file, sessionId: SID });
    expect(v.found).toBe(false);
  });

  it('unknown timestamp → found:false; unresolvable transcript → all miss (fail-soft)', async () => {
    const refs = parseTurnRefs(formatTurnRef(SID, '2026-07-14T23:59:59.000Z'));
    const [v] = await verifyTurnRefs('owner-x', refs, { filePath: file, sessionId: SID });
    expect(v.found).toBe(false);
    const [v2] = await verifyTurnRefs('owner-x', refs, { filePath: join(dir, 'missing.jsonl'), sessionId: SID });
    expect(v2.found).toBe(false);
  });

  it('resolveCurrentTurnStamp: latest non-synthetic turn, classified + ref formatted', async () => {
    const stamp = await resolveCurrentTurnStamp('owner-x', { filePath: file, sessionId: SID });
    // The last user entry is synthetic plumbing — the stamp lands on the
    // loop-fire injection before it.
    expect(stamp).toEqual({
      ref: '[turn:bf1881bc@2026-07-14T11:00:00.000Z]',
      verdict: 'agent-injected',
      origin: 'loop-fire',
    });
  });

  it('parseUserTurns keeps machine-injected turns (classification is per turn, not dropped)', () => {
    const turns = parseUserTurns(
      [userLine('hi', '2026-07-14T09:00:00Z'), userLine('⟦turn-origin:wake-pump nonce:aabbccdd00112233⟧\nwake', '2026-07-14T09:05:00Z')].join('\n'),
    );
    expect(turns).toHaveLength(2);
  });
});
