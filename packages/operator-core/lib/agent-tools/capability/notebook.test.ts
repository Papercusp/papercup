/**
 * Hermetic tests for capability:notebook_edit — the managed notebook cell adapter
 * (P-006, gap `patch-notebook-adapters`).
 *
 * The gap's falsifier is "Hermetic and real-client tests prove atomic multi-file patch
 * and notebook semantics through managed authority and locks". capability:patch.test.ts
 * proves the multi-file-patch half; this file proves the NOTEBOOK-SEMANTICS half, so it
 * asserts the properties a text splice cannot have rather than just "the source changed":
 *   - the notebook still PARSES and round-trips, and its formatting is untouched;
 *   - replacing a code cell clears the outputs that no longer describe it;
 *   - a cell_type change leaves the cell schema-legal;
 *   - cell ids are minted only where nbformat allows them, and index addressing works
 *     where they cannot exist;
 *   - every rejection leaves the file BYTE-identical;
 *   - and all of it runs through the managed lock, holding the RESOLVED path.
 *
 * Temp paths live OUTSIDE any git repo (`mkNonRepoTmpDir`), so the lock is
 * uncoordinated and guardFileLock runs the body directly with no PG — the arrangement
 * EI-5826 requires instead of a bare os.tmpdir().
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkNonRepoTmpDir } from '../locks/non-repo-tmpdir';

/** Records the paths every guardFileLock call was asked to hold, then delegates to the real guard. */
const lockedPathSets: string[][] = [];
vi.mock('../locks/file-lock-guard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../locks/file-lock-guard')>();
  return {
    ...actual,
    guardFileLock: (ctx: unknown, paths: string[], spec: unknown, run: () => unknown) => {
      lockedPathSets.push([...paths]);
      return (actual.guardFileLock as unknown as (...a: unknown[]) => unknown)(ctx, paths, spec, run);
    },
  };
});

const notebookTool = (await import('./notebook')).default;

const DIR = mkNonRepoTmpDir('cap-notebook-');
const ctx = {
  projectDir: DIR,
  stateDir: DIR,
  signal: new AbortController().signal,
  emit: () => {},
  progress: () => {},
  log: () => {},
} as never;

function parse(r: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(r.content[0].text);
}

async function edit(args: Record<string, unknown>) {
  return (await notebookTool.handler!(args as never, ctx)) as { content: Array<{ text: string }>; isError?: boolean };
}

type Cell = Record<string, unknown>;

