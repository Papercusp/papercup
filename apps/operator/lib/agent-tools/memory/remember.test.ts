import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../memory/mem0-client', () => ({
  getMemoryClient: vi.fn(),
}));
vi.mock('../../auth', () => ({
  getSessionUserOrDefault: vi.fn(),
}));
vi.mock('@papercusp/agent-mcp', () => ({
  defineTool: (def: unknown) => def,
}));

import remember from './remember';
import { getMemoryClient } from '../../memory/mem0-client';
import { getSessionUserOrDefault } from '../../auth';

type MaybeAdd = { add: ReturnType<typeof vi.fn> };

const fakeClient = (): MaybeAdd => ({
  add: vi.fn(async () => ({ ok: true })),
});

const fakeCtx = {
  workspaceId: 'ws-test',
} as unknown as Parameters<typeof remember.handler>[1];

beforeEach(() => {
  vi.mocked(getSessionUserOrDefault).mockResolvedValue({
    id: 'user-1',
    display_name: 'Test User',
  } as unknown as Awaited<ReturnType<typeof getSessionUserOrDefault>>);
});

describe('memory:remember — anchor extraction (P-015)', () => {
  it('writes anchors metadata when body contains structural references', async () => {
    const c = fakeClient();
    vi.mocked(getMemoryClient).mockResolvedValue(c as unknown as Awaited<ReturnType<typeof getMemoryClient>>);

    const res = await remember.handler(
      {
        content:
          'Per memory-harness-scope-2026-05-24 plan, F-001 lives in apps/operator/lib/memory/injection.ts.',
        kind: 'project',
      },
      fakeCtx,
    );

    expect(JSON.parse(res.content[0].text).ok).toBe(true);

    expect(c.add).toHaveBeenCalledTimes(1);
    const [, opts] = c.add.mock.calls[0];
    const meta = (opts as { metadata: Record<string, unknown> }).metadata;

    expect(meta.anchor_count).toBe(3);
    expect(meta.anchors).toEqual(
      expect.arrayContaining([
        { kind: 'file', value: 'apps/operator/lib/memory/injection.ts' },
        { kind: 'feature', value: 'F-001' },
        { kind: 'plan', value: 'memory-harness-scope-2026-05-24' },
      ]),
    );
  });

  it('omits anchor metadata when body has no anchors', async () => {
    const c = fakeClient();
    vi.mocked(getMemoryClient).mockResolvedValue(c as unknown as Awaited<ReturnType<typeof getMemoryClient>>);

    await remember.handler(
      {
        content: 'Avi prefers terse responses',
        kind: 'preference',
      },
      fakeCtx,
    );

    const [, opts] = c.add.mock.calls[0];
    const meta = (opts as { metadata: Record<string, unknown> }).metadata;
    expect(meta.anchors).toBeUndefined();
    expect(meta.anchor_count).toBeUndefined();
  });

  it('preserves existing metadata fields (kind, scope, etc.) alongside anchors', async () => {
    const c = fakeClient();
    vi.mocked(getMemoryClient).mockResolvedValue(c as unknown as Awaited<ReturnType<typeof getMemoryClient>>);

    await remember.handler(
      {
        content: 'F-AUTH-001 needs apps/operator/lib/auth.ts',
        kind: 'project',
        harness_slug: 'sheets',
      },
      fakeCtx,
    );

    const [, opts] = c.add.mock.calls[0];
    const meta = (opts as { metadata: Record<string, unknown> }).metadata;
    expect(meta.kind).toBe('project');
    expect(meta.scope).toBe('harness');
    expect(meta.harness_slug).toBe('sheets');
    expect(meta.workspace_id).toBe('ws-test');
    expect(meta.anchor_count).toBe(2);
  });
});
