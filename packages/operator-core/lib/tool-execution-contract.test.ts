import { expect, it, vi } from 'vitest';
import { dispatchWithToolExecution, REQUEST_BOUND_EXECUTION } from '@papercusp/tooldef';

const budgets = { nowMs: 1000, executionDeadlineMs: 61000, transportResponseBudgetMs: 60000 };

it('EXEC-P003 control', async () => {
  const handler = vi.fn(async () => ({ value: 7 }));
  const result = await dispatchWithToolExecution(
    REQUEST_BOUND_EXECUTION, { mode: 'sync' }, budgets, { inline: handler },
  );
  expect(result).toMatchObject({
    ok: true, result: { value: 7 },
    selection: { mode: 'sync', lifecycle: 'request-bound', autoYieldAfterMs: null },
  });
  expect(handler).toHaveBeenCalledTimes(1);
});

it('EXEC-P003 counterexample', async () => {
  const handler = vi.fn(async () => ({ value: 7 }));
  const detached = vi.fn(async () => ({ result: { value: 7 }, admission: {
    handle: 'must-never-be-admitted', ownerId: 'original-owner', state: 'accepted' as const,
  } }));
  const verifyAdmission = vi.fn(async () => false);
  const result = await dispatchWithToolExecution(
    REQUEST_BOUND_EXECUTION, { mode: 'async' }, budgets,
    { ownerId: 'original-owner', inline: handler,
      adapter: { id: 'unapproved-detachment', dispatch: detached, verifyAdmission } },
  );
  expect(result).toMatchObject({
    ok: false, error: 'unsupported_execution_mode', supportedModes: ['sync', 'auto'],
  });
  expect(handler).not.toHaveBeenCalled();
  expect(detached).not.toHaveBeenCalled();
  expect(verifyAdmission).not.toHaveBeenCalled();
});
