/**
 * sandbox_deps.test.ts — the fleet:sandbox_deps HANDLER (checkFleetSandboxHostDeps mocked
 * via a full @papercusp/orchestrator stub — the real package pulls native deps unsuited to
 * a unit run). Thin, but pins that the host-dep report is surfaced under { ok:true, report }.
 * A regression that drops the report payload is what this catches.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/fleet/sandbox_deps.test.ts
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@papercusp/orchestrator', () => ({ checkFleetSandboxHostDeps: vi.fn() }));

import { checkFleetSandboxHostDeps } from '@papercusp/orchestrator';
const checkM = vi.mocked(checkFleetSandboxHostDeps);
const tool = (await import('./sandbox_deps')).default;

type Out = { content: { text: string }[] };
const body = (o: Out) => JSON.parse(o.content[0]!.text);

describe('fleet:sandbox_deps handler', () => {
  it('surfaces the host-dependency report', async () => {
    checkM.mockReturnValue({
      ok: false,
      checks: [{ name: 'bubblewrap', ok: false, remedy: 'apt install bubblewrap' }],
    } as never);
    const b = body(await tool.handler({} as never, {} as never) as Out);
    expect(b).toMatchObject({
      ok: true,
      report: { ok: false, checks: [{ name: 'bubblewrap', ok: false }] },
    });
  });
});
