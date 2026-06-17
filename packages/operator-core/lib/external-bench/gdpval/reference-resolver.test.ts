import { describe, expect, it, vi } from 'vitest';
import {
  classifyFile,
  extractFile,
  fileExt,
  makePythonOfficeExtract,
  resolveBundle,
  resolveGdpvalReferences,
  type ResolverDeps,
} from './reference-resolver';
import type { BenchTask } from '../types';

const enc = (s: string) => new TextEncoder().encode(s);

describe('reference-resolver — fileExt + classifyFile', () => {
  it('extracts the extension, ignoring query/hash + path', () => {
    expect(fileExt('https://h/deliverable_files/x/Sample v2.xlsx')).toBe('xlsx');
    expect(fileExt('a/b/report.PDF?download=1')).toBe('pdf');
    expect(fileExt('noext')).toBe('');
  });
  it('classifies text / office / excluded', () => {
    expect(classifyFile('a.md')).toBe('text');
    expect(classifyFile('a.csv')).toBe('text');
    expect(classifyFile('a.xlsx')).toBe('office');
    expect(classifyFile('a.docx')).toBe('office');
    expect(classifyFile('a.pdf')).toBe('office');
    expect(classifyFile('drawing.dwg')).toBe('excluded');
    expect(classifyFile('clip.mp4')).toBe('excluded');
    expect(classifyFile('logo.png')).toBe('excluded');
  });
  it('unknown ext → office (try extraction); extensionless → text', () => {
    expect(classifyFile('a.weirdext')).toBe('office');
    expect(classifyFile('README')).toBe('text');
  });
});

const deps = (officeText = 'OFFICE TEXT'): ResolverDeps => ({
  fetchBytes: vi.fn(async (url: string) => enc(`bytes-of:${url}`)),
  officeExtract: vi.fn(async () => officeText),
});

describe('reference-resolver — extractFile', () => {
  it('text file decoded natively (no office extractor call)', async () => {
    const d = deps();
    const r = await extractFile(enc('hello,world\n1,2'), 'data.csv', d);
    expect(r).toEqual({ ok: true, text: 'hello,world\n1,2' });
    expect(d.officeExtract).not.toHaveBeenCalled();
  });
  it('html is tag-stripped', async () => {
    const r = await extractFile(enc('<p>Hi <b>there</b></p>'), 'r.html', deps());
    expect(r).toEqual({ ok: true, text: 'Hi there' });
  });
  it('office file routed to the injected extractor', async () => {
    const d = deps('SHEET A1\tA2');
    const r = await extractFile(enc('<<binary xlsx>>'), 'book.xlsx', d);
    expect(r).toEqual({ ok: true, text: 'SHEET A1\tA2' });
    expect(d.officeExtract).toHaveBeenCalledOnce();
  });
  it('binary type → excluded, never calls the extractor', async () => {
    const d = deps();
    const r = await extractFile(enc('PNGDATA'), 'logo.png', d);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.excludeReason).toMatch(/binary deliverable \(\.png\)/);
    expect(d.fetchBytes).not.toHaveBeenCalled();
  });
  it('empty extraction → excludeReason', async () => {
    const r = await extractFile(enc('   '), 'blank.txt', deps());
    expect(r.ok).toBe(false);
  });
  it('extractor throw → excludeReason (no crash)', async () => {
    const d: ResolverDeps = { fetchBytes: async () => enc('x'), officeExtract: async () => { throw new Error('no openpyxl'); } };
    const r = await extractFile(enc('x'), 'b.xlsx', d);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.excludeReason).toMatch(/extraction failed.*no openpyxl/);
  });
  it('truncates very large text', async () => {
    const r = await extractFile(enc('x'.repeat(50_000)), 'big.txt', deps(), 100);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text.endsWith('…[truncated]')).toBe(true);
  });
});

