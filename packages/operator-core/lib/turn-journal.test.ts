/** Per-turn journal (deterministic-context-carry P-012) — extraction (agent
 *  ⟦journal⟧ line vs flagged mechanical fallback), the claim-vs-ledger
 *  tripwire, and the bounded transcript tail-reader / root-guarded resolver. */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  detectClaimLedgerMismatch,
  extractJournalFromAssistantText,
  JOURNAL_MARKER,
  JOURNAL_NOTE_MAX_CHARS,
  MECHANICAL_NOTE_MAX_CHARS,
  readLastAssistantTurn,
  resolveTranscriptPath,
} from './turn-journal';

describe('extractJournalFromAssistantText', () => {
  it('an agent-authored trailing ⟦journal⟧ line wins, unflagged', () => {
    const r = extractJournalFromAssistantText(
      'Long report body.\n\nMore detail here.\n\n⟦journal⟧ Landed the doors config; next is the hook wiring.',
    );
    expect(r).toEqual({
      note: 'Landed the doors config; next is the hook wiring.',
      source: 'agent',
      flagged: false,
    });
  });

  it('the LAST marker line wins when the convention is quoted earlier', () => {
    const r = extractJournalFromAssistantText(
      `The convention is a line like "${JOURNAL_MARKER} example note".\n${JOURNAL_MARKER} the real note`,
    );
    expect(r!.note).toBe('the real note');
    expect(r!.source).toBe('agent');
  });

  it('no marker → mechanical first line, markup stripped, FLAGGED', () => {
    const r = extractJournalFromAssistantText('## P-012 done\nDetail line.');
    expect(r).toEqual({ note: 'P-012 done', source: 'mechanical', flagged: true });
  });

  it('an empty marker line falls through to the mechanical fallback', () => {
    const r = extractJournalFromAssistantText(`Some text.\n${JOURNAL_MARKER}   `);
    expect(r!.source).toBe('mechanical');
    expect(r!.note).toBe('Some text.');
  });

  it('caps both variants at their budgets', () => {
    const long = 'x'.repeat(2000);
    expect(extractJournalFromAssistantText(`${JOURNAL_MARKER} ${long}`)!.note).toHaveLength(
      JOURNAL_NOTE_MAX_CHARS,
    );
    expect(extractJournalFromAssistantText(long)!.note).toHaveLength(MECHANICAL_NOTE_MAX_CHARS);
  });

  it('whitespace-only text yields null', () => {
    expect(extractJournalFromAssistantText('  \n \n')).toBeNull();
  });
});

describe('detectClaimLedgerMismatch (note says pass, ledger says exit 1; ledger NEWEST FIRST)', () => {
  const failedBash = { toolName: 'Bash', status: 'error', summary: '$ npx vitest run' };
  const cleanBash = { toolName: 'Bash', status: 'ok', summary: '$ npx vitest run' };
  const okRead = { toolName: 'Read', status: 'ok', summary: 'lib/foo.ts' };

  it('tripwires a success claim whose latest execution errored', () => {
    const t = detectClaimLedgerMismatch('All 12 tests pass; shipping it.', [failedBash]);
    expect(t).not.toBeNull();
    expect(t!.kind).toBe('claim-ledger-mismatch');
    expect(t!.claim.toLowerCase()).toContain('tests pass');
    expect(t!.evidence).toEqual([failedBash]);
  });

  it('tripwires on ledger summary text ("exit code 1") when status was not stamped', () => {
    const t = detectClaimLedgerMismatch('build green, done', [
      { toolName: 'Bash', status: null, summary: '$ npm run build → exit code 1' },
    ]);
    expect(t).not.toBeNull();
  });

  it('the iterate-until-green turn stays clean: latest run ok, earlier run failed', () => {
    expect(detectClaimLedgerMismatch('all tests pass', [cleanBash, failedBash])).toBeNull();
  });

  it('a claimed pass with an old failure and NO re-run still trips (Read/Edit ok does not attest)', () => {
    const t = detectClaimLedgerMismatch('all tests pass', [okRead, failedBash]);
    expect(t).not.toBeNull();
    expect(t!.evidence).toEqual([failedBash]);
  });

  it('a clean ledger never tripwires', () => {
    expect(detectClaimLedgerMismatch('all tests pass', [cleanBash])).toBeNull();
  });

  it('no execution at all in the window → no tripwire (unverifiable, not dishonest)', () => {
    expect(detectClaimLedgerMismatch('all tests pass', [okRead])).toBeNull();
  });

  it('a note with NO success claim never tripwires, whatever the ledger says', () => {
    expect(detectClaimLedgerMismatch('Refactored the resolver; next is wiring.', [failedBash])).toBeNull();
  });

  it('honest disclosure alongside the claim is never tripwired', () => {
    expect(
      detectClaimLedgerMismatch('unit tests pass but the integration suite is failing', [failedBash]),
    ).toBeNull();
  });

  it('evidence is capped at 3 rows', () => {
    const t = detectClaimLedgerMismatch(
      'typecheck clean',
      Array.from({ length: 10 }, (_, i) => ({ toolName: 'Bash', status: 'error', summary: `$ run ${i}` })),
    );
    expect(t!.evidence).toHaveLength(3);
  });
});

