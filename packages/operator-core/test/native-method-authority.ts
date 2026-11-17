/** Read the existing consult/rubric authority outside the disposable product DB.
 * A fresh process pins every nested getOrgPg reader without rebinding the test
 * worker's shared pool or introducing a second approval implementation. */
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { collectChildOutput } from '../lib/child-output';
import type { verifyMethodReviewAnswer } from '../lib/consult/get-feedback-prod';

export type NativeMethodAuthorityInput = Parameters<typeof verifyMethodReviewAnswer>[0];

export async function verifyNativeMethodAuthority(root: string, input: NativeMethodAuthorityInput,
  options: { env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {}) {
  options.signal?.throwIfAborted();
  const env = options.env ?? process.env;
  const url = env.PAPERCUSP_TEST_RUNS_DB_URL?.trim();
  assert.ok(url, 'Native method authority requires the explicit durable test-run ledger URL');
  const requestId = randomUUID();
  const child = fork(join(root, 'packages/operator-core/test/native-method-authority-fixture.ts'), [], {
    cwd: root, execArgv: ['--import', 'tsx/esm'],
    env: { ...env, HARNESS_DATABASE_URL: url, HARNESS_ADMIN_DATABASE_URL: url, DATABASE_URL: url },
    // This bounds one authority read, never the evidence population it reads.
    timeout: 30_000, killSignal: 'SIGKILL', signal: options.signal,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const output = collectChildOutput(child);
  const messages: unknown[] = [];
  child.on('message', message => messages.push(message));
  await new Promise<void>((resolve, reject) => {
    let failure: Error | undefined;
    child.once('error', error => { failure = error; });
    child.once('close', (code, signal) => {
      if (failure) reject(failure);
      else if (code === 0 && !signal) resolve();
      else reject(new Error(`Native method authority failed (${code ?? signal}): ${output.stderr.text()}`));
    });
    child.send({ requestId, input }, error => {
      if (error) { failure = error; child.kill('SIGKILL'); }
    });
  });
  assert.equal(messages.length, 1, 'Native method authority requires one complete IPC receipt');
  const receipt = z.object({ requestId: z.literal(requestId), targetSource: z.literal('env'),
    review: z.object({ reviewRef: z.literal(input.reviewRef), fingerprint: z.literal(input.fingerprint),
      conversationId: z.string().min(1), sourceOwnerId: z.string().min(1),
      answeringOwnerId: z.string().min(1), rubricId: z.string().min(1) }).strict(),
  }).strict().parse(messages[0]);
  return receipt;
}
