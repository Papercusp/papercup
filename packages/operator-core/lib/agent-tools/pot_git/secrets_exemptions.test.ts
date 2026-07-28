/**
 * pot_git:secrets_exemptions handler unit tests (WI-6641) — PG-free, mocks the
 * store module + workspace-registry (mirrors integration_requests.test.ts).
 *
 * What these pin down: the tool is `crossWorkspace: true` ONLY so an UNSCOPED psu
 * gets the getOrgPg admin handle (the exemptions table is not RLS-scoped). That is
 * also what made it `workspace_forbidden` from a workspace-scoped session — i.e.
 * unreachable by exactly the agents who trip the secrets guard, while the guard's
 * own refusal message instructs them to run it. It is now on the handler's
 * SCOPED_SAFE_CROSSWORKSPACE allowlist, and the price of that entry is
 * SELF-CONFINEMENT: a scoped principal must not be able to reach another
 * workspace's rows. These tests are the guard on that price.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ACTIVE_WS = 'ws-active';

type Body = { ok: boolean; [k: string]: unknown };
const body = (r: { content?: Array<{ text: string }> }): Body => JSON.parse(r.content![0].text);
const textOf = (r: { content?: Array<{ text: string }> }): string => r.content![0].text;

function ctxWith(principal: { workspaceId?: string; slug?: string } | null): unknown {
  return { principal: principal ?? undefined } as never;
}

let activeWorkspaceId: ReturnType<typeof vi.fn>;
let listSecretsGuardPathExemptions: ReturnType<typeof vi.fn>;
let addSecretsGuardPathExemption: ReturnType<typeof vi.fn>;
let removeSecretsGuardPathExemption: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetModules();
  activeWorkspaceId = vi.fn(() => ACTIVE_WS);
  listSecretsGuardPathExemptions = vi.fn(async () => []);
  addSecretsGuardPathExemption = vi.fn(async () => {});
  removeSecretsGuardPathExemption = vi.fn(async () => {});
  vi.doMock('../../workspace-registry', () => ({ activeWorkspaceId }));
  vi.doMock('../../sync/pot-git/secrets-guard-exemptions', () => ({
    listSecretsGuardPathExemptions,
    addSecretsGuardPathExemption,
    removeSecretsGuardPathExemption,
  }));
});

afterEach(() => {
  vi.doUnmock('../../workspace-registry');
  vi.doUnmock('../../sync/pot-git/secrets-guard-exemptions');
});

async function tool() {
  return (await import('./secrets_exemptions')).default as unknown as {
    crossWorkspace?: boolean;
    handler: (a: unknown, c: unknown) => Promise<{ content?: Array<{ text: string }>; isError?: boolean }>;
  };
}

describe('pot_git:secrets_exemptions — workspace resolution', () => {
  it("action:'list' resolves the workspace from the caller's principal", async () => {
    const t = await tool();
    const b = body(await t.handler({ action: 'list' }, ctxWith({ workspaceId: 'ws-1' })));
    expect(listSecretsGuardPathExemptions).toHaveBeenCalledWith('ws-1');
    expect(b).toMatchObject({ ok: true, workspaceId: 'ws-1', count: 0 });
  });

  it("falls back to activeWorkspaceId() when the principal is UNSCOPED ('*')", async () => {
    const t = await tool();
    const b = body(await t.handler({ action: 'list' }, ctxWith({ workspaceId: '*' })));
    expect(listSecretsGuardPathExemptions).toHaveBeenCalledWith(ACTIVE_WS);
    expect(b).toMatchObject({ workspaceId: ACTIVE_WS });
  });

  it('falls back to activeWorkspaceId() when there is no principal at all', async () => {
    const t = await tool();
    const b = body(await t.handler({ action: 'list' }, ctxWith(null)));
    expect(listSecretsGuardPathExemptions).toHaveBeenCalledWith(ACTIVE_WS);
    expect(b).toMatchObject({ workspaceId: ACTIVE_WS });
  });
});

describe('pot_git:secrets_exemptions — self-confinement (the price of the scoped-safe allowlist entry)', () => {
  it('REFUSES a scoped principal targeting ANOTHER workspace, and writes nothing', async () => {
    const t = await tool();
    const res = await t.handler(
      { action: 'add', path: 'a/b.ts', reason: 'fixture', workspaceId: 'ws-someone-else' },
      ctxWith({ workspaceId: 'ws-mine' }),
    );
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('workspace_forbidden');
    expect(addSecretsGuardPathExemption).not.toHaveBeenCalled();
  });

  it('refuses a foreign target on the REMOVE path too (re-arming another workspace is also a write)', async () => {
    const t = await tool();
    const res = await t.handler(
      { action: 'remove', path: 'a/b.ts', workspaceId: 'ws-someone-else' },
      ctxWith({ workspaceId: 'ws-mine' }),
    );
    expect(res.isError).toBe(true);
    expect(removeSecretsGuardPathExemption).not.toHaveBeenCalled();
  });

  it('refuses a foreign target on the READ path too (an exemption list names paths worth attacking)', async () => {
    const t = await tool();
    const res = await t.handler(
      { action: 'list', workspaceId: 'ws-someone-else' },
      ctxWith({ workspaceId: 'ws-mine' }),
    );
    expect(res.isError).toBe(true);
    expect(listSecretsGuardPathExemptions).not.toHaveBeenCalled();
  });

  it('ALLOWS a scoped principal naming its OWN workspace explicitly (redundant, not hostile)', async () => {
    const t = await tool();
    const b = body(
      await t.handler({ action: 'list', workspaceId: 'ws-mine' }, ctxWith({ workspaceId: 'ws-mine' })),
    );
    expect(b).toMatchObject({ ok: true, workspaceId: 'ws-mine' });
  });

  it('an UNSCOPED psu MAY still target any workspace — the reason crossWorkspace:true exists', async () => {
    const t = await tool();
    const b = body(
      await t.handler({ action: 'list', workspaceId: 'ws-other' }, ctxWith({ workspaceId: '*' })),
    );
    expect(listSecretsGuardPathExemptions).toHaveBeenCalledWith('ws-other');
    expect(b).toMatchObject({ workspaceId: 'ws-other' });
  });

  it('a scoped principal can still run the RECOVERY it is told to run — add/remove on its own workspace', async () => {
    // The whole point of WI-6641: this is the call an agent makes after the guard
    // refuses a publish. It must reach the store, scoped to the caller's workspace.
    const t = await tool();
    const b = body(
      await t.handler(
        { action: 'add', path: 'pkg/lib/redactor.test.ts', reason: 'redaction-test fixtures' },
        ctxWith({ workspaceId: 'ws-mine', slug: 'su-abc' }),
      ),
    );
    expect(addSecretsGuardPathExemption).toHaveBeenCalledWith({
      workspaceId: 'ws-mine',
      path: 'pkg/lib/redactor.test.ts',
      reason: 'redaction-test fixtures',
      createdBy: 'su-abc',
    });
    expect(b).toMatchObject({ ok: true, workspaceId: 'ws-mine', added: 'pkg/lib/redactor.test.ts' });
  });
});
