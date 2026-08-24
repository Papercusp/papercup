/**
 * Unit coverage for the LSP adapter's pure decision functions.
 *
 * WI-40224 / WI-41090 — the false-empty class. Per-intent readiness decides WHEN to
 * answer; `healthForAnswer` decides whether an answer may be BELIEVED. The
 * second is what this file guards, because it is the durable half: a
 * readiness bug is bounded, but a readiness bug that also certifies its own
 * output as trustworthy turns a temporary gap into an authoritative lie.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  canaryReadinessIsStable,
  certifyCanaryAnswer,
  ensureOpen,
  healthForAnswer,
  readinessStrategyFor,
  specForLanguage,
  resolveServerBin,
  type LspReadinessIntent,
} from './lsp-adapter.ts';
import { isTrustworthyEmpty, type BackendHealth } from './contracts.ts';

type Client = {
  health: BackendHealth;
  certifiedReadiness?: ReadonlySet<LspReadinessIntent>;
  unprovenReadiness?: ReadonlySet<LspReadinessIntent>;
};

const rust = (over: Partial<Client> = {}): Client => ({
  health: 'healthy',
  ...over,
});
const ts = (over: Partial<Client> = {}): Client => ({
  health: 'healthy',
  ...over,
});

describe('healthForAnswer — an empty answer must earn the right to be believed', () => {
  it('REFUSES to certify an empty from a rust server that never reported quiescent', () => {
    // The exact measured defect: rust-analyzer answered implementations
    // healthy-and-EMPTY while still indexing, and isTrustworthyEmpty blessed
    // it, so an agent asking "who implements this trait?" was told "nobody".
    expect(healthForAnswer(rust(), 'references', 0)).toBe('degraded');
  });

  it('REFUSES to certify an empty while the server says it is NOT quiescent', () => {
    expect(healthForAnswer(rust(), 'implementations', 0)).toBe('degraded');
  });

  it('certifies an empty once the server itself reports quiescent', () => {
    // The positive case — without this the guard would just break Rust empties
    // permanently, which is not a fix.
    expect(
      healthForAnswer(
        rust({ certifiedReadiness: new Set<LspReadinessIntent>(['references']) }),
        'references',
        0,
      ),
    ).toBe('healthy');
  });

  it('does NOT withhold trust from a NON-EMPTY answer', () => {
    // Deliberate asymmetry: sites are positive evidence and cannot be a
    // false-empty. Degrading them would suppress good answers for no gain.
    expect(healthForAnswer(rust(), 'references', 3)).toBe('healthy');
    expect(healthForAnswer(rust(), 'implementations', 1)).toBe('healthy');
  });

  it('defaults an unproven TypeScript empty to degraded too', () => {
    expect(healthForAnswer(ts(), 'symbol-search', 0)).toBe('degraded');
  });

  it("one intent's proof never certifies another intent's empty", () => {
    const client = ts({ certifiedReadiness: new Set<LspReadinessIntent>(['definition']) });
    expect(healthForAnswer(client, 'definition', 0)).toBe('healthy');
    expect(healthForAnswer(client, 'references', 0)).toBe('degraded');
  });

  it('never UPGRADES health — an unhealthy server stays unhealthy', () => {
    const proof = new Set<LspReadinessIntent>(['references']);
    expect(healthForAnswer(rust({ health: 'unhealthy', certifiedReadiness: proof }), 'references', 0)).toBe(
      'unhealthy',
    );
    expect(healthForAnswer(rust({ health: 'degraded', certifiedReadiness: proof }), 'references', 0)).toBe(
      'degraded',
    );
    expect(healthForAnswer(rust({ health: 'unknown' }), 'references', 5)).toBe('unknown');
  });
});

describe('canary readiness — a first positive answer is not proof of completeness', () => {
  type CanaryClient = {
    language: 'typescript';
    health: BackendHealth;
    progressGeneration: number;
    certifiedReadiness: Set<LspReadinessIntent>;
    canaryReadiness: Map<LspReadinessIntent, {
      siteCount: number;
      progressGeneration: number;
      sawProgressBoundary: boolean;
      sawAnswerChange: boolean;
    }>;
    unprovenReadiness: Set<LspReadinessIntent>;
  };

  const canaryClient = (): CanaryClient => ({
    language: 'typescript',
    health: 'healthy',
    progressGeneration: 0,
    certifiedReadiness: new Set(),
    canaryReadiness: new Map(),
    unprovenReadiness: new Set(),
  });

  it('rejects a first positive sample and a stable early partial plateau', () => {
    const client = canaryClient();
    const adapterClient = client as unknown as Parameters<typeof certifyCanaryAnswer>[0];

    expect(certifyCanaryAnswer(adapterClient, 'references', 'canary', 2)).toBe(false);
    expect(healthForAnswer(client, 'references', 2)).toBe('degraded');

    // A progress boundary alone must not bless the same early partial answer.
    client.progressGeneration = 1;
    expect(certifyCanaryAnswer(adapterClient, 'references', 'canary', 2)).toBe(false);
    expect(healthForAnswer(client, 'references', 2)).toBe('degraded');
    expect(client.certifiedReadiness.has('references')).toBe(false);
  });

  it('requires a changed answer followed by a stable post-progress sample', () => {
    const client = canaryClient();
    const adapterClient = client as unknown as Parameters<typeof certifyCanaryAnswer>[0];

    expect(certifyCanaryAnswer(adapterClient, 'references', 'canary', 2)).toBe(false);
    client.progressGeneration = 1;
    // The index has advanced, but this first larger answer is still only a
    // candidate; it has not yet demonstrated stability after the transition.
    expect(certifyCanaryAnswer(adapterClient, 'references', 'canary', 198)).toBe(false);
    expect(healthForAnswer(client, 'references', 198)).toBe('degraded');

    expect(certifyCanaryAnswer(adapterClient, 'references', 'canary', 198)).toBe(true);
    expect(healthForAnswer(client, 'references', 198)).toBe('healthy');
    expect(client.certifiedReadiness.has('references')).toBe(true);
  });

  it('keeps the proof ledger per intent', () => {
    const client = canaryClient();
    const adapterClient = client as unknown as Parameters<typeof certifyCanaryAnswer>[0];

    expect(certifyCanaryAnswer(adapterClient, 'references', 'canary', 2)).toBe(false);
    client.progressGeneration = 1;
    expect(certifyCanaryAnswer(adapterClient, 'references', 'canary', 198)).toBe(false);
    expect(certifyCanaryAnswer(adapterClient, 'references', 'canary', 198)).toBe(true);

    expect(client.certifiedReadiness.has('references')).toBe(true);
    expect(healthForAnswer(client, 'definition', 0)).toBe('degraded');
    expect(healthForAnswer(client, 'definition', 1)).toBe('healthy');
  });

  it('defines stable as same answer only after both required transitions', () => {
    const first = {
      siteCount: 2,
      progressGeneration: 0,
      sawProgressBoundary: false,
      sawAnswerChange: false,
    };
    expect(canaryReadinessIsStable(undefined, first)).toBe(false);
    expect(
      canaryReadinessIsStable(first, {
        ...first,
        progressGeneration: 1,
        sawProgressBoundary: true,
      }),
    ).toBe(false);
    expect(
      canaryReadinessIsStable(
        { ...first, sawProgressBoundary: true, sawAnswerChange: true },
        {
          siteCount: 198,
          progressGeneration: 1,
          sawProgressBoundary: true,
          sawAnswerChange: true,
        },
      ),
    ).toBe(false);
    expect(
      canaryReadinessIsStable(
        { siteCount: 198, progressGeneration: 1, sawProgressBoundary: true, sawAnswerChange: true },
        { siteCount: 198, progressGeneration: 1, sawProgressBoundary: true, sawAnswerChange: true },
      ),
    ).toBe(true);
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
    const health = healthForAnswer(rust(), 'references', 0);
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
    const health = healthForAnswer(
      rust({ certifiedReadiness: new Set<LspReadinessIntent>(['references']) }),
      'references',
      0,
    );
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

  it('declares readiness per language AND intent rather than hardcoding rust', () => {
    expect(readinessStrategyFor('rust', 'definition')).toEqual({
      kind: 'progress-signal',
      intent: 'definition',
    });
    expect(readinessStrategyFor('typescript', 'definition')).toEqual({
      kind: 'settle-window',
      intent: 'definition',
      settleMs: 5_000,
    });
    expect(readinessStrategyFor('typescript', 'references')).toEqual({
      kind: 'canary-query',
      intent: 'references',
      minimumSites: 1,
    });
  });

  it('uses the conservative canary default for an unmeasured intent', () => {
    expect(specForLanguage('typescript').readinessStrategy['symbol-search']).toBeUndefined();
    expect(readinessStrategyFor('typescript', 'symbol-search')).toEqual({
      kind: 'canary-query',
      intent: 'symbol-search',
      minimumSites: 1,
    });
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