describe('reference-resolver — resolveBundle', () => {
  it('concatenates readable files with headers; lists excluded; not allExcluded', async () => {
    const d: ResolverDeps = {
      fetchBytes: async (u) => enc(u.endsWith('.csv') ? 'a,b' : 'IMG'),
      officeExtract: async () => 'x',
    };
    const res = await resolveBundle(['http://h/data.csv', 'http://h/pic.png'], d);
    expect(res.text).toContain('## File: data.csv');
    expect(res.text).toContain('a,b');
    expect(res.excluded).toHaveLength(1);
    expect(res.excluded[0].file).toBe('pic.png');
    expect(res.allExcluded).toBe(false);
  });
  it('allExcluded=true when every file is binary', async () => {
    const res = await resolveBundle(['http://h/a.mp4', 'http://h/b.dwg'], deps());
    expect(res.allExcluded).toBe(true);
    expect(res.text).toBe('');
    expect(res.excluded).toHaveLength(2);
  });
  it('fetch failure → that file excluded, not a crash', async () => {
    const d: ResolverDeps = { fetchBytes: async () => { throw new Error('404'); }, officeExtract: async () => 'x' };
    const res = await resolveBundle(['http://h/data.csv'], d);
    expect(res.allExcluded).toBe(true);
    expect(res.excluded[0].reason).toMatch(/fetch failed.*404/);
  });
});

describe('reference-resolver — resolveGdpvalReferences', () => {
  const task = (id: string, urls: string[]): BenchTask => ({
    benchmark: 'gdpval',
    instanceId: id,
    problemStatement: id,
    graderMeta: { occupation: 'o', sector: 's', rubric: 'r', referenceDeliverableUrls: urls },
  });

  it('populates referenceDeliverableText for readable refs', async () => {
    const d: ResolverDeps = { fetchBytes: async () => enc('the expert deliverable'), officeExtract: async () => 'x' };
    const [t] = await resolveGdpvalReferences([task('t1', ['http://h/ref.md'])], d);
    expect(t.graderMeta.referenceDeliverableText).toContain('the expert deliverable');
    expect(t.graderMeta.referenceExcludeReason).toBeUndefined();
  });

  it('sets referenceExcludeReason when the whole reference is binary', async () => {
    const [t] = await resolveGdpvalReferences([task('t2', ['http://h/ref.mp4'])], deps());
    expect(t.graderMeta.referenceDeliverableText).toBeUndefined();
    expect(t.graderMeta.referenceExcludeReason).toMatch(/unreadable/);
  });

  it('no reference files → excluded', async () => {
    const [t] = await resolveGdpvalReferences([task('t3', [])], deps());
    expect(t.graderMeta.referenceExcludeReason).toMatch(/no reference deliverable/);
  });

  it('does not mutate the input tasks', async () => {
    const input = task('t4', ['http://h/ref.md']);
    const d: ResolverDeps = { fetchBytes: async () => enc('x'), officeExtract: async () => 'y' };
    await resolveGdpvalReferences([input], d);
    expect(input.graderMeta.referenceDeliverableText).toBeUndefined();
  });
});

describe('reference-resolver — makePythonOfficeExtract', () => {
  it('feeds bytes on stdin + the basename as argv, returns stdout', async () => {
    const run = vi.fn(async () => ({ stdout: 'extracted cells', code: 0, stderr: '' }));
    const extract = makePythonOfficeExtract({ pythonBin: '/py', run });
    const text = await extract(enc('xlsxbytes'), 'http://h/book.xlsx');
    expect(text).toBe('extracted cells');
    expect(run).toHaveBeenCalledWith('/py', expect.arrayContaining(['-c', expect.stringContaining('openpyxl'), 'book.xlsx']), expect.any(Uint8Array));
  });
  it('throws on a non-zero exit (caller degrades to excludeReason)', async () => {
    const run = vi.fn(async () => ({ stdout: '', code: 3, stderr: 'No module named openpyxl' }));
    const extract = makePythonOfficeExtract({ pythonBin: '/py', run });
    await expect(extract(enc('x'), 'b.xlsx')).rejects.toThrow(/openpyxl/);
  });
});
