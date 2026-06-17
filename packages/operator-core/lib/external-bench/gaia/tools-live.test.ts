import { describe, expect, it, vi } from 'vitest';
import {
  formatSearchResults,
  GAIA_TOOL_SPECS,
  htmlToText,
  isTextLikeFile,
  makeFetchUrlHandler,
  makeLiveGaiaToolset,
  makeReadFileHandler,
  makeRunPythonHandler,
  makeWebSearchHandler,
  parseBraveResults,
  type ExecFn,
  type FetchFn,
} from './tools-live';

/** Minimal fake fetch Response. */
function fakeResp(opts: { ok?: boolean; status?: number; body?: string; json?: unknown; contentType?: string }) {
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    text: async () => opts.body ?? '',
    json: async () => opts.json ?? {},
    headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? opts.contentType ?? null : null) },
  };
}

describe('gaia tools — htmlToText', () => {
  it('strips tags, scripts, styles and decodes entities', () => {
    const html =
      '<html><head><style>.x{}</style></head><body><script>bad()</script><h1>Title</h1><p>Hello&nbsp;&amp; world</p><ul><li>a</li><li>b</li></ul></body></html>';
    const txt = htmlToText(html);
    expect(txt).toContain('Title');
    expect(txt).toContain('Hello & world');
    expect(txt).toContain('- a');
    expect(txt).not.toContain('bad()');
    expect(txt).not.toContain('<');
  });
  it('decodes numeric entities', () => {
    expect(htmlToText('<p>caf&#233;</p>')).toContain('café');
  });
});

describe('gaia tools — parseBraveResults / formatSearchResults', () => {
  it('parses the Brave web.results shape', () => {
    const body = { web: { results: [{ title: 'T1', url: 'https://a', description: 'desc one' }, { title: 'T2', url: 'https://b', description: 'd2' }] } };
    const results = parseBraveResults(body);
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ title: 'T1', url: 'https://a' });
  });
  it('tolerates a missing web.results', () => {
    expect(parseBraveResults({})).toEqual([]);
    expect(parseBraveResults(null)).toEqual([]);
  });
  it('formats results with rank, url and description', () => {
    const out = formatSearchResults([{ title: 'T', url: 'https://x', description: 'hi' }]);
    expect(out).toContain('1. T');
    expect(out).toContain('https://x');
    expect(formatSearchResults([])).toBe('No results.');
  });
});

describe('gaia tools — isTextLikeFile', () => {
  it('classifies text vs office/binary', () => {
    expect(isTextLikeFile('a.csv')).toBe(true);
    expect(isTextLikeFile('a.py')).toBe(true);
    expect(isTextLikeFile('a.xlsx')).toBe(false);
    expect(isTextLikeFile('a.pdf')).toBe(false);
    expect(isTextLikeFile('a.png')).toBe(false);
  });
});

describe('gaia tools — web_search handler', () => {
  it('calls Brave with the key header and formats results', async () => {
    const fetchFn = vi.fn(async () => fakeResp({ json: { web: { results: [{ title: 'Paris', url: 'https://fr', description: 'capital' }] } } })) as unknown as FetchFn;
    const h = makeWebSearchHandler({ scratchDir: '/tmp', braveApiKey: 'k', fetchFn });
    const out = await h({ query: 'capital of France', count: 3 });
    expect(out).toContain('Paris');
    const call = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toContain('q=capital%20of%20France');
    expect(call[1].headers['X-Subscription-Token']).toBe('k');
  });
  it('errors clearly without a key or query', async () => {
    const h = makeWebSearchHandler({ scratchDir: '/tmp', braveApiKey: '', fetchFn: (async () => fakeResp({})) as unknown as FetchFn });
    expect(await h({ query: 'x' })).toMatch(/BRAVE_API_KEY/);
    const h2 = makeWebSearchHandler({ scratchDir: '/tmp', braveApiKey: 'k', fetchFn: (async () => fakeResp({})) as unknown as FetchFn });
    expect(await h2({ query: '' })).toMatch(/empty query/);
  });
});

