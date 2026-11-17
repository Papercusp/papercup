import { describe, expect, it, vi } from 'vitest';
import { ChildProcess } from 'node:child_process';
import { verifyNativeMethodAuthority } from './native-method-authority';

const h = vi.hoisted(() => ({ fork: vi.fn<typeof import('node:child_process').fork>() }));
vi.mock('node:child_process', async original => ({
  ...await original<typeof import('node:child_process')>(), fork: h.fork,
}));

describe('canonical native method authority process', () => {
  const input = { workspaceId: 'ws', harnessSlug: 'harness', subjectPlan: 'plan',
    fingerprint: 'a'.repeat(64), reviewRef: 'thread-post:123' };

  it('refuses a missing durable target before spawning any reader', async () => {
    h.fork.mockClear();
    await expect(verifyNativeMethodAuthority('/root', input, { env: {
      HARNESS_ADMIN_DATABASE_URL: 'postgresql://disposable/product',
    } })).rejects.toThrow('explicit durable test-run ledger URL');
    expect(h.fork).not.toHaveBeenCalled();
  });

  it.each(['approved', 'wrong-edition', 'duplicate', 'no-receipt', 'failed'])
    ('binds the fresh reader and refuses %s substitution', async mode => {
      const child = new ChildProcess();
      Object.assign(child, { stdout: null, stderr: null,
        send: (request: { requestId: string }, callback: (error: null) => void) => {
          callback(null);
          queueMicrotask(() => {
            const receipt = { requestId: request.requestId, targetSource: 'env', review: {
              reviewRef: input.reviewRef, fingerprint: mode === 'wrong-edition' ? 'b'.repeat(64) : input.fingerprint,
              conversationId: 'consult', sourceOwnerId: 'expert', answeringOwnerId: 'answerer', rubricId: 'rubric',
            } };
            if (mode !== 'no-receipt') child.emit('message', receipt);
            if (mode === 'duplicate') child.emit('message', receipt);
            child.emit('close', mode === 'failed' ? 1 : 0, null);
          });
          return true;
        },
      });
      h.fork.mockReturnValue(child);
      const canonical = 'postgresql://canonical/control';
      const result = verifyNativeMethodAuthority('/root', input, { env: {
        PAPERCUSP_TEST_RUNS_DB_URL: canonical, HARNESS_ADMIN_DATABASE_URL: 'postgresql://disposable/product',
      } });
      if (mode === 'approved') await expect(result).resolves.toMatchObject({ review: {
        fingerprint: input.fingerprint, reviewRef: input.reviewRef,
      } });
      else await expect(result).rejects.toThrow();
      expect(h.fork).toHaveBeenLastCalledWith('/root/packages/operator-core/test/native-method-authority-fixture.ts', [],
        expect.objectContaining({ execArgv: ['--import', 'tsx/esm'], env: expect.objectContaining({
          PAPERCUSP_TEST_RUNS_DB_URL: canonical, HARNESS_DATABASE_URL: canonical,
          HARNESS_ADMIN_DATABASE_URL: canonical, DATABASE_URL: canonical,
        }) }));
    });
});
