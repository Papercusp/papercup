import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { incumbentReferenceFixture } from './fixtures/incumbent-reference';

const run = promisify(execFile), roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function frozenFiles(collision = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'incumbent-reference-integration-')); roots.push(root);
  const { native, python } = incumbentReferenceFixture();
  if (collision) native.arms[1].profileId = native.arms[0].profileId;
  const request = { protocolSha256: native.protocolSha256, ownerId: 'synthetic', execution: { device: 'cpu', dtype: 'fp32' }, identities: native.identities, cases: native.cases };
  const hash = (p: string) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  const nativeFile = path.join(root, 'native.json'), pythonFile = path.join(root, 'python.json'), output = path.join(root, 'summary.json');
  fs.writeFileSync(`${nativeFile}.request.json`, JSON.stringify(request));
  native.requestSha256 = hash(`${nativeFile}.request.json`); python.requestSha256 = native.requestSha256;
  fs.writeFileSync(nativeFile, JSON.stringify({ ...native, ...request })); python.nativeSha256 = hash(nativeFile);
  fs.writeFileSync(pythonFile, JSON.stringify(python));
  const invoke = () => run(process.execPath, ['--import', 'tsx', path.join(import.meta.dirname, 'embedder-eval-cli.ts'),
    '--summarize-reference', nativeFile, '--python-reference', pythonFile, '--out', output], { timeout: 30_000 });
  return { root, nativeFile, output, invoke };
}
describe('incumbent native/Python evidence file transport', () => {
  it('joins exact frozen bytes through the real CLI without model loading and preserves each recipe', async () => {
    const files = frozenFiles(); await files.invoke();
    const summary = JSON.parse(fs.readFileSync(files.output, 'utf8'));
    expect(new Set(summary.arms.map((a: { profileId: string }) => a.profileId)).size).toBe(3);
    expect(summary.arms.every((a: { passed: boolean }) => a.passed)).toBe(true);
    await expect(files.invoke()).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('EEXIST') });
  }, 60_000);
  it('refuses collapsed recipes and altered native bytes before writing a summary', async () => {
    const collision = frozenFiles(true);
    await expect(collision.invoke()).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('identity collision') });
    expect(fs.existsSync(collision.output)).toBe(false);
    const drift = frozenFiles(); fs.appendFileSync(drift.nativeFile, ' ');
    await expect(drift.invoke()).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('fingerprint mismatch') });
    expect(fs.existsSync(drift.output)).toBe(false);
  }, 60_000);
});
