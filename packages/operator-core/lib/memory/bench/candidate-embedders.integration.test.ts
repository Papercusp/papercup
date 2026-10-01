import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { incumbentReferenceFixture } from './fixtures/incumbent-reference';
import { summarizeIncumbentReferenceFiles } from './candidate-embedders';

const roots: string[] = [];
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
  const read = () => summarizeIncumbentReferenceFiles(nativeFile, pythonFile);
  return { root, nativeFile, output, read };
}
describe('incumbent native/Python evidence file transport', () => {
  it('joins independently serialized native/request/Python files without model loading and preserves each recipe', () => {
    const files = frozenFiles();
    const summary = files.read();
    expect(new Set(summary.arms.map((a: { profileId: string }) => a.profileId)).size).toBe(3);
    expect(summary.arms.every((a: { passed: boolean }) => a.passed)).toBe(true);
  });
  it('refuses collapsed recipes and altered native bytes before returning a publishable summary', () => {
    const collision = frozenFiles(true);
    expect(collision.read).toThrow('identity collision');
    expect(fs.existsSync(collision.output)).toBe(false);
    const drift = frozenFiles(); fs.appendFileSync(drift.nativeFile, ' ');
    expect(drift.read).toThrow('fingerprint mismatch');
    expect(fs.existsSync(drift.output)).toBe(false);
  });
});
