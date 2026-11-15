import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  defineTool, dispatchProjectedTool, dispatchWithToolExecution, listMcpProjections,
  lookupByMcpName, REQUEST_BOUND_EXECUTION, _resetCatalogForTests,
  _resetProjectionRegistryForTests,
} from '@papercusp/tooldef';

const budgets = { nowMs: 1000, executionDeadlineMs: 61000, transportResponseBudgetMs: 60000 };
afterEach(() => { _resetCatalogForTests(); _resetProjectionRegistryForTests(); });

function fixture() {
  const handler = vi.fn(async (args: { value: number }) => ({
    content: [{ type: 'text' as const, text: 'ok ' + args.value }],
  }));
  const definition = defineTool({
    name: 'execution_contract:p003_probe', description: 'Counted P003 admission probe',
    capability: 'tasks:read', requirePrincipal: false, agentRoles: ['operator'],
    args: z.object({ value: z.number() }), handler,
  });
  const tool = lookupByMcpName(definition.name);
  if (!tool) throw new Error('P003 fixture was not projected');
  const inline = vi.fn(() => dispatchProjectedTool(tool, definition.name, { value: 7 }, {
    log: () => {}, signal: new AbortController().signal, progress: () => {}, emit: () => {},
    workspaceId: 'p003-fixture', role: 'operator', runId: 'p003-fixture-run',
  }, {}));
  return { handler, inline, tool, name: definition.name };
}

it('EXEC-P003 control', async () => {
  const { handler, inline, tool, name } = fixture();
  expect(tool.execution).toEqual(REQUEST_BOUND_EXECUTION);
  expect(listMcpProjections().find(row => row.name === name)?._meta?.['papercusp/execution'])
    .toEqual(REQUEST_BOUND_EXECUTION);
  const result = await dispatchWithToolExecution(tool.execution, { mode: 'auto' }, budgets, { inline });
  expect(result).toMatchObject({
    ok: true, result: { ok: true, result: { content: [{ type: 'text', text: 'ok 7' }] } },
  });
  expect(inline).toHaveBeenCalledTimes(1);
  expect(handler).toHaveBeenCalledTimes(1);
});

it('EXEC-P003 counterexample', async () => {
  const { handler, inline, tool } = fixture();
  const result = await dispatchWithToolExecution(tool.execution, { mode: 'async' }, budgets, { inline });
  expect(result).toMatchObject({
    ok: false, error: 'unsupported_execution_mode', supportedModes: ['sync', 'auto'],
  });
  expect(inline).not.toHaveBeenCalled();
  expect(handler).not.toHaveBeenCalled();
});