describe('readLastAssistantTurn / resolveTranscriptPath', () => {
  let sandbox: string;
  const claudeLine = (role: 'user' | 'assistant', text: string, ts: string) =>
    JSON.stringify({
      type: role,
      timestamp: ts,
      sessionId: 'sess-1',
      message: { role, content: [{ type: 'text', text }] },
    });

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'papercusp-turn-journal-test-'));
  });
  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it('returns the LAST assistant text turn of a claude transcript, with its ts', async () => {
    const f = join(sandbox, 'sess.jsonl');
    writeFileSync(
      f,
      [
        claudeLine('user', 'do the thing', '2026-07-14T10:00:00Z'),
        claudeLine('assistant', 'working on it', '2026-07-14T10:00:05Z'),
        claudeLine('assistant', `done.\n${JOURNAL_MARKER} the note`, '2026-07-14T10:00:20Z'),
      ].join('\n') + '\n',
    );
    const turn = await readLastAssistantTurn(f, 'claude');
    expect(turn).not.toBeNull();
    expect(turn!.speaker).toBe('assistant');
    expect(turn!.text).toContain('the note');
    expect(turn!.ts?.toISOString()).toBe('2026-07-14T10:00:20.000Z');
  });

  it('a transcript whose tail is user turns still finds the previous assistant text', async () => {
    const f = join(sandbox, 'sess.jsonl');
    writeFileSync(
      f,
      [
        claudeLine('assistant', 'the answer', '2026-07-14T10:00:00Z'),
        claudeLine('user', 'thanks', '2026-07-14T10:00:10Z'),
      ].join('\n') + '\n',
    );
    const turn = await readLastAssistantTurn(f, 'claude');
    expect(turn!.text).toBe('the answer');
  });

  it('resolves a candidate path only when it lives under a known root', async () => {
    const root = join(sandbox, 'root');
    mkdirSync(join(root, 'proj'), { recursive: true });
    const inside = join(root, 'proj', 'abc.jsonl');
    writeFileSync(inside, claudeLine('assistant', 'hi', '2026-07-14T10:00:00Z') + '\n');
    const outside = join(sandbox, 'outside.jsonl');
    writeFileSync(outside, 'x\n');
    const roots = [{ root, dirDepth: 1 }];

    expect(await resolveTranscriptPath('claude', 'abc', inside, roots)).toBe(inside);
    // A foreign path is REFUSED as a candidate; the walk then finds the rooted
    // file by session id instead (never the foreign path).
    expect(await resolveTranscriptPath('claude', 'abc', outside, roots)).toBe(inside);
    expect(await resolveTranscriptPath('claude', 'nope', outside, roots)).toBeNull();
  });

  it('walks the roots by session id when no candidate is given', async () => {
    const root = join(sandbox, 'root');
    mkdirSync(join(root, 'proj'), { recursive: true });
    const f = join(root, 'proj', 'deadbeef-1234.jsonl');
    writeFileSync(f, claudeLine('assistant', 'hi', '2026-07-14T10:00:00Z') + '\n');
    expect(await resolveTranscriptPath('claude', 'deadbeef-1234', undefined, [{ root, dirDepth: 1 }])).toBe(f);
  });
});
