/**
 * set-priority.test.ts — handler-level unit tests for plans:set-priority
 * (dbos-system-completion P-045/D-013).
 *
 * The verb resolves a harness slug then issues one UPDATE against
 * harness_shared.harness_plans.op_priority inside withWorkspace (op_priority
 * was folded onto the plan's own row under PG-canonical storage). We mock
 * withWorkspace to capture the tagged-template call so the SQL shape, the
 * threaded params (incl. a null priority = clear), the harness resolution
 * precedence, and the return shape are verified without a real database.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => {
  const state: { txCalls: { strings: readonly string[]; values: unknown[] }[] } = { txCalls: [] };
  // A captured `tx` tagged template: tx`...${v}...` → tx(strings, ...values).
  const tx = (strings: readonly string[], ...values: unknown[]) => {
    state.txCalls.push({ strings, values });
    return Promise.resolve([]);
  };
  const withWorkspace = async (_wsId: string, fn: (t: unknown) => Promise<unknown>) => fn(tx);
  return { state, withWorkspace };
});

vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await orig<typeof import('@papercusp/db-org')>();
  return { ...actual, withWorkspace: H.withWorkspace };
});

import tool from '../set-priority';
import { DEFAULT_WORKSPACE_ID } from '../../../workspace-registry';

const MAKE_CTX = (harnessSlug?: string) =>
  ({
    log: vi.fn(),
    signal: new AbortController().signal,
    progress: vi.fn(),
    workspaceId: DEFAULT_WORKSPACE_ID,
    harnessSlug,
    role: 'operator' as const,
    principal: { slug: 'agent-test' },
  } as never);

const run = async (args: Record<string, unknown>, ctxHarness?: string) =>
  (await tool.handler(args as never, MAKE_CTX(ctxHarness))) as { content: { text: string }[] };

beforeEach(() => {
  H.state.txCalls = [];
});

describe('plans:set-priority', () => {
  it('issues one UPDATE on harness_plans.op_priority and returns the resolved fields', async () => {
    const res = await run({ slug: 'my-plan-2026-06-01', priority: 3, harness: 'myharn' });

    expect(H.state.txCalls).toHaveLength(1);
    const { strings, values } = H.state.txCalls[0];
    const sqlText = strings.join('§');
    expect(sqlText).toContain('UPDATE harness_shared.harness_plans');
    expect(sqlText).toContain('op_priority');
    // Params: [priority, op_updated_at, workspace_id, harness_slug, plan_slug].
    expect(values[0]).toBe(3);
    expect(values[2]).toBe(DEFAULT_WORKSPACE_ID);
    expect(values[3]).toBe('myharn');
    expect(values[4]).toBe('my-plan-2026-06-01');

    const data = JSON.parse(res.content[0].text);
    expect(data).toMatchObject({ ok: true, slug: 'my-plan-2026-06-01', harnessSlug: 'myharn', priority: 3 });
  });

  it('threads a null priority through (clear → use started-order default)', async () => {
    const res = await run({ slug: 'p', priority: null, harness: 'myharn' });
    expect(H.state.txCalls[0].values[0]).toBeNull();
    expect(JSON.parse(res.content[0].text).priority).toBeNull();
  });

  it('resolves the harness from ctx when no explicit arg is given', async () => {
    await run({ slug: 'p', priority: 1 }, 'ctxharn');
    expect(H.state.txCalls[0].values[3]).toBe('ctxharn');
  });

  it("defaults to the 'papercup' harness when the arg is the all-sentinel", async () => {
    const res = await run({ slug: 'p', priority: 1, harness: 'all' });
    expect(H.state.txCalls[0].values[3]).toBe('papercup');
    expect(JSON.parse(res.content[0].text).harnessSlug).toBe('papercup');
  });

  it('refuses when neither an arg nor a ctx harness scope is present', async () => {
    await expect(run({ slug: 'p', priority: 1 })).rejects.toThrow();
    expect(H.state.txCalls).toHaveLength(0);
  });
});
