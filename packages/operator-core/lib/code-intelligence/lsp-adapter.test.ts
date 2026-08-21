/**
 * Unit coverage for the LSP adapter's pure decision functions.
 *
 * WI-40224 — the false-empty class. `awaitProjectReady` decides WHEN to
 * answer; `healthForAnswer` decides whether an answer may be BELIEVED. The
 * second is what this file guards, because it is the durable half: a
 * readiness bug is bounded, but a readiness bug that also certifies its own
 * output as trustworthy turns a temporary gap into an authoritative lie.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensureOpen, healthForAnswer, specForLanguage, resolveServerBin } from './lsp-adapter.ts';
import { isTrustworthyEmpty, type BackendHealth } from './contracts.ts';

type Client = { health: BackendHealth; language: 'typescript' | 'rust'; quiescent: boolean | null };

const rust = (over: Partial<Client> = {}): Client => ({
  health: 'healthy',
  language: 'rust',
  quiescent: null,
  ...over,
});
const ts = (over: Partial<Client> = {}): Client => ({
  health: 'healthy',
  language: 'typescript',
  quiescent: null,
  ...over,
});

describe('healthForAnswer — an empty answer must earn the right to be believed', () => {
  it('REFUSES to certify an empty from a rust server that never reported quiescent', () => {
    // The exact measured defect: rust-analyzer answered implementations
    // healthy-and-EMPTY while still indexing, and isTrustworthyEmpty blessed
    // it, so an agent asking "who implements this trait?" was told "nobody".
    expect(healthForAnswer(rust({ quiescent: null }), 0)).toBe('degraded');
  });

  it('REFUSES to certify an empty while the server says it is NOT quiescent', () => {
    expect(healthForAnswer(rust({ quiescent: false }), 0)).toBe('degraded');
  });

  it('certifies an empty once the server itself reports quiescent', () => {
    // The positive case — without this the guard would just break Rust empties
    // permanently, which is not a fix.
    expect(healthForAnswer(rust({ quiescent: true }), 0)).toBe('healthy');
  });

  it('does NOT withhold trust from a NON-EMPTY answer', () => {
    // Deliberate asymmetry: sites are positive evidence and cannot be a
    // false-empty. Degrading them would suppress good answers for no gain.
    expect(healthForAnswer(rust({ quiescent: null }), 3)).toBe('healthy');
    expect(healthForAnswer(rust({ quiescent: false }), 1)).toBe('healthy');
  });

  it('leaves TypeScript empties alone — it does not announce indexing this way', () => {
    // Scope control: the rule is for servers in REQUIRES_PROGRESS_SIGNAL. If
    // it fired for tsserver too, every clean TypeScript answer would degrade.
    expect(healthForAnswer(ts({ quiescent: null }), 0)).toBe('healthy');
  });

  it('never UPGRADES health — an unhealthy server stays unhealthy', () => {
    expect(healthForAnswer(rust({ health: 'unhealthy', quiescent: true }), 0)).toBe('unhealthy');
    expect(healthForAnswer(rust({ health: 'degraded', quiescent: true }), 0)).toBe('degraded');
    expect(healthForAnswer(rust({ health: 'unknown', quiescent: true }), 5)).toBe('unknown');
  });
});

describe('healthForAnswer composes with isTrustworthyEmpty (the contract that consumes it)', () => {
  const answerWith = (health: BackendHealth) => ({
    sites: [] as never[],
    error: null,
    freshness: { health, indexedAt: null, staleVsDisk: null, indexedCommit: null },
  });

  it('the degraded verdict actually makes the empty UNTRUSTWORTHY end to end', () => {
    // The whole point of returning 'degraded' rather than logging a warning:
    // isTrustworthyEmpty is the function callers use to decide whether an
    // empty means "none exist". This asserts the two agree.
    const health = healthForAnswer(rust({ quiescent: null }), 0);
    expect(isTrustworthyEmpty(answerWith(health) as never)).toBe(false);
  });

  it('CONTROL: the pre-fix behaviour really did bless it', () => {
    // Falsifiability control. Had the adapter kept reporting client.health,
    // this is what the caller would have seen — a trustworthy empty. If this
    // control ever fails, isTrustworthyEmpty changed underneath us and the
    // guard above may be passing for the wrong reason.
    expect(isTrustworthyEmpty(answerWith('healthy') as never)).toBe(true);
  });

  it('a quiescent server still produces a trustworthy empty', () => {
    const health = healthForAnswer(rust({ quiescent: true }), 0);
    expect(isTrustworthyEmpty(answerWith(health) as never)).toBe(true);
  });
});

/**
 * WI-40250 — the recurrence guard for the `else-is-rust` fallthrough.
 *
 * The original bug was not that rust was wrong; it was that rust was the ELSE
 * ARM. `resolveServerBin` and both `languageId` sites read
 * `if (language === 'typescript') … else <rust>`, so ANY language that was not
 * typescript resolved to the rust-analyzer binary and was labelled `rust`.
 * Widening `LspLanguage` compiled clean and failed only at runtime, as a
 * confident wrong answer rather than an error.
 *
 * These tests fail if that shape ever returns. The important one is the LAST:
 * an unknown language must REFUSE, never silently resolve to some other
 * language's server.
 */
