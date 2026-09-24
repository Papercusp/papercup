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
let listOwnedPotHomes: ReturnType<typeof vi.fn>;
let localRowsAsWaiverEntries: ReturnType<typeof vi.fn>;
let shareSecretsGuardPathExemptions: ReturnType<typeof vi.fn>;
let unshareSecretsGuardPathExemptions: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetModules();
  activeWorkspaceId = vi.fn(() => ACTIVE_WS);
  listSecretsGuardPathExemptions = vi.fn(async () => []);
  addSecretsGuardPathExemption = vi.fn(async () => {});
  removeSecretsGuardPathExemption = vi.fn(async () => {});
  // Default: a MEMBER Swarm (owns no pot) — waivers stay local.
  listOwnedPotHomes = vi.fn(async () => []);
  localRowsAsWaiverEntries = vi.fn(async () => []);
  shareSecretsGuardPathExemptions = vi.fn(async (i: { potHomeSlug: string }) => ({
    potHomeSlug: i.potHomeSlug,
    outcome: 'signed',
    policyVersion: 2,
  }));
  unshareSecretsGuardPathExemptions = vi.fn(async (i: { potHomeSlug: string }) => ({
    potHomeSlug: i.potHomeSlug,
    outcome: 'signed',
    policyVersion: 3,
  }));
  vi.doMock('../../workspace-registry', () => ({ activeWorkspaceId }));
  vi.doMock('../../sync/pot-git/secrets-guard-exemptions', () => ({
    listSecretsGuardPathExemptions,
    addSecretsGuardPathExemption,
    removeSecretsGuardPathExemption,
    listOwnedPotHomes,
    localRowsAsWaiverEntries,
    shareSecretsGuardPathExemptions,
    unshareSecretsGuardPathExemptions,
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

/**
 * WI-10002785. A local row reaches only this host, so the owner's adjudication used to
 * re-refuse on every joined peer. `add` on the pot-owner Swarm now also signs the waiver
 * into the pot policy; a member (no pot key) or an ambiguous owner keeps it LOCAL and
 * says so — never a guessed pot.
 */
describe('pot_git:secrets_exemptions — replication through the signed pot policy (WI-10002785)', () => {
  const add = { action: 'add', path: 'libs/x/pem.test.ts', reason: 'PEM fixture' };

  it('owner of exactly one pot: add signs the waiver into that pot', async () => {
    listOwnedPotHomes.mockResolvedValueOnce(['papercusp']);
    const t = await tool();
    const b = body(await t.handler(add, ctxWith({ workspaceId: 'ws-mine', slug: 'su-abc' })));
    expect(addSecretsGuardPathExemption).toHaveBeenCalledTimes(1);
    expect(shareSecretsGuardPathExemptions).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'ws-mine',
        potHomeSlug: 'papercusp',
        entries: [expect.objectContaining({ path: add.path, reason: add.reason, createdBy: 'su-abc' })],
      }),
    );
    expect(b).toMatchObject({ ok: true, replication: { potHomeSlug: 'papercusp', outcome: 'signed' } });
  });

  it('a member (owns no pot) keeps the waiver local and reports it', async () => {
    const t = await tool();
    const b = body(await t.handler(add, ctxWith({ workspaceId: 'ws-mine' })));
    expect(addSecretsGuardPathExemption).toHaveBeenCalledTimes(1);
    expect(shareSecretsGuardPathExemptions).not.toHaveBeenCalled();
    expect(b).toMatchObject({ ok: true, replication: { replicated: false } });
    expect(String((b.replication as { reason: string }).reason)).toContain('no_owned_pot');
  });

  it('owner of several pots and no `pot` arg: does NOT guess — local only, lists the candidates', async () => {
    listOwnedPotHomes.mockResolvedValueOnce(['papercusp', 'other-pot']);
    const t = await tool();
    const b = body(await t.handler(add, ctxWith({ workspaceId: 'ws-mine' })));
    expect(shareSecretsGuardPathExemptions).not.toHaveBeenCalled();
    expect(b).toMatchObject({ replication: { replicated: false, ownedPots: ['papercusp', 'other-pot'] } });
  });

  it('share signs the existing LOCAL rows (optionally one path) into the named pot', async () => {
    localRowsAsWaiverEntries.mockResolvedValueOnce([
      { path: 'a.ts', reason: 'r1' },
      { path: 'b.ts', reason: 'r2' },
    ]);
    const t = await tool();
    const b = body(await t.handler({ action: 'share', pot: 'papercusp', path: 'b.ts' }, ctxWith({ workspaceId: 'ws-mine' })));
    expect(listOwnedPotHomes).not.toHaveBeenCalled(); // an explicit pot wins
    expect(shareSecretsGuardPathExemptions).toHaveBeenCalledWith({
      workspaceId: 'ws-mine',
      potHomeSlug: 'papercusp',
      entries: [{ path: 'b.ts', reason: 'r2' }],
    });
    expect(b).toMatchObject({ ok: true, shared: 1 });
  });

  it('remove re-arms locally AND unsigns from every pot policy still carrying the path', async () => {
    listSecretsGuardPathExemptions.mockResolvedValueOnce([
      { path: 'a.ts', source: 'pot-policy', potHomeSlug: 'papercusp' },
      { path: 'other.ts', source: 'pot-policy', potHomeSlug: 'papercusp' },
    ]);
    const t = await tool();
    const b = body(await t.handler({ action: 'remove', path: 'a.ts' }, ctxWith({ workspaceId: 'ws-mine' })));
    expect(removeSecretsGuardPathExemption).toHaveBeenCalledWith('ws-mine', 'a.ts');
    expect(unshareSecretsGuardPathExemptions).toHaveBeenCalledTimes(1);
    expect(unshareSecretsGuardPathExemptions).toHaveBeenCalledWith({ workspaceId: 'ws-mine', potHomeSlug: 'papercusp', paths: ['a.ts'] });
    expect(b).toMatchObject({ ok: true, removed: 'a.ts', unsigned: [{ outcome: 'signed' }] });
  });
});

