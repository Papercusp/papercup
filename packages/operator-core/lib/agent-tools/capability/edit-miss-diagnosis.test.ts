/**
 * EI-20225459009961868 — capability:edit's `not_found` miss diagnosis.
 *
 * A bare "old_string not found" cannot separate the two hypotheses a caller then
 * acts on: "a peer edited this shared file after I read it" vs "my old_string was
 * simply wrong". These tests pin BOTH directions, because the negative reading (the
 * file has not moved, so stop hunting for a peer) is the one that saves the time.
 *
 * Uses temp paths OUTSIDE any git repo via `mkNonRepoTmpDir`, so guardFileLock runs
 * the body directly with no PG — same rationale as file-tools.test.ts (EI-5826).
 */
import { utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import editTool from './edit';
import { mkNonRepoTmpDir } from '../locks/non-repo-tmpdir';

const DIR = mkNonRepoTmpDir('cap-edit-miss-');
const ctx = {
  projectDir: DIR,
  stateDir: DIR,
  signal: new AbortController().signal,
  emit: () => {},
  progress: () => {},
  log: () => {},
} as never;

let seq = 0;
/** Write a file; `ageSec` backdates its mtime so the staleness branch is testable. */
function fixture(body: string, ageSec = 0): string {
  const f = join(DIR, `m${seq++}.ts`);
  writeFileSync(f, body);
  if (ageSec > 0) {
    const then = Date.now() / 1000 - ageSec;
    utimesSync(f, then, then);
  }
  return f;
}

async function edit(file: string, old_string: string, new_string: string) {
  const r = (await editTool.handler!({ file_path: file, old_string, new_string }, ctx)) as {
    isError?: boolean;
    content: Array<{ text: string }>;
  };
  return { isError: r.isError, ...(JSON.parse(r.content[0].text) as { ok: boolean; reason?: string; message?: string }) };
}

describe('capability:edit not_found diagnosis', () => {
  it('keeps the reason code stable — callers branch on `not_found`, not on the prose', async () => {
    // The whole change is message-only by design; a reason rename would be a
    // silent contract break for anything matching on it.
    const f = fixture('hello\n');
    const r = await edit(f, 'nope', 'x');
    expect(r.isError).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('not_found');
  });

  it('reports an already-applied edit instead of inviting a blind re-apply', async () => {
    // The peer (or your own earlier attempt) already made this exact change.
    const f = fixture('const timeout = 5000;\n');
    const r = await edit(f, 'const timeout = 1000;', 'const timeout = 5000;');
    expect(r.reason).toBe('not_found');
    expect(r.message).toContain('ALREADY present');
    expect(r.message).toMatch(/re-read before retrying/i);
  });

  it('names whitespace drift as whitespace drift, with a count', async () => {
    // Classic patch-context miss: the text is there, the indentation is not what
    // was copied. Without this the caller reads it as "the code is gone".
    const f = fixture('function go() {\n      return   compute( a,  b );\n}\n');
    const r = await edit(f, 'return compute( a, b );', 'return compute(b, a);');
    expect(r.reason).toBe('not_found');
    expect(r.message).toContain('whitespace-insensitive match exists (1×)');
    expect(r.message).toMatch(/copy it verbatim/i);
  });

  it('flags a recently-written file as a possible peer race, without asserting who wrote it', async () => {
    const f = fixture('alpha\n');
    const r = await edit(f, 'beta', 'gamma');
    expect(r.message).toMatch(/last written \d+s ago/);
    expect(r.message).toContain('if that write was not your own');
    // mtime cannot identify an author, so the peer claim must stay CONDITIONAL:
    // the qualifier has to PRECEDE it, never trail it as an afterthought. A
    // confident wrong attribution is worse than no attribution at all.
    const qualifier = r.message!.indexOf('if that write was not your own');
    const peerClaim = r.message!.indexOf('a peer changed it');
    expect(qualifier).toBeGreaterThanOrEqual(0);
    expect(peerClaim).toBeGreaterThan(qualifier);
    expect(r.message).not.toMatch(/was changed by/i);
  });

  it('RULES OUT a peer race on an untouched file — the negative that stops the hunt', async () => {
    // The falsifiability control for the branch above: same missing string, only
    // the mtime differs, and the verdict must invert. If both inputs produced the
    // same "peer may have edited it" prose, the signal would be decorative.
    const f = fixture('alpha\n', 60 * 60 * 26);
    const r = await edit(f, 'beta', 'gamma');
    expect(r.message).toContain('has not been written for');
    expect(r.message).toContain('a peer edit since your read is unlikely');
    expect(r.message).toContain('check old_string itself');
    expect(r.message).not.toContain('if that write was not your own');
  });

  it('prefers the already-applied reading over whitespace drift when both could fire', async () => {
    // Ordering matters: already-applied is the reading where retrying is HARMFUL,
    // so it must not be masked by the softer whitespace note.
    const f = fixture('const  a = 1;\nconst b = 2;\n');
    const r = await edit(f, 'const a = 1;', 'const b = 2;');
    expect(r.message).toContain('ALREADY present');
    expect(r.message).not.toContain('whitespace-insensitive');
  });

  it('formats ages in human units rather than raw seconds', async () => {
    const f = fixture('alpha\n', 60 * 60 * 5);
    const r = await edit(f, 'beta', 'gamma');
    expect(r.message).toMatch(/has not been written for 5h/);
  });

  it('adds nothing to a successful edit', async () => {
    // Diagnosis is failure-path only: no prose, and no cost, on the hot path.
    const f = fixture('const x = 1;\n');
    const r = await edit(f, 'const x = 1;', 'const x = 2;');
    expect(r.ok).toBe(true);
    expect(r.message).toBeUndefined();
  });

  it('does not invent a whitespace match for a genuinely absent string', async () => {
    // Guards the squash from over-matching: a string that is simply not there must
    // not be reported as present-but-differently-spaced.
    const f = fixture('function go() {\n  return 1;\n}\n', 60 * 60 * 26);
    const r = await edit(f, 'return somethingElseEntirely();', 'return 2;');
    expect(r.message).not.toContain('whitespace-insensitive');
    expect(r.message).not.toContain('ALREADY present');
  });
});
