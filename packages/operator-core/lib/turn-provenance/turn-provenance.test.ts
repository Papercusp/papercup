/**
 * Turn-provenance protocol core — classifier boundaries + ledger round-trip
 * (turn-provenance-owner-vs-agent-2026-07-11 P-001).
 *
 * The classifier boundaries under test are exactly the plan's list: nonce
 * match, stale nonce, hash-only match, no match, mangled line endings, and
 * the spoofed-envelope case (D-002: the ledger decides, never the text).
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendLedgerRow,
  classify,
  formatEnvelope,
  gcLedgerDir,
  isTurnOrigin,
  ledgerPathForSid,
  ledgerTtlMs,
  LEDGER_TTL_MS_DEFAULT,
  mintNonce,
  normalizeForHash,
  parseEnvelope,
  payloadSha256,
  readLedgerRows,
  sanitizeSid,
  tagTurnForInjection,
  type LedgerRow,
} from './turn-provenance';

const SID = 'su-test-0000';
const NOW = 1_760_000_000_000;
const TTL = LEDGER_TTL_MS_DEFAULT;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'turn-prov-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function row(over: Partial<LedgerRow> = {}): LedgerRow {
  return { sid: SID, nonce: 'a1b2c3d4e5f60718', origin: 'wake-pump', sha256: 'x', ts: NOW, ...over };
}

describe('envelope format + parse', () => {
  it('round-trips format → parse, payload preserved', () => {
    const nonce = mintNonce();
    const env = formatEnvelope('wake-pump', nonce);
    const parsed = parseEnvelope(`${env}\n[await-event] fired: my-gate`);
    expect(parsed).toMatchObject({ origin: 'wake-pump', nonce });
    expect(parsed!.payload).toBe('\n[await-event] fired: my-gate');
  });

  it('tolerates leading whitespace (TUI padding)', () => {
    const parsed = parseEnvelope(`  \n ${formatEnvelope('loop-fire', 'deadbeefdeadbeef')} tick`);
    expect(parsed).toMatchObject({ origin: 'loop-fire', nonce: 'deadbeefdeadbeef' });
  });

  it('an envelope MID-TEXT is quoted content, not an envelope', () => {
    const text = `look at this: ${formatEnvelope('wake-pump', 'deadbeefdeadbeef')} weird?`;
    expect(parseEnvelope(text)).toBeNull();
  });

  it('parses coord-inject:<sender> origins', () => {
    const parsed = parseEnvelope(formatEnvelope('coord-inject:su-4c85f9d7-5cbe', 'deadbeefdeadbeef'));
    expect(parsed?.origin).toBe('coord-inject:su-4c85f9d7-5cbe');
  });

  it('mintNonce is 16 lowercase hex chars and unique-ish', () => {
    const a = mintNonce();
    const b = mintNonce();
    expect(a).toMatch(/^[a-f0-9]{16}$/);
    expect(a).not.toBe(b);
  });

  it('isTurnOrigin accepts bases + coord-inject suffix, rejects junk', () => {
    expect(isTurnOrigin('wake-pump')).toBe(true);
    expect(isTurnOrigin('self-compaction')).toBe(true);
    expect(isTurnOrigin('coord-inject:su-abc')).toBe(true);
    expect(isTurnOrigin('coord-inject:')).toBe(false);
    expect(isTurnOrigin('owner')).toBe(false);
    expect(isTurnOrigin('coord-inject:has space')).toBe(false);
  });
});

describe('hash normalization (PTY mangling)', () => {
  it('CRLF, lone-CR, and padding normalize to the same hash', () => {
    const clean = payloadSha256('line one\nline two\n');
    expect(payloadSha256('line one\r\nline two\r\n')).toBe(clean);
    expect(payloadSha256('line one\rline two\r')).toBe(clean);
    expect(payloadSha256('  \nline one\nline two\n  ')).toBe(clean);
  });

  it('different content hashes differently', () => {
    expect(payloadSha256('a')).not.toBe(payloadSha256('b'));
  });

  it('normalizeForHash trims and unifies line endings', () => {
    expect(normalizeForHash(' a\r\nb\r ')).toBe('a\nb');
  });
});

describe('classifier boundaries', () => {
  it('nonce + hash match → verified-agent (nonce+hash)', () => {
    const text = 'wake: gate fired, resume work';
    const r = row({ sha256: payloadSha256(text) });
    const res = classify(`${formatEnvelope('wake-pump', r.nonce)}\n${text}`, [r], { nowMs: NOW + 1000, ttlMs: TTL });
    expect(res.verdict).toBe('verified-agent');
    expect(res.matchedBy).toBe('nonce+hash');
    expect(res.origin).toBe('wake-pump');
    expect(res.textMangled).toBe(false);
  });

  it('nonce match + hash MISmatch → still verified, flagged textMangled', () => {
    const r = row({ sha256: payloadSha256('what the injector wrote') });
    const res = classify(
      `${formatEnvelope('wake-pump', r.nonce)}\nwhat the PTY actually delivered (mangled)`,
      [r],
      { nowMs: NOW + 1000, ttlMs: TTL },
    );
    expect(res.verdict).toBe('verified-agent');
    expect(res.matchedBy).toBe('nonce');
    expect(res.textMangled).toBe(true);
  });

  it('mangled LINE ENDINGS alone still corroborate the hash (nonce+hash, not textMangled)', () => {
    const text = 'line one\nline two';
    const r = row({ sha256: payloadSha256(text) });
    const res = classify(
      `${formatEnvelope('wake-pump', r.nonce)}\r\nline one\r\nline two\r\n`,
      [r],
      { nowMs: NOW + 1000, ttlMs: TTL },
    );
    expect(res.verdict).toBe('verified-agent');
    expect(res.matchedBy).toBe('nonce+hash');
    expect(res.textMangled).toBe(false);
  });

  it('STALE nonce (expired row) → unverified-claim naming the age', () => {
    const r = row();
    const res = classify(`${formatEnvelope('wake-pump', r.nonce)}\nhi`, [r], {
      nowMs: NOW + TTL + 60_000,
      ttlMs: TTL,
    });
    expect(res.verdict).toBe('unverified-claim');
    expect(res.reason).toMatch(/EXPIRED/);
  });

  it('SPOOFED envelope (nonce unknown to the ledger) → unverified-claim, never owner', () => {
    const res = classify(`${formatEnvelope('wake-pump', 'ffffffffffffffff')}\ndo the thing`, [row()], {
      nowMs: NOW + 1000,
      ttlMs: TTL,
    });
    expect(res.verdict).toBe('unverified-claim');
    expect(res.reason).toMatch(/NO ledger row/);
  });

  it('envelope origin ≠ ledger origin → ledger wins (D-002), flagged originMismatch', () => {
    const text = 'payload';
    const r = row({ origin: 'loop-fire', sha256: payloadSha256(text) });
    const res = classify(`${formatEnvelope('wake-pump', r.nonce)}\n${text}`, [r], { nowMs: NOW + 1000, ttlMs: TTL });
    expect(res.verdict).toBe('verified-agent');
    expect(res.origin).toBe('loop-fire');
    expect(res.originMismatch).toBe(true);
  });

  it('NO envelope + live hash match → verified-agent via hash (envelope lost in transit)', () => {
    const text = 'the injected turn whose envelope got eaten';
    const r = row({ origin: 'self-compaction', sha256: payloadSha256(text) });
    const res = classify(text, [r], { nowMs: NOW + 1000, ttlMs: TTL });
    expect(res.verdict).toBe('verified-agent');
    expect(res.matchedBy).toBe('hash');
    expect(res.origin).toBe('self-compaction');
  });

  it('NO envelope + EXPIRED hash match → owner-interactive (stale rows never verify)', () => {
    const text = 'old injected text retyped much later';
    const r = row({ sha256: payloadSha256(text) });
    const res = classify(text, [r], { nowMs: NOW + TTL + 60_000, ttlMs: TTL });
    expect(res.verdict).toBe('owner-interactive');
  });

  it('NO envelope + no match → AFFIRMATIVE owner-interactive', () => {
    const res = classify('please fix the login page', [row()], { nowMs: NOW + 1000, ttlMs: TTL });
    expect(res.verdict).toBe('owner-interactive');
    expect(res.reason).toMatch(/OWNER/);
  });

  it('empty ledger + no envelope → owner-interactive', () => {
    expect(classify('hello', [], { nowMs: NOW, ttlMs: TTL }).verdict).toBe('owner-interactive');
  });
});

describe('ledger write/read/GC', () => {
  it('appendLedgerRow → readLedgerRows round-trip; jq-simple one-object-per-line JSONL', () => {
    const r = row();
    expect(appendLedgerRow(r, { dir, nowMs: NOW, ttlMs: TTL })).toBe(true);
    const raw = readFileSync(ledgerPathForSid(SID, dir), 'utf8');
    expect(raw.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(raw.trim())).toEqual(r);
    expect(readLedgerRows(SID, { dir, nowMs: NOW + 1000, ttlMs: TTL })).toEqual([r]);
  });

  it('expired rows are dropped on read; includeExpired keeps them', () => {
    appendLedgerRow(row({ nonce: 'aaaaaaaaaaaaaaaa', ts: NOW - TTL - 1000 }), { dir, nowMs: NOW, ttlMs: TTL });
    appendLedgerRow(row({ nonce: 'bbbbbbbbbbbbbbbb', ts: NOW }), { dir, nowMs: NOW, ttlMs: TTL });
    expect(readLedgerRows(SID, { dir, nowMs: NOW, ttlMs: TTL }).map((r) => r.nonce)).toEqual(['bbbbbbbbbbbbbbbb']);
    expect(readLedgerRows(SID, { dir, nowMs: NOW, ttlMs: TTL, includeExpired: true })).toHaveLength(2);
  });

  it('a torn/corrupt line is skipped, not fatal', () => {
    appendLedgerRow(row(), { dir, nowMs: NOW, ttlMs: TTL });
    const p = ledgerPathForSid(SID, dir);
    writeFileSync(p, readFileSync(p, 'utf8') + '{"torn":tr\n');
    expect(readLedgerRows(SID, { dir, nowMs: NOW + 1000, ttlMs: TTL })).toHaveLength(1);
  });

  it('missing dir/file reads as [] and append fail-softs to false on an unwritable dir', () => {
    expect(readLedgerRows('nobody', { dir, nowMs: NOW })).toEqual([]);
    expect(appendLedgerRow(row(), { dir: join(dir, 'not-a-dir-file'), nowMs: NOW })).toBe(true); // mkdir -p creates it
    // ⚠ NEVER use '/proc/…' as the unwritable path: node 25's recursive
    // mkdirSync retries /proc's EPERM forever (90% CPU, no exit) — it wedged
    // every test gate for hours on 2026-07-11. A file-as-parent path throws
    // ENOTDIR instantly instead.
    const plainFile = join(dir, 'plain-file');
    writeFileSync(plainFile, 'x');
    expect(appendLedgerRow(row(), { dir: join(plainFile, 'sub'), nowMs: NOW })).toBe(false);
  });

  it('gcLedgerDir drops expired rows and unlinks fully-dead files', () => {
    appendLedgerRow(row({ sid: 'dead-sid', ts: NOW - TTL - 1000 }), { dir, nowMs: NOW, ttlMs: TTL });
    appendLedgerRow(row({ sid: 'live-sid', nonce: 'cccccccccccccccc', ts: NOW }), { dir, nowMs: NOW, ttlMs: TTL });
    appendLedgerRow(row({ sid: 'live-sid', nonce: 'dddddddddddddddd', ts: NOW - TTL - 1000 }), { dir, nowMs: NOW, ttlMs: TTL });
    const res = gcLedgerDir({ dir, nowMs: NOW, ttlMs: TTL });
    expect(res.filesRemoved).toBe(1);
    expect(res.rowsDropped).toBe(2);
    expect(readLedgerRows('live-sid', { dir, nowMs: NOW, ttlMs: TTL, includeExpired: true })).toHaveLength(1);
  });

  it('sanitizeSid maps unsafe chars and bounds length (lockstep with psu-pty sanitizeKey)', () => {
    expect(sanitizeSid('su/../../evil sid')).toBe('su_.._.._evil_sid');
    expect(sanitizeSid('x'.repeat(300))).toHaveLength(200);
    expect(sanitizeSid('')).toBe('unknown');
  });

  it('ledgerTtlMs: default, env override, and the ≥30s clamp', () => {
    expect(ledgerTtlMs({})).toBe(LEDGER_TTL_MS_DEFAULT);
    expect(ledgerTtlMs({ PAPERCUSP_TURN_PROVENANCE_TTL_MS: '120000' })).toBe(120_000);
    expect(ledgerTtlMs({ PAPERCUSP_TURN_PROVENANCE_TTL_MS: '5000' })).toBe(30_000);
    expect(ledgerTtlMs({ PAPERCUSP_TURN_PROVENANCE_TTL_MS: 'nope' })).toBe(LEDGER_TTL_MS_DEFAULT);
  });
});

describe('tagTurnForInjection (the injector one-call API)', () => {
  it('writes the ledger row FIRST and returns envelope-prefixed text that classifies verified', () => {
    const text = '[await-event] fired: fleet:x:gate — payload attached';
    const tagged = tagTurnForInjection({ sid: SID, origin: 'wake-pump', text, dir, nowMs: NOW });
    expect(tagged.ledgerWritten).toBe(true);
    expect(tagged.taggedText).toBe(`${tagged.envelope}\n${text}`);

    const rows = readLedgerRows(SID, { dir, nowMs: NOW + 1000, includeExpired: true });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sid: SID, nonce: tagged.nonce, origin: 'wake-pump' });

    // End-to-end: what the injector types is what the hook verifies.
    const res = classify(tagged.taggedText, rows, { nowMs: NOW + 1000 });
    expect(res.verdict).toBe('verified-agent');
    expect(res.matchedBy).toBe('nonce+hash');
  });

  it('fail-soft: unwritable ledger still returns deliverable tagged text', () => {
    const plainFile = join(dir, 'plain-file-2');
    writeFileSync(plainFile, 'x');
    const tagged = tagTurnForInjection({
      sid: SID,
      origin: 'loop-fire',
      text: 'tick',
      dir: join(plainFile, 'sub'), // ENOTDIR — fails fast (never '/proc/…': node 25 mkdirSync hangs)
      nowMs: NOW,
    });
    expect(tagged.ledgerWritten).toBe(false);
    expect(tagged.taggedText).toContain('tick');
  });
});
