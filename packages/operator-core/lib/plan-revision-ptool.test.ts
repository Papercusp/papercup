import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { hashPlanContent } from '@papercusp/plan-parser/content-hash';
import { readPlanPtoolDocument, readPlanPtoolReply } from '../test/plan-revision-ptool';

const execute = promisify(execFile);
const cli = new URL('../../../apps/operator/scripts/ptool.mjs', import.meta.url).href;
const retry = { slug: 'draft-revision', content: 'The saved revision\n' };
const stale = { error: 'stale', slug: retry.slug, currentHash: hashPlanContent(retry.content),
  currentContent: retry.content, currentVersion: 3 };

function printed(reply: unknown) {
  const program = 'const { printResult } = await import(process.argv[1]);'
    + 'process.exitCode = await printResult(JSON.parse(process.argv[2]), { raw: true });';
  return execute(process.execPath, ['--input-type=module', '-e', program, cli, JSON.stringify(reply)]);
}

describe('plan revision CLI measurements', () => {
  it('requests and round-trips the exact stored Markdown, including its frontmatter and final newline', async () => {
    const slug = 'measured-plan', harness = 'private-harness';
    const raw = '---\ntitle: Reference\n---\n\n## Reference\n\nCafé 📚\r\n';
    const contentHash = hashPlanContent(raw);
    let reads = 0;
    const result = await readPlanPtoolDocument(slug, harness, (verb, args) => {
      reads++;
      expect(verb).toBe('plans:get');
      expect(args).toMatchObject({ slug, harness, mode: 'full', includeRaw: true, includeEnrichments: false });
      const row = { ok: true, slug, harness, version: 4, contentHash, ...(args.includeRaw === true ? { raw } : {}) };
      return readPlanPtoolReply(printed({ structuredContent: { ok: true, results: [row] } }));
    });
    expect(reads).toBe(1);
    expect(result).toEqual({ slug, harness, content: raw, expectedVersion: 4, expectedHash: contentHash });
  });

  it('refuses an omitted, changed or differently scoped document before an edit is constructed', async () => {
    const raw = '## Reference\n\nComplete document\n';
    const row = { ok: true, slug: 'measured-plan', harness: 'private-harness', version: 3, raw,
      contentHash: hashPlanContent(raw) };
    for (const change of [{ raw: undefined }, { raw: raw.trimEnd() }, { contentHash: hashPlanContent('other') },
      { slug: 'another-plan' }, { harness: 'another-harness' }, { version: 1.5 }, { ok: false }]) {
      await expect(readPlanPtoolDocument(row.slug, row.harness, async () => ({ ...row, ...change })))
        .rejects.toThrow('complete stored document');
    }
  });

  it('reads the delivered stale response on both CLI output channels for an exact retry', async () => {
    const mcpError = { isError: true, content: [{ type: 'text', text: JSON.stringify(stale) }] };
    await expect(readPlanPtoolReply(printed(mcpError), retry)).resolves.toEqual(stale);
    const batch = { ok: false, results: [{ ...stale, ok: false }] };
    await expect(readPlanPtoolReply(printed({ structuredContent: batch }), retry)).resolves.toEqual(batch.results[0]);
    await expect(readPlanPtoolReply(printed(mcpError))).rejects.toMatchObject({ code: 1 });
  });

  it('retains successful replies and requires a single complete result', async () => {
    const row = { ok: true, version: 3 };
    await expect(readPlanPtoolReply(printed({ structuredContent: { results: [row] } }))).resolves.toEqual(row);
    const identity = { ownerId: 'original-owner' };
    await expect(readPlanPtoolReply(printed({ structuredContent: identity }))).resolves.toEqual(identity);
    await expect(readPlanPtoolReply(Promise.resolve({ stdout: '{"results":[]}' }))).rejects.toThrow('one result');
    await expect(readPlanPtoolReply(Promise.resolve({ stdout: '{"results":[{},{}]}' }))).rejects.toThrow('one result');
  });

  it.each([
    { ...stale, error: 'busy' }, { ...stale, slug: 'other-plan' }, { ...stale, currentHash: 'other' },
    { ...stale, currentContent: 'different saved bytes' }, { ...stale, ok: true },
  ])('preserves a refusal that cannot establish this exact retry', async reply => {
    const failure = Object.assign(new Error('CLI refusal'), { code: 5, stdout: JSON.stringify(reply) });
    await expect(readPlanPtoolReply(Promise.reject(failure), retry)).rejects.toBe(failure);
  });

  it('retains transport failures, malformed output and interrupted processes', async () => {
    for (const details of [
      { code: 1, stdout: JSON.stringify(stale), stderr: 'connection unavailable' },
      { code: 1, stdout: '', stderr: '✗ tool returned an error:\n{"error":' },
      { code: 5, stdout: JSON.stringify(stale), signal: 'SIGTERM' },
    ]) {
      const failure = Object.assign(new Error('CLI invocation failed'), details);
      await expect(readPlanPtoolReply(Promise.reject(failure), retry)).rejects.toBe(failure);
    }
  });
});
