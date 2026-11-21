import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { hashPlanContent } from '@papercusp/plan-parser/content-hash';
import { readPlanPtoolReply } from '../test/plan-revision-ptool';

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
