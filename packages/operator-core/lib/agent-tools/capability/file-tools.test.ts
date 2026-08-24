/**
 * Unit tests for the capability file tools (P-010, B-05): read / write / edit.
 * Uses temp paths OUTSIDE any git repo, so the file lock is uncoordinated and
 * guardFileLock runs the body directly (no PG) — the lock control-flow itself
 * is covered in locks/file-lock-guard.test.ts.
 *
 * The "outside any git repo" guarantee comes from `mkNonRepoTmpDir`, NOT a raw
 * `mkdtempSync(os.tmpdir())`: when the suite runner's TMPDIR resolves inside this
 * monorepo, a bare os.tmpdir() temp dir has the monorepo `.git` as an ancestor,
 * so guardFileLock treats the path as coordinated and tries to resolve identity
 * (no identity on the test ctx → throws). That is EI-5826 (the EI-5541 class).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import readTool from './read';
import writeTool from './write';
import editTool from './edit';
import { mkNonRepoTmpDir } from '../locks/non-repo-tmpdir';
import { writeScratchReference } from '../../scratch-reference';

const DIR = mkNonRepoTmpDir('cap-file-');
const baseCtx = {
  projectDir: DIR,
  stateDir: DIR,
  signal: new AbortController().signal,
  emit: () => {},
  progress: () => {},
  log: () => {},
};
const ctx = baseCtx as never;

function parse(r: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(r.content[0].text);
}

describe('capability:read', () => {
  it('returns numbered lines', async () => {
    const f = join(DIR, 'r.txt');
    writeFileSync(f, 'alpha\nbravo\ncharlie\n');
    const r = (await readTool.handler!({ file_path: f }, ctx)) as { content: Array<{ text: string }> };
    const text = r.content[0].text;
    expect(text).toContain('alpha');
    expect(text).toMatch(/\s+1\talpha/);
    expect(text).toMatch(/\s+3\tcharlie/);
  });

  it('returns exact undecorated text for a write-safe whole-file read', async () => {
    const f = join(DIR, 'r-raw.txt');
    const original = 'alpha\n     2\tbravo\ncharlie (3 lines)\n';
    writeFileSync(f, original);
    const r = (await readTool.handler!({ file_path: f, raw: true }, ctx)) as { content: Array<{ text: string }> };

    expect(r.content[0].text).toBe(original);
    expect(r.content[0].text).not.toContain(`${f} (`);
  });

  it('preserves exact delimiters for raw line windows', async () => {
    const f = join(DIR, 'r-raw-window.txt');
    writeFileSync(f, 'first\nsecond\nthird');

    const r = (await readTool.handler!({ file_path: f, offset: 2, limit: 2, raw: true }, ctx)) as {
      content: Array<{ text: string }>;
    };

    expect(r.content[0].text).toBe('second\nthird');
  });

  it('rejects raw text mode mixed with exact byte pages', async () => {
    const f = join(DIR, 'r-raw-mixed.txt');
    writeFileSync(f, 'alpha\n');
    const r = (await readTool.handler!({ file_path: f, raw: true, byte_offset: 0, byte_limit: 32 }, ctx)) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };

    expect(r.isError).toBe(true);
    expect(parse(r).reason).toBe('mixed_window_modes');
  });

  it('honors offset + limit', async () => {
    const f = join(DIR, 'r2.txt');
    writeFileSync(f, Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join('\n'));
    const r = (await readTool.handler!({ file_path: f, offset: 4, limit: 2 }, ctx)) as { content: Array<{ text: string }> };
    const text = r.content[0].text;
    expect(text).toContain('line4');
    expect(text).toContain('line5');
    expect(text).not.toContain('line6');
    expect(text).toContain('more lines');
  });

  it('returns exact resumable byte pages for a single long line', async () => {
    const f = join(DIR, 'r-bytes.json');
    const original = Buffer.from(JSON.stringify({ value: '🙂'.repeat(4_000) }), 'utf8');
    writeFileSync(f, original);

    const recovered: Buffer[] = [];
    let byteOffset = 0;
    let eof = false;
    while (!eof) {
      const r = (await readTool.handler!({
        file_path: f,
        byte_offset: byteOffset,
        byte_limit: 997,
      }, ctx)) as { content: Array<{ text: string }> };
      const page = parse(r) as {
        encoding: string;
        data: string;
        eof: boolean;
        next_cursor: { args: { byte_offset: number } } | null;
      };
      expect(page.encoding).toBe('base64');
      recovered.push(Buffer.from(page.data, 'base64'));
      eof = page.eof;
      if (!eof) byteOffset = page.next_cursor!.args.byte_offset;
    }

    expect(Buffer.concat(recovered)).toEqual(original);
  });

  it('accepts a result-door papercusp://scratch URI as a byte-page alias', async () => {
    const previousScratchRoot = process.env.PAPERCUSP_SCRATCH_ROOT;
    const scratchRoot = join(DIR, 'result-door-scratch');
    const uri = 'papercusp://scratch/test-workspace/work_items:get/77777777-8888-4999-8aaa-bbbbbbbbbbbb/spill.md';
    const file = join(
      scratchRoot,
      'test-workspace',
      'work_items:get',
      '77777777-8888-4999-8aaa-bbbbbbbbbbbb',
      'spill.md',
    );
    const original = Buffer.from('spill header\nrecovered bytes\n', 'utf8');
    process.env.PAPERCUSP_SCRATCH_ROOT = scratchRoot;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, original);

    try {
      const r = (await readTool.handler!({ uri, byte_offset: 0, byte_limit: 512 }, ctx)) as {
        content: Array<{ text: string }>;
        isError?: boolean;
      };
      expect(r.isError).not.toBe(true);
      const page = parse(r) as { ok: boolean; data: string; byte_length: number };
      expect(page.ok).toBe(true);
      expect(Buffer.from(page.data, 'base64')).toEqual(original);
      expect(page.byte_length).toBe(original.length);
    } finally {
      if (previousScratchRoot === undefined) delete process.env.PAPERCUSP_SCRATCH_ROOT;
      else process.env.PAPERCUSP_SCRATCH_ROOT = previousScratchRoot;
    }
  });

  it('unwraps and authorizes stable references before applying byte windows', async () => {
    const f = join(DIR, 'stable-reference.bin');
    writeScratchReference({
      filePath: f,
      payload: 'first line\nsecond line\n',
      workspaceId: 'ws-1',
      audience: 'workspace',
      mediaType: 'text/plain',
    });
    const r = (await readTool.handler!({
      file_path: f,
      byte_offset: 0,
      byte_limit: 512,
    }, { ...baseCtx, workspaceId: 'ws-1' } as never)) as { content: Array<{ text: string }> };
    const page = parse(r) as { data: string; reference: { workspaceId: string; sha256: string } };
    expect(Buffer.from(page.data, 'base64').toString('utf8')).toBe('first line\nsecond line\n');
    expect(page.reference.workspaceId).toBe('ws-1');
    expect(page.reference.sha256).toMatch(/^[a-f0-9]{64}$/);

    const lines = (await readTool.handler!({
      file_path: f,
      offset: 2,
      limit: 1,
    }, { ...baseCtx, workspaceId: 'ws-1' } as never)) as { content: Array<{ text: string }> };
    expect(lines.content[0].text).toContain('second line');
    expect(lines.content[0].text).not.toContain('first line');
  });

  it('selects only requested MCP content items and rejects the wrong owner', async () => {
    const f = join(DIR, 'owner-reference.json');
    writeScratchReference({
      filePath: f,
      payload: JSON.stringify({
        content: [
          { type: 'text', text: 'omit me' },
          { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
          { type: 'text', text: 'keep me too' },
        ],
        isError: false,
      }),
      workspaceId: 'ws-1',
      ownerId: 'su-owner',
      mediaType: 'application/json',
    });
    const ownerCtx = {
      ...baseCtx,
      workspaceId: 'ws-1',
      uiClientId: 'su-owner',
      isSuperuser: true,
    };
    const selected = (await readTool.handler!({
      file_path: f,
      content_indexes: [2, 1, 2],
    }, ownerCtx as never)) as { content: Array<{ text: string }> };
    expect(parse(selected)).toMatchObject({
      selected_indexes: [2, 1],
      total_content_items: 3,
      content: [
        { type: 'text', text: 'keep me too' },
        { type: 'image', mimeType: 'image/png' },
      ],
    });

    const denied = (await readTool.handler!({
      file_path: f,
      byte_offset: 0,
      byte_limit: 512,
    }, { ...ownerCtx, uiClientId: 'su-other' } as never)) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    expect(denied.isError).toBe(true);
    expect(parse(denied).reason).toBe('forbidden_reference');
  });

  it('resolves one typed evidence class from a shared result-door reference', async () => {
    const f = join(DIR, 'evidence-reference.json');
    writeScratchReference({
      filePath: f,
      payload: JSON.stringify({
        content: [{ type: 'text', text: JSON.stringify({ events: [{ status: 'fired' }], fleet: { alive: 2 } }) }],
      }),
      workspaceId: 'ws-1',
      mediaType: 'application/json',
      evidence: [
        { evidenceClass: 'event', contentIndex: 0, jsonPointers: ['/events'] },
        { evidenceClass: 'fleet', contentIndex: 0, jsonPointers: ['/fleet'] },
      ],
    });
    const selected = (await readTool.handler!({
      file_path: f,
      evidence_class: 'event',
    }, { ...baseCtx, workspaceId: 'ws-1' } as never)) as { content: Array<{ text: string }> };
    expect(parse(selected)).toMatchObject({
      ok: true,
      evidence_class: 'event',
      evidence: [{ contentIndex: 0, jsonPointer: '/events', value: [{ status: 'fired' }] }],
    });
  });

  it('advertises and enforces evidence-class window exclusivity', async () => {
    const shape = (readTool as unknown as { args: { shape: Record<string, { description?: string }> } }).args.shape;
    expect(shape.evidence_class.description).toMatch(/Mutually exclusive with content_indexes/);
    expect(shape.evidence_class.description).toMatch(/byte_offset/);

    const f = join(DIR, 'evidence-mixed-window.json');
    writeFileSync(f, '{}');
    const mixed = (await readTool.handler!({
      file_path: f,
      evidence_class: 'event',
      byte_offset: 0,
      byte_limit: 32,
    }, ctx)) as { content: Array<{ text: string }>; isError?: boolean };
    expect(mixed.isError).toBe(true);
    expect(parse(mixed).reason).toBe('mixed_window_modes');
  });

  it('rejects a non-scratch URI instead of resolving it under the project directory', async () => {
    const r = (await readTool.handler!({ uri: 'papercusp://not-scratch/file', byte_offset: 0, byte_limit: 512 }, ctx)) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    expect(r.isError).toBe(true);
    expect(parse(r).reason).toBe('invalid_path');
  });

  it('rejects incomplete or mixed byte windows', async () => {
    const f = join(DIR, 'r-byte-invalid.txt');
    writeFileSync(f, 'hello');
    const incomplete = (await readTool.handler!({ file_path: f, byte_offset: 0 }, ctx)) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    expect(incomplete.isError).toBe(true);
    expect(parse(incomplete).reason).toBe('invalid_byte_window');

    const mixed = (await readTool.handler!({
      file_path: f,
      byte_offset: 0,
      byte_limit: 4,
      offset: 1,
    }, ctx)) as { content: Array<{ text: string }>; isError?: boolean };
    expect(mixed.isError).toBe(true);
    expect(parse(mixed).reason).toBe('mixed_window_modes');
  });

  it('errors on a missing file', async () => {
    const r = (await readTool.handler!({ file_path: join(DIR, 'nope.txt') }, ctx)) as { content: Array<{ text: string }>; isError?: boolean };
    expect(r.isError).toBe(true);
    expect(parse(r).reason).toBe('read_failed');
  });

  // The two widenings below close the file-read gaps the 2026-07-26 bash audit
  // measured against real commands (plan bash-to-tool-substitution-2026-07-26,
  // P-005). Without them the `tail -n N FILE` and `~/`-path forms — 1,752 and
  // ~200 real atoms respectively — had NO tool expression, so the substitution
  // registry could not honestly claim equivalence for them.

  it('reads the last N lines with tail', async () => {
    const f = join(DIR, 'r-tail.txt');
    writeFileSync(f, Array.from({ length: 100 }, (_, i) => `line${i + 1}`).join('\n'));
    const r = (await readTool.handler!({ file_path: f, tail: 3 }, ctx)) as { content: Array<{ text: string }> };
    const text = r.content[0].text;
    expect(text).toContain('line98');
    expect(text).toContain('line100');
    expect(text).not.toContain('line97\n');
    // Line numbers stay absolute, so a tail read is still addressable by offset.
    expect(text).toMatch(/\s+100\tline100/);
    // Nothing follows the end of the file.
    expect(text).not.toContain('more lines');
  });

  it('clamps tail to the file length', async () => {
    const f = join(DIR, 'r-tail-short.txt');
    writeFileSync(f, 'only\ntwo\n');
    const r = (await readTool.handler!({ file_path: f, tail: 500 }, ctx)) as { content: Array<{ text: string }> };
    expect(r.content[0].text).toMatch(/\s+1\tonly/);
    expect(r.content[0].text).toContain('two');
  });

  it('expands a ~/ path instead of resolving it under the project dir', async () => {
    // `~` is a SHELL feature: Node sees it as relative, so before this the read
    // silently looked for `<projectDir>/~/…` and failed with a confusing error.
    const r = (await readTool.handler!({ file_path: '~/definitely-not-a-real-file-xyz.txt' }, ctx)) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    expect(r.isError).toBe(true);
    const message = String(parse(r).message);
    expect(message).toContain(homedir());
    expect(message).not.toContain('~');
  });
});

describe('capability:write', () => {
  it('creates a file', async () => {
    const f = join(DIR, 'sub/w.txt');
    const r = (await writeTool.handler!({ file_path: f, content: 'hi there\n' }, ctx)) as { content: Array<{ text: string }> };
    expect(parse(r).ok).toBe(true);
    expect(readFileSync(f, 'utf8')).toBe('hi there\n');
  });
});

describe('capability:edit', () => {
  it('replaces a unique string', async () => {
    const f = join(DIR, 'e.txt');
    writeFileSync(f, 'const x = 1;\nconst y = 2;\n');
    const r = (await editTool.handler!({ file_path: f, old_string: 'const x = 1;', new_string: 'const x = 42;' }, ctx)) as { content: Array<{ text: string }> };
    expect(parse(r).ok).toBe(true);
    expect(readFileSync(f, 'utf8')).toContain('const x = 42;');
  });

  it('errors when old_string is absent', async () => {
    const f = join(DIR, 'e2.txt');
    writeFileSync(f, 'hello\n');
    const r = (await editTool.handler!({ file_path: f, old_string: 'missing', new_string: 'x' }, ctx)) as { isError?: boolean; content: Array<{ text: string }> };
    expect(r.isError).toBe(true);
    expect(parse(r).reason).toBe('not_found');
  });

  it('errors on a non-unique match unless replace_all', async () => {
    const f = join(DIR, 'e3.txt');
    writeFileSync(f, 'dup\ndup\n');
    const bad = (await editTool.handler!({ file_path: f, old_string: 'dup', new_string: 'x' }, ctx)) as { isError?: boolean; content: Array<{ text: string }> };
    expect(bad.isError).toBe(true);
    expect(parse(bad).reason).toBe('not_unique');

    const ok = (await editTool.handler!({ file_path: f, old_string: 'dup', new_string: 'x', replace_all: true }, ctx)) as { content: Array<{ text: string }> };
    expect(parse(ok).ok).toBe(true);
    expect(readFileSync(f, 'utf8')).toBe('x\nx\n');
  });

  it('rejects a no-op edit', async () => {
    const f = join(DIR, 'e4.txt');
    writeFileSync(f, 'same\n');
    const r = (await editTool.handler!({ file_path: f, old_string: 'same', new_string: 'same' }, ctx)) as { isError?: boolean; content: Array<{ text: string }> };
    expect(r.isError).toBe(true);
    expect(parse(r).reason).toBe('no_op');
  });

  // EI-18693907749585513: `String.prototype.replace(old, new)` pattern-interprets
  // `$`-sequences in the REPLACEMENT string even when the search side is a plain
  // string — `` $` `` in particular expands to "everything before the match" and
  // silently spliced an entire file into itself in production. Every one of these
  // must land byte-for-byte, and the resulting file length must equal
  // before.length - old_string.length + new_string.length (no hidden duplication).
  describe('new_string containing JS String.replace special patterns lands verbatim', () => {
    const dollarCases: Array<[label: string, newString: string]> = [
      ['$&  (whole match)', 'prefix $& suffix'],
      ["$` (backtick — everything before the match)", 'prefix $` suffix'],
      ["$' (everything after the match)", "prefix $' suffix"],
      ['$1  (capture group, no regex used)', 'prefix $1 suffix'],
      ['$$  (literal dollar escape)', 'prefix $$ suffix'],
    ];

    for (const [i, [label, newString]] of dollarCases.entries()) {
      it(`single replace: ${label}`, async () => {
        const f = join(DIR, `e-dollar-${i}.txt`);
        const before = 'HEADER\nconst anchor = 1;\nFOOTER\n';
        writeFileSync(f, before);
        const r = (await editTool.handler!({ file_path: f, old_string: 'const anchor = 1;', new_string: newString }, ctx)) as {
          content: Array<{ text: string }>;
          isError?: boolean;
        };
        expect(r.isError).toBeUndefined();
        expect(parse(r).ok).toBe(true);
        const after = readFileSync(f, 'utf8');
        const expected = before.replace('const anchor = 1;', () => newString); // literal splice via callback form (never pattern-interpreted)
        expect(after).toBe(expected);
        expect(after.length).toBe(before.length - 'const anchor = 1;'.length + newString.length);
        expect(after).not.toContain('HEADER\nconst anchor = 1;\nFOOTER\nHEADER'); // the observed corruption shape: prefix spliced back in
      });

      it(`replace_all: ${label}`, async () => {
        const f = join(DIR, `e-dollar-all-${i}.txt`);
        const before = 'anchor\nanchor\n';
        writeFileSync(f, before);
        const r = (await editTool.handler!({ file_path: f, old_string: 'anchor', new_string: newString, replace_all: true }, ctx)) as {
          content: Array<{ text: string }>;
        };
        expect(parse(r).ok).toBe(true);
        expect(readFileSync(f, 'utf8')).toBe(`${newString}\n${newString}\n`);
      });
    }
  });
});