let seq = 0;
/** Write a notebook fixture exactly as Jupyter would (indent=1, trailing newline). */
function notebook(cells: Cell[], opts: { nbformat?: number; nbformat_minor?: number } = {}): string {
  const doc = {
    cells,
    metadata: { kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' } },
    nbformat: opts.nbformat ?? 4,
    nbformat_minor: opts.nbformat_minor ?? 5,
  };
  const p = join(DIR, `${seq++}-nb.ipynb`);
  writeFileSync(p, JSON.stringify(doc, null, 1) + '\n', 'utf8');
  return p;
}

function codeCell(id: string, source: string[], extra: Cell = {}): Cell {
  return { cell_type: 'code', execution_count: null, id, metadata: {}, outputs: [], source, ...extra };
}
function markdownCell(id: string, source: string[]): Cell {
  return { cell_type: 'markdown', id, metadata: {}, source };
}

function read(p: string): { raw: string; doc: { cells: Cell[]; [k: string]: unknown } } {
  const raw = readFileSync(p, 'utf8');
  return { raw, doc: JSON.parse(raw) as { cells: Cell[] } };
}
/** The body a notebook reader would SEE for a cell, whichever representation the file used. */
function body(cell: Cell): string {
  const s = cell.source;
  return Array.isArray(s) ? s.join('') : String(s ?? '');
}

beforeEach(() => {
  lockedPathSets.length = 0;
});

describe('capability:notebook_edit — replace', () => {
  it('replaces one cell and leaves the rest of the document identical', async () => {
    const p = notebook([codeCell('aaa', ['x = 1\n']), markdownCell('bbb', ['# heading\n']), codeCell('ccc', ['y = 2\n'])]);
    const before = read(p);

    const r = await edit({ notebook_path: p, cell_id: 'bbb', new_source: '# new heading\n\nwith prose' });

    expect(r.isError).not.toBe(true);
    const out = parse(r);
    expect(out.ok).toBe(true);
    expect(out.replacedIndex).toBe(1);
    expect(out.replacedId).toBe('bbb');

    const after = read(p);
    expect(after.doc.cells).toHaveLength(3);
    expect(body(after.doc.cells[1]!)).toBe('# new heading\n\nwith prose');
    // Untouched neighbours must be deep-equal, not merely present.
    expect(after.doc.cells[0]).toEqual(before.doc.cells[0]);
    expect(after.doc.cells[2]).toEqual(before.doc.cells[2]);
    expect(after.doc.metadata).toEqual(before.doc.metadata);
    expect(after.doc.nbformat).toBe(4);
    expect(after.doc.nbformat_minor).toBe(5);
  });

  it('clears the outputs and execution_count that no longer describe the new source', async () => {
    // The whole reason a text splice is wrong here: it would rewrite the source and
    // leave this output asserting a result the new code never produced.
    const stale = [{ output_type: 'execute_result', data: { 'text/plain': ['42'] }, execution_count: 7, metadata: {} }];
    const p = notebook([codeCell('aaa', ['answer = 42\n'], { outputs: stale, execution_count: 7 })]);

    const r = await edit({ notebook_path: p, cell_id: 'aaa', new_source: 'answer = 43\n' });

    expect(parse(r).clearedOutputs).toBe(true);
    const cell = read(p).doc.cells[0]!;
    expect(cell.outputs).toEqual([]);
    expect(cell.execution_count).toBeNull();
    expect(body(cell)).toBe('answer = 43\n');
  });

  it('reports clearedOutputs:false when the cell had none to clear', async () => {
    const p = notebook([codeCell('aaa', ['x = 1\n'])]);
    const r = await edit({ notebook_path: p, cell_id: 'aaa', new_source: 'x = 2\n' });
    expect(parse(r).clearedOutputs).toBe(false);
  });

  it('converting code → markdown REMOVES outputs/execution_count, which markdown cells may not carry', async () => {
    const p = notebook([codeCell('aaa', ['x = 1\n'], { outputs: [{ output_type: 'stream', name: 'stdout', text: ['1\n'] }], execution_count: 3 })]);

    const r = await edit({ notebook_path: p, cell_id: 'aaa', cell_type: 'markdown', new_source: '# now prose\n' });

    const out = parse(r);
    expect(out.cellType).toBe('markdown');
    expect(out.cellTypeChangedFrom).toBe('code');
    const cell = read(p).doc.cells[0]!;
    expect(cell.cell_type).toBe('markdown');
    expect('outputs' in cell).toBe(false);
    expect('execution_count' in cell).toBe(false);
  });

  it('converting markdown → code ADDS the outputs/execution_count a code cell must have', async () => {
    const p = notebook([markdownCell('bbb', ['# prose\n'])]);

    const r = await edit({ notebook_path: p, cell_id: 'bbb', cell_type: 'code', new_source: 'print(1)\n' });

    expect(parse(r).cellTypeChangedFrom).toBe('markdown');
    const cell = read(p).doc.cells[0]!;
    expect(cell.cell_type).toBe('code');
    expect(cell.outputs).toEqual([]);
    expect(cell.execution_count).toBeNull();
  });

  it('reports cellTypeChangedFrom:null when the type was not changed', async () => {
    const p = notebook([codeCell('aaa', ['x = 1\n'])]);
    const r = await edit({ notebook_path: p, cell_id: 'aaa', cell_type: 'code', new_source: 'x = 2\n' });
    expect(parse(r).cellTypeChangedFrom).toBeNull();
  });
});

describe('capability:notebook_edit — insert', () => {
  it('inserts AFTER the addressed cell with a fresh unique id', async () => {
    const p = notebook([codeCell('aaa', ['x = 1\n']), codeCell('ccc', ['z = 3\n'])]);

    const r = await edit({ notebook_path: p, edit_mode: 'insert', cell_id: 'aaa', cell_type: 'code', new_source: 'y = 2\n' });

    const out = parse(r);
    expect(out.insertedIndex).toBe(1);
    expect(typeof out.insertedId).toBe('string');

    const cells = read(p).doc.cells;
    expect(cells.map((c) => body(c))).toEqual(['x = 1\n', 'y = 2\n', 'z = 3\n']);
    const ids = cells.map((c) => c.id);
    expect(new Set(ids).size).toBe(3); // the minted id collides with nothing
    expect(String(out.insertedId)).toMatch(/^[a-zA-Z0-9_-]{1,64}$/); // nbformat's id pattern
    expect(cells[1]!.outputs).toEqual([]);
    expect(cells[1]!.execution_count).toBeNull();
    expect(cells[1]!.metadata).toEqual({});
  });

  it('inserts at the START when cell_id is omitted', async () => {
    const p = notebook([codeCell('aaa', ['x = 1\n'])]);

    const r = await edit({ notebook_path: p, edit_mode: 'insert', cell_type: 'markdown', new_source: '# title\n' });

    expect(parse(r).insertedIndex).toBe(0);
    const cells = read(p).doc.cells;
    expect(cells[0]!.cell_type).toBe('markdown');
    expect(body(cells[0]!)).toBe('# title\n');
    // A markdown cell must not be born with code-only fields.
    expect('outputs' in cells[0]!).toBe(false);
    expect('execution_count' in cells[0]!).toBe(false);
    expect(body(cells[1]!)).toBe('x = 1\n');
  });

  it('mints NO id below nbformat 4.5, where an id is schema-invalid', async () => {
    // nbformat 4.4 cells have no `id` field at all; adding one makes the file invalid.
    const p = notebook([{ cell_type: 'code', execution_count: null, metadata: {}, outputs: [], source: ['x = 1\n'] }], { nbformat_minor: 4 });

    const r = await edit({ notebook_path: p, edit_mode: 'insert', cell_id: '0', cell_type: 'code', new_source: 'y = 2\n' });

    const out = parse(r);
    expect(out.insertedId).toBeNull();
    expect((out.preserved as Record<string, unknown>).cellIds).toBe(false);
    const cells = read(p).doc.cells;
    expect(cells).toHaveLength(2);
    expect('id' in cells[1]!).toBe(false);
  });
});

describe('capability:notebook_edit — delete', () => {
  it('removes the addressed cell and no other', async () => {
    const p = notebook([codeCell('aaa', ['x = 1\n']), codeCell('bbb', ['y = 2\n']), codeCell('ccc', ['z = 3\n'])]);

    const r = await edit({ notebook_path: p, edit_mode: 'delete', cell_id: 'bbb' });

    const out = parse(r);
    expect(out.deletedIndex).toBe(1);
    expect(out.deletedType).toBe('code');
    expect(out.cellsRemaining).toBe(2);
    expect(read(p).doc.cells.map((c) => c.id)).toEqual(['aaa', 'ccc']);
  });

  it('does not require new_source', async () => {
    const p = notebook([codeCell('aaa', ['x = 1\n'])]);
    const r = await edit({ notebook_path: p, edit_mode: 'delete', cell_id: 'aaa' });
    expect(r.isError).not.toBe(true);
    expect(read(p).doc.cells).toEqual([]);
  });
});

describe('capability:notebook_edit — addressing', () => {
  it('accepts a 0-based INDEX, the only way to address a pre-4.5 notebook', async () => {
    const p = notebook(
      [
        { cell_type: 'code', execution_count: null, metadata: {}, outputs: [], source: ['a = 1\n'] },
        { cell_type: 'code', execution_count: null, metadata: {}, outputs: [], source: ['b = 2\n'] },
      ],
      { nbformat_minor: 4 },
    );

    const r = await edit({ notebook_path: p, cell_id: '1', new_source: 'b = 22\n' });

    expect(parse(r).replacedIndex).toBe(1);
    const cells = read(p).doc.cells;
    expect(body(cells[0]!)).toBe('a = 1\n');
    expect(body(cells[1]!)).toBe('b = 22\n');
  });

  it('prefers a real id over the same string read as an index', async () => {
    // A notebook whose SECOND cell is literally id "0" — the id must win, not index 0.
    const p = notebook([codeCell('aaa', ['a = 1\n']), codeCell('0', ['b = 2\n'])]);

    const r = await edit({ notebook_path: p, cell_id: '0', new_source: 'b = 22\n' });

    expect(parse(r).replacedIndex).toBe(1);
    expect(body(read(p).doc.cells[0]!)).toBe('a = 1\n');
  });

  it('rejects an unknown cell, names the addresses that DO exist, and writes nothing', async () => {
    const p = notebook([codeCell('aaa', ['x = 1\n']), codeCell('bbb', ['y = 2\n'])]);
    const before = readFileSync(p, 'utf8');

    const r = await edit({ notebook_path: p, cell_id: 'nope', new_source: 'x = 9\n' });

    expect(r.isError).toBe(true);
    const out = parse(r);
    expect(out.reason).toBe('cell_not_found');
    expect(String(out.message)).toContain('aaa');
    expect(String(out.message)).toContain('bbb');
    expect(readFileSync(p, 'utf8')).toBe(before);
  });

  it('rejects an out-of-range index rather than appending', async () => {
    const p = notebook([codeCell('aaa', ['x = 1\n'])]);
    const before = readFileSync(p, 'utf8');

    const r = await edit({ notebook_path: p, cell_id: '7', new_source: 'x = 9\n' });

    expect(parse(r).reason).toBe('cell_not_found');
    expect(readFileSync(p, 'utf8')).toBe(before);
  });
});

describe('capability:notebook_edit — the file survives the edit', () => {
  it('preserves the JSON indentation and trailing newline, so the diff is the cell only', async () => {
    const p = notebook([codeCell('aaa', ['x = 1\n']), codeCell('bbb', ['y = 2\n'])]);
    const before = readFileSync(p, 'utf8');

    const r = await edit({ notebook_path: p, cell_id: 'bbb', new_source: 'y = 22\n' });

    const preserved = parse(r).preserved as Record<string, unknown>;
    expect(preserved.jsonIndent).toBe(1);
    expect(preserved.trailingNewline).toBe(true);
    expect(preserved.sourceStyle).toBe('array');

    const after = readFileSync(p, 'utf8');
    expect(after.endsWith('\n')).toBe(true);
    expect(after).toContain('\n "cells": ['); // one-space indent, exactly as Jupyter writes it
    // A formatting-preserving edit changes only the lines of the edited cell.
    const changed = after.split('\n').filter((l, i) => l !== before.split('\n')[i]);
    expect(changed.length).toBeLessThanOrEqual(2);
  });

  it('keeps a minified notebook minified', async () => {
    const doc = { cells: [codeCell('aaa', ['x = 1\n'])], metadata: {}, nbformat: 4, nbformat_minor: 5 };
    const p = join(DIR, `${seq++}-min.ipynb`);
    writeFileSync(p, JSON.stringify(doc), 'utf8'); // no indentation, no trailing newline

    const r = await edit({ notebook_path: p, cell_id: 'aaa', new_source: 'x = 2\n' });

    const preserved = parse(r).preserved as Record<string, unknown>;
    expect(preserved.jsonIndent).toBe(0);
    expect(preserved.trailingNewline).toBe(false);
    const after = readFileSync(p, 'utf8');
    expect(after).not.toContain('\n');
    expect(body((JSON.parse(after) as { cells: Cell[] }).cells[0]!)).toBe('x = 2\n');
  });

  it('writes source in nbformat line form — each element keeps its own newline and joins back exactly', async () => {
    const p = notebook([codeCell('aaa', ['x = 1\n'])]);
    const src = 'def f():\n    return 1\n';

    await edit({ notebook_path: p, cell_id: 'aaa', new_source: src });

    const cell = read(p).doc.cells[0]!;
    expect(cell.source).toEqual(['def f():\n', '    return 1\n']);
    expect((cell.source as string[]).join('')).toBe(src);
  });

  it('keeps the final line unterminated when the source has no trailing newline', async () => {
    const p = notebook([codeCell('aaa', ['x = 1\n'])]);
    await edit({ notebook_path: p, cell_id: 'aaa', new_source: 'a\nb' });
    expect(read(p).doc.cells[0]!.source).toEqual(['a\n', 'b']);
  });

  it('renders an empty source as an empty array, not [""]', async () => {
    const p = notebook([codeCell('aaa', ['x = 1\n'])]);
    await edit({ notebook_path: p, cell_id: 'aaa', new_source: '' });
    expect(read(p).doc.cells[0]!.source).toEqual([]);
  });

  it('honors a notebook that stores source as a single STRING', async () => {
    const doc = {
      cells: [
        { cell_type: 'code', execution_count: null, id: 'aaa', metadata: {}, outputs: [], source: 'x = 1\n' },
        { cell_type: 'code', execution_count: null, id: 'bbb', metadata: {}, outputs: [], source: 'y = 2\n' },
      ],
      metadata: {},
      nbformat: 4,
      nbformat_minor: 5,
    };
    const p = join(DIR, `${seq++}-str.ipynb`);
    writeFileSync(p, JSON.stringify(doc, null, 1) + '\n', 'utf8');

    const r = await edit({ notebook_path: p, cell_id: 'bbb', new_source: 'y = 22\n' });

    expect((parse(r).preserved as Record<string, unknown>).sourceStyle).toBe('string');
    expect(read(p).doc.cells[1]!.source).toBe('y = 22\n'); // a string, not an array
  });

  it('escapes JSON-hostile source rather than corrupting the document', async () => {
    // Exactly the class of body that makes a literal text splice unsafe on an .ipynb.
    const p = notebook([codeCell('aaa', ['x = 1\n'])]);
    const nasty = 's = "quoted \\ backslash"\nt = \'tab\there\'\nu = "é中"\n';

    const r = await edit({ notebook_path: p, cell_id: 'aaa', new_source: nasty });

    expect(r.isError).not.toBe(true);
    const after = read(p); // would throw if the write produced invalid JSON
    expect(body(after.doc.cells[0]!)).toBe(nasty);
  });
});

describe('capability:notebook_edit — rejections leave the file byte-identical', () => {
  it('refuses a file that is not JSON', async () => {
    const p = join(DIR, `${seq++}-plain.py`);
    writeFileSync(p, 'print("not a notebook")\n', 'utf8');
    const before = readFileSync(p, 'utf8');

    const r = await edit({ notebook_path: p, cell_id: '0', new_source: 'x = 1\n' });

    expect(r.isError).toBe(true);
    expect(parse(r).reason).toBe('not_a_notebook');
    expect(readFileSync(p, 'utf8')).toBe(before);
  });

  it('refuses valid JSON that has no cells array', async () => {
    const p = join(DIR, `${seq++}-nocells.ipynb`);
    writeFileSync(p, JSON.stringify({ metadata: {}, nbformat: 4 }), 'utf8');
    const before = readFileSync(p, 'utf8');

    const r = await edit({ notebook_path: p, cell_id: '0', new_source: 'x = 1\n' });

    expect(parse(r).reason).toBe('not_a_notebook');
    expect(readFileSync(p, 'utf8')).toBe(before);
  });

  it('reports a missing file as read_failed', async () => {
    const r = await edit({ notebook_path: join(DIR, 'does-not-exist.ipynb'), cell_id: '0', new_source: 'x = 1\n' });
    expect(r.isError).toBe(true);
    expect(parse(r).reason).toBe('read_failed');
  });

  it('requires new_source for replace and insert but not delete', async () => {
    const p = notebook([codeCell('aaa', ['x = 1\n'])]);
    expect(parse(await edit({ notebook_path: p, cell_id: 'aaa' })).reason).toBe('missing_new_source');
    expect(parse(await edit({ notebook_path: p, edit_mode: 'insert', cell_type: 'code' })).reason).toBe('missing_new_source');
    // Unchanged by either rejection.
    expect(read(p).doc.cells).toHaveLength(1);
  });

  it('requires cell_type for insert', async () => {
    const p = notebook([codeCell('aaa', ['x = 1\n'])]);
    const r = await edit({ notebook_path: p, edit_mode: 'insert', new_source: 'y = 2\n' });
    expect(parse(r).reason).toBe('missing_cell_type');
    expect(read(p).doc.cells).toHaveLength(1);
  });

  it('requires cell_id for replace and delete', async () => {
    const p = notebook([codeCell('aaa', ['x = 1\n'])]);
    expect(parse(await edit({ notebook_path: p, new_source: 'x = 2\n' })).reason).toBe('missing_cell_id');
    expect(parse(await edit({ notebook_path: p, edit_mode: 'delete' })).reason).toBe('missing_cell_id');
    expect(body(read(p).doc.cells[0]!)).toBe('x = 1\n');
  });
});

describe('capability:notebook_edit — through managed authority and locks', () => {
  it('holds the RESOLVED notebook path for the operation', async () => {
    const p = notebook([codeCell('aaa', ['x = 1\n'])]);

    await edit({ notebook_path: p, cell_id: 'aaa', new_source: 'x = 2\n' });

    expect(lockedPathSets).toHaveLength(1);
    expect(lockedPathSets[0]).toEqual([p]);
  });

  it('resolves a project-relative path against the base dir before locking it', async () => {
    const p = notebook([codeCell('aaa', ['x = 1\n'])]);
    const relative = p.slice(DIR.length + 1);

    const r = await edit({ notebook_path: relative, cell_id: 'aaa', new_source: 'x = 2\n' });

    expect(r.isError).not.toBe(true);
    // The lock must cover the absolute path actually written, never the raw argument.
    expect(lockedPathSets[0]).toEqual([p]);
    expect(parse(r).path).toBe(p);
  });

  it('takes the lock BEFORE reading, so a rejected notebook was still coordinated', async () => {
    const p = join(DIR, `${seq++}-bad.ipynb`);
    writeFileSync(p, 'not json', 'utf8');

    await edit({ notebook_path: p, cell_id: '0', new_source: 'x = 1\n' });

    expect(lockedPathSets[0]).toEqual([p]);
  });

  it('declares fs-write authority, not a read capability', () => {
    expect(notebookTool.capability).toBe('capability:fs-write');
  });

  it('does not lock at all for an argument-only rejection', async () => {
    const p = notebook([codeCell('aaa', ['x = 1\n'])]);
    await edit({ notebook_path: p, cell_id: 'aaa' }); // missing new_source
    expect(lockedPathSets).toHaveLength(0);
  });
});