describe('WI-40250 — an unknown language refuses instead of falling through to rust', () => {
  it('gives each known language its OWN languageId, not a binary typescript/rust split', () => {
    expect(specForLanguage('typescript').languageId).toBe('typescript');
    expect(specForLanguage('rust').languageId).toBe('rust');
  });

  it('declares the progress-signal requirement per language rather than hardcoding rust', () => {
    // rust-analyzer indexes before it can answer (WI-40224); tsserver does not.
    expect(specForLanguage('rust').requiresProgressSignal).toBe(true);
    expect(specForLanguage('typescript').requiresProgressSignal).toBe(false);
  });

  it('REFUSES an unknown language loudly, and never hands back another server', () => {
    // Cast is the whole point: this simulates a plain-JS caller, a persisted
    // value, or a request payload carrying a language the union does not know.
    const unknown = 'python' as unknown as Parameters<typeof specForLanguage>[0];

    expect(() => specForLanguage(unknown)).toThrow(/Unknown LSP language/);
    // The regression signature: before the fix this returned the rust-analyzer
    // path instead of throwing.
    expect(() => resolveServerBin(unknown)).toThrow(/Unknown LSP language/);
  });

  it('names the known languages in the refusal, so the fix is obvious at the call site', () => {
    const unknown = 'python' as unknown as Parameters<typeof specForLanguage>[0];
    expect(() => specForLanguage(unknown)).toThrow(/typescript/);
    expect(() => specForLanguage(unknown)).toThrow(/rust/);
  });
});

/**
 * WI-40251 — the recurrence guard for the stale-open-document class.
 *
 * Per the LSP spec an OPEN document's client copy is authoritative and the
 * server MUST ignore disk. The original defect: `ensureOpen` was
 * `if (openDocs.has(uri)) return` — open once, frozen forever — so any write
 * that did not go through `lsp.apply` (Edit/Write via the lock hook, git-sync,
 * the merge-resolver, a human's editor) left the SHARED server answering about
 * text that no longer exists, fleet-wide, while certifying it healthy.
 *
 * The fix is a pull-based stat (mtime+size) on every call. These tests fail if
 * anyone restores the open-once shape: the important assertion is that a
 * mutated file forces didClose + didOpen carrying the NEW text — not a no-op.
 */
describe('WI-40251 — ensureOpen re-opens when disk changed under an open document', () => {
  type Sent = { method: string; params: { textDocument: { uri: string; text?: string; version?: number } } };

  let dir: string;
  let file: string;
  let sent: Sent[];
  let client: Parameters<typeof ensureOpen>[0];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'wi-40251-ensure-open-'));
    file = join(dir, 'subject.ts');
    await writeFile(file, 'export const a = 1;\n');
    sent = [];
    // A minimal fake: ensureOpen touches only language, openDocs, and
    // connection.sendNotification. The cast is deliberate (same style as the
    // WI-40250 suite) — a real LspClient carries a live child process.
    client = {
      language: 'typescript',
      openDocs: new Map<string, { mtimeMs: number; size: number }>(),
      connection: {
        sendNotification: (method: string, params: unknown) => {
          sent.push({ method, params } as Sent);
        },
      },
    } as unknown as Parameters<typeof ensureOpen>[0];
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('first call opens the document with the disk text and stamps it', async () => {
    const uri = await ensureOpen(client, file);

    expect(sent.map((s) => s.method)).toEqual(['textDocument/didOpen']);
    expect(sent[0].params.textDocument.text).toBe('export const a = 1;\n');
    const stamp = (client as unknown as { openDocs: Map<string, { mtimeMs: number; size: number }> }).openDocs.get(uri);
    expect(stamp).toBeDefined();
    expect(stamp!.size).toBe('export const a = 1;\n'.length);
  });

  it('an UNCHANGED file is a no-op — no didClose/didOpen thrash on the hot path', async () => {
    await ensureOpen(client, file);
    sent.length = 0;

    await ensureOpen(client, file);

    expect(sent).toEqual([]);
  });

  it('a file mutated on disk forces didClose + didOpen carrying the NEW text — never a silent stale serve', async () => {
    await ensureOpen(client, file);
    sent.length = 0;

    // Longer content: the size delta makes the staleness detection
    // deterministic even when both writes land in the same mtime millisecond.
    await writeFile(file, 'export const a = 2; // rewritten by a peer\n');
    const uri = await ensureOpen(client, file);

    // The regression signature: before the fix this was [] — open-once, serve
    // stale forever.
    expect(sent.map((s) => s.method)).toEqual(['textDocument/didClose', 'textDocument/didOpen']);
    expect(sent[0].params.textDocument.uri).toBe(uri);
    expect(sent[1].params.textDocument.text).toBe('export const a = 2; // rewritten by a peer\n');
    // Re-open restores the version-1 invariant the rest of the adapter assumes
    // (no incremental sync was ever established).
    expect(sent[1].params.textDocument.version).toBe(1);
  });

  it('re-opening RE-STAMPS, so the next unchanged read is again a no-op (no perpetual thrash)', async () => {
    await ensureOpen(client, file);
    await writeFile(file, 'export const a = 3; // second disk write\n');
    await ensureOpen(client, file);
    sent.length = 0;

    await ensureOpen(client, file);

    expect(sent).toEqual([]);
  });

  it('an unstattable file keeps the copy we hold rather than dropping it', async () => {
    const uri = await ensureOpen(client, file);
    sent.length = 0;

    await rm(file);
    const again = await ensureOpen(client, file);

    expect(again).toBe(uri);
    expect(sent).toEqual([]);
  });
});