/**
 * WI-10000605. The guidance now tells the caller to ADJUDICATE a refusal with a
 * concrete script before adding a row — because this tool REQUIRES the caller to
 * have "confirmed the flagged finding is a false positive" and, until that script
 * existed, shipped no instrument to confirm it. A guard that demands a judgement it
 * gives you no way to make degrades into a rubber stamp SILENTLY: a skipped
 * adjudication is indistinguishable from a passed one.
 *
 * That makes the cited path a second copy of a truth the filesystem owns, so it is
 * pinned here rather than hand-maintained: rename or delete the script and this
 * fails, instead of the tool quietly advertising a command that no longer runs.
 */
describe('pot_git:secrets_exemptions — the cited adjudicator actually exists (WI-10000605)', () => {
  it('chaining names a scripts/*.mts adjudicator, and that file is really on disk', async () => {
    const { existsSync } = await import('node:fs');
    const { resolve, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');

    const meta = (await import('./secrets_exemptions')).default as unknown as {
      guidance?: { chaining?: string };
    };
    const chaining = meta.guidance?.chaining ?? '';

    const cited = [...chaining.matchAll(/scripts\/[\w./-]+\.mts/g)].map((m) => m[0]);
    // POSITIVE CONTROL. Without this, deleting the adjudicator reference from
    // `chaining` leaves `cited` empty and the existsSync loop below passes
    // VACUOUSLY — the same reading a genuinely-healthy guard produces. The whole
    // point of this test is that it must fail when the pointer goes away.
    expect(cited.length).toBeGreaterThan(0);
    expect(cited).toContain('scripts/adjudicate-publish-refusal.mts');

    // .../packages/operator-core/lib/agent-tools/pot_git -> repo root is 5 up.
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
    // Anchor the depth arithmetic, so a wrong level reports ITSELF rather than
    // surfacing as "the adjudicator is missing".
    expect(existsSync(resolve(repoRoot, 'package.json'))).toBe(true);

    for (const p of cited) expect(existsSync(resolve(repoRoot, p))).toBe(true);
  });
});