describe('gaia tools — fetch_url handler', () => {
  it('reduces HTML to text', async () => {
    const fetchFn = (async () => fakeResp({ body: '<html><body><p>Hello world</p></body></html>', contentType: 'text/html' })) as unknown as FetchFn;
    const h = makeFetchUrlHandler({ scratchDir: '/tmp', fetchFn });
    expect(await h({ url: 'https://example.com' })).toContain('Hello world');
  });
  it('returns JSON as-is', async () => {
    const fetchFn = (async () => fakeResp({ body: '{"a":1}', contentType: 'application/json' })) as unknown as FetchFn;
    const h = makeFetchUrlHandler({ scratchDir: '/tmp', fetchFn });
    expect(await h({ url: 'https://api.example.com' })).toContain('"a":1');
  });
  it('rejects non-http urls and surfaces HTTP errors', async () => {
    const h = makeFetchUrlHandler({ scratchDir: '/tmp', fetchFn: (async () => fakeResp({ ok: false, status: 404 })) as unknown as FetchFn });
    expect(await h({ url: 'ftp://x' })).toMatch(/absolute http/);
    expect(await h({ url: 'https://x' })).toMatch(/HTTP 404/);
  });
});

describe('gaia tools — run_python handler', () => {
  it('runs code in the scratch dir and returns stdout', async () => {
    const exec: ExecFn = vi.fn(async (_bin, args) => ({ stdout: '42\n', stderr: '', code: 0 })) as unknown as ExecFn;
    const h = makeRunPythonHandler({ scratchDir: '/work', execFn: exec });
    const out = await h({ code: 'print(40+2)' });
    expect(out).toContain('42');
    const call = (exec as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe('python3');
    expect(call[1]).toEqual(['-c', 'print(40+2)']);
    expect(call[2].cwd).toBe('/work');
  });
  it('surfaces stderr + a non-zero exit code', async () => {
    const exec: ExecFn = (async () => ({ stdout: '', stderr: 'Traceback...', code: 1 })) as unknown as ExecFn;
    const h = makeRunPythonHandler({ scratchDir: '/work', execFn: exec });
    const out = await h({ code: 'boom' });
    expect(out).toContain('Traceback');
    expect(out).toContain('exit code 1');
  });
});

describe('gaia tools — read_file handler', () => {
  it('reads a text-like file inline', async () => {
    const h = makeReadFileHandler({ scratchDir: '/work', readFileFn: async () => Buffer.from('a,b,c\n1,2,3') });
    expect(await h({ path: 'data.csv' })).toContain('a,b,c');
  });
  it('blocks path traversal', async () => {
    const h = makeReadFileHandler({ scratchDir: '/work', readFileFn: async () => Buffer.from('x') });
    expect(await h({ path: '../secret' })).toMatch(/traversal/);
  });
  it('python-extracts an office file, steering to run_python on failure', async () => {
    const ok: ExecFn = (async () => ({ stdout: '# sheet Sheet1\n1,2,3', stderr: '', code: 0 })) as unknown as ExecFn;
    const h1 = makeReadFileHandler({ scratchDir: '/work', execFn: ok });
    expect(await h1({ path: 'book.xlsx' })).toContain('Sheet1');

    const fail: ExecFn = (async () => ({ stdout: 'EXTRACT_FAILED: no module', stderr: '', code: 0 })) as unknown as ExecFn;
    const h2 = makeReadFileHandler({ scratchDir: '/work', execFn: fail });
    expect(await h2({ path: 'book.xlsx' })).toMatch(/run_python/);
  });
});

describe('gaia tools — makeLiveGaiaToolset', () => {
  it('exposes the four tool specs + handlers', () => {
    const ts = makeLiveGaiaToolset({ scratchDir: '/work', braveApiKey: 'k' });
    expect(ts.specs).toBe(GAIA_TOOL_SPECS);
    expect(Object.keys(ts.handlers).sort()).toEqual(['fetch_url', 'read_file', 'run_python', 'web_search']);
  });
});
