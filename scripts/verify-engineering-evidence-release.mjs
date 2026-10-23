import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scope = 'native-engineering-evidence-final-release-v1';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
/** Fresh execution plus an exact browser artifact; saved passes and missing inputs are UNKNOWN. */
export function verifyEngineeringRelease({ root, inputsPath, env = process.env, run = spawnSync, read = readFileSync,
  nonce = randomUUID() }) {
  const unknown = reason => ({ scope, status: 'unknown', reason });
  let bytes, input;
  try { bytes = read(inputsPath); input = JSON.parse(String(bytes)); }
  catch { return unknown('Canonical release journey inputs are unavailable.'); }
  if (!input || typeof input !== 'object' || !input.workspaceId || !input.clientId
    || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(input.buildSha ?? '') || !input.promotionReceipt)
    return unknown('A full promoted artifact and authoritative promotion receipt are required.');
  const manifestSha256 = digest(bytes);
  const child = run('bash', [join(root, 'scripts/pc-heavy.sh'), 'npm', '--prefix', join(root, 'apps/operator'),
    'run', 'test:e2e', '--', '--config', 'playwright.engineering-evidence.config.ts'], {
    cwd: root, encoding: 'utf8', timeout: 15 * 60_000, maxBuffer: 4 * 1024 * 1024,
    env: { ...env, PAPERCUSP_WORKSPACE: input.workspaceId, PAPERCUSP_SID: env.PAPERCUSP_SID ?? input.clientId,
      PAPERCUSP_ENGINEERING_PLANE: 'final-release', PAPERCUSP_ENGINEERING_JOURNEY_INPUTS: inputsPath,
      PAPERCUSP_ENGINEERING_JOURNEY_NONCE: nonce, OPERATOR_E2E_BASE_URL: 'http://127.0.0.1:3070',
      OPERATOR_E2E_REUSE_SERVER: '1', PAPERCUSP_TEST_RUN_HARNESS: 'papercusp' },
  });
  if (child.error || child.signal || child.status !== 0) return unknown('The maintained release browser journey did not complete successfully.');
  const line = String(child.stdout).split(/\r?\n/).find(line => line.startsWith('ENGINEERING_EVIDENCE_JOURNEY_VERIFIED '));
  if (!line) return unknown('No fresh completed browser receipt was emitted.');
  try {
    const proof = JSON.parse(line.slice('ENGINEERING_EVIDENCE_JOURNEY_VERIFIED '.length));
    if (proof.plane !== 'final-release' || proof.buildSha !== input.buildSha || proof.manifestSha256 !== manifestSha256
      || proof.nonce !== nonce || !/^[a-f0-9]{64}$/.test(proof.receiptSha256 ?? '') || !proof.receiptPath)
      return unknown('The browser receipt belongs to another artifact, plane, manifest or invocation.');
    const receiptBytes = read(proof.receiptPath), receipt = JSON.parse(String(receiptBytes));
    if (digest(receiptBytes) !== proof.receiptSha256 || receipt.nonce !== nonce || receipt.plane !== 'final-release'
      || receipt.buildSha !== input.buildSha || receipt.manifestSha256 !== manifestSha256)
      return unknown('The exact emitted browser artifact could not be verified.');
    return { scope, status: 'pass', plane: 'final-release', buildSha: input.buildSha, manifestSha256,
      receiptPath: proof.receiptPath, receiptSha256: proof.receiptSha256, nonce };
  } catch { return unknown('The emitted browser artifact is missing or malformed.'); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..'));
  const inputsPath = process.env.PAPERCUSP_ENGINEERING_JOURNEY_INPUTS
    ?? join(process.env.PAPERCUSP_HOME ?? join(homedir(), '.papercusp'), 'verification', 'native-engineering-evidence-release-inputs.json');
  console.log(JSON.stringify(verifyEngineeringRelease({ root, inputsPath })));
}
