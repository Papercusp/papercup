/**
 * role-override.test.ts — the prompt:role_override TOOL (live-configurability-audit P-001).
 *
 * Mocks the prompt-override store + control harness (separately covered) + workspace-registry.
 * Asserts: get/list read · set is operator-authority gated · set applies via setPromptOverride ·
 * clear (one role) deletes · clear (no role) wipes all · dryRun does not write.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/prompt/role-override.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../workspace-registry', async (orig) => ({ ...(await orig<Record<string, unknown>>()), activeWorkspaceId: () => 'default' }));
vi.mock('../../harness-prompt-overrides', () => ({
  getPromptOverride: vi.fn(),
  setPromptOverride: vi.fn(),
  deletePromptOverride: vi.fn(),
  clearAllPromptOverrides: vi.fn(),
  listPromptOverrides: vi.fn(),
}));
vi.mock('../../gateway-control/control-harness', () => ({
  runControlMutation: vi.fn(async (spec: any, opts: any = {}) => {
    const prev = await spec.capturePrev();
    if (opts.dryRun) return { dryRun: true, applied: false, prev, preview: spec.describe?.(prev) };
    const next = await spec.apply();
    const verify = spec.verify ? await spec.verify(next) : undefined;
    return { dryRun: false, applied: true, prev, next, verify, auditId: 'aud-1' };
  }),
}));

import {
  getPromptOverride,
  setPromptOverride,
  deletePromptOverride,
  clearAllPromptOverrides,
  listPromptOverrides,
} from '../../harness-prompt-overrides';

const getM = vi.mocked(getPromptOverride);
const setM = vi.mocked(setPromptOverride);
const delM = vi.mocked(deletePromptOverride);
const clearAllM = vi.mocked(clearAllPromptOverrides);
const listM = vi.mocked(listPromptOverrides);

const tool = (await import('./role-override')).default;

type Out = { content: { text: string }[] };
const body = (o: unknown) => JSON.parse((o as Out).content[0]!.text);

beforeEach(() => {
  vi.clearAllMocks();
  getM.mockResolvedValue(null);
  setM.mockResolvedValue(undefined as never);
  delM.mockResolvedValue(true as never);
  clearAllM.mockResolvedValue(0 as never);
  listM.mockResolvedValue([] as never);
});

describe('prompt:role_override — reads', () => {
  it('get returns the override', async () => {
    getM.mockResolvedValue('OVERRIDE MD');
    const b = body(await tool.handler({ op: 'get', harness: 'h', role: 'validator' } as never, { role: 'su' } as never));
    expect(b).toEqual({ harness: 'h', role: 'validator', override: 'OVERRIDE MD' });
  });
  it('list returns the overrides', async () => {
    listM.mockResolvedValue([{ role: 'validator', promptMd: 'X', updatedAt: 1 }] as never);
    const b = body(await tool.handler({ op: 'list', harness: 'h' } as never, { role: 'su' } as never));
    expect(b.overrides).toHaveLength(1);
  });
});

describe('prompt:role_override — set', () => {
  it('is operator-authority gated', async () => {
    await expect(
      tool.handler({ op: 'set', harness: 'h', role: 'validator', content: 'NEW' } as never, { role: 'bee' } as never),
    ).rejects.toThrow(/operator, architect, or queen/i);
    expect(setM).not.toHaveBeenCalled();
  });
  it('applies the override and verifies', async () => {
    getM.mockResolvedValueOnce(null).mockResolvedValue('NEW CONTENT'); // prev=null, post-set read=content
    const b = body(
      await tool.handler({ op: 'set', harness: 'h', role: 'validator', content: 'NEW CONTENT' } as never, { role: 'operator' } as never),
    );
    expect(setM).toHaveBeenCalledWith('default', 'h', 'validator', 'NEW CONTENT');
    expect(b).toMatchObject({ ok: true, applied: true, verify: { ok: true } });
  });
  it('dryRun does not write', async () => {
    const b = body(
      await tool.handler(
        { op: 'set', harness: 'h', role: 'validator', content: 'NEW', dryRun: true } as never,
        { role: 'operator' } as never,
      ),
    );
    expect(setM).not.toHaveBeenCalled();
    expect(b).toMatchObject({ dryRun: true, applied: false });
  });
});

describe('prompt:role_override — clear', () => {
  it('clears one role (delete)', async () => {
    const b = body(
      await tool.handler({ op: 'clear', harness: 'h', role: 'validator' } as never, { role: 'operator' } as never),
    );
    expect(delM).toHaveBeenCalledWith('default', 'h', 'validator');
    expect(b).toMatchObject({ ok: true, cleared: 'role', applied: true });
  });
  it('clears ALL for the harness when role omitted', async () => {
    listM.mockResolvedValue([{ role: 'a', promptMd: 'X', updatedAt: 1 }] as never);
    const b = body(await tool.handler({ op: 'clear', harness: 'h' } as never, { role: 'operator' } as never));
    expect(clearAllM).toHaveBeenCalledWith('default', 'h');
    expect(b).toMatchObject({ ok: true, cleared: 'all' });
  });
  it('is operator-authority gated', async () => {
    await expect(
      tool.handler({ op: 'clear', harness: 'h' } as never, { role: 'bee' } as never),
    ).rejects.toThrow(/operator, architect, or queen/i);
    expect(clearAllM).not.toHaveBeenCalled();
  });
});
