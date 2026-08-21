/**
 * Coverage for templates:new-app's composition (WI-3198 / local-first-party-template-
 * bundling-2026-07-07). Hermetic: a mock `inner` stands in for the in-process
 * dispatcher (pot:create + agent_chats), and `resolveSource` yields a source whose
 * `acquireSourceDir` lays down a fixture template dir. The REAL materializeTemplateCore
 * + overlay run against temp dirs. Exercises: happy-path materialize + builder kickoff,
 * source-resolution passthrough, kickoffBuilder:false, and best-effort builder failure.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  promises as fs,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { composeNewApp, type NewAppArgs, type NewAppDeps } from './new-app';
import type { TemplateListing, TemplateGuide } from '../../cupboard/templates';

const REF = 'papercusp-webapp';
const LISTING: TemplateListing = {
  id: 'be19a787-93f0-46ae-8f4d-85d728b7131b',
  ref: REF,
  title: 'Papercusp Official: Web App',
  description: 'A whole web app',
  githubUrl: 'https://github.com/Papercusp/templates',
};
const GUIDE: TemplateGuide = {
  ref: REF,
  branch: 'main',
  guide: '# Build it\nMUST: ship a homepage.',
  guideTruncated: false,
  componentCatalog: null,
  manifest: null,
  fetchedFiles: ['GUIDE.md'],
};

let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'newapp-test-'));
});
afterEach(async () => {
  await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
});

function baseArgs(over: Partial<NewAppArgs> = {}): NewAppArgs {
  return {
    template: REF,
    slug: 'my-app',
    kickoffBuilder: true,
    builderRole: 'architect',
    ...over,
  };
}

/**
 * A resolveSource that yields a source whose acquireSourceDir writes a fixture
 * `<srcDir>/` (GUIDE.md + package.json) to overlay — mirrors both the local (no-clone)
 * and remote (post-clone) shape, since composeNewApp is source-agnostic.
 */
function baseDeps(over: Partial<NewAppDeps> = {}): NewAppDeps {
  return {
    resolveSource: (async () => ({
      listing: { id: LISTING.id, ref: REF, title: LISTING.title },
      guide: GUIDE.guide,
      guideTruncated: GUIDE.guideTruncated,
      guideBranch: GUIDE.branch,
      acquireSourceDir: async () => {
        const dir = join(scratch, 'src');
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'GUIDE.md'), '# Build it\n');
        writeFileSync(join(dir, 'package.json'), '{"name":"webapp"}');
        return { srcDir: dir, cleanup: async () => {} };
      },
    })) as NewAppDeps['resolveSource'],
    defaultParentDir: () => {
      const d = join(scratch, 'apps');
      mkdirSync(d, { recursive: true });
      return d;
    },
    ...over,
  };
}

/** A mock inner that mimics pot:create (makes the pot home dir) + agent_chats. */
function mockInner(opts: { failCreateChat?: boolean } = {}) {
  const calls: Array<{ name: string; args: any }> = [];
  const inner = vi.fn(async (name: string, args: any) => {
    calls.push({ name, args });
    if (name === 'pot:create') {
      const path = join(args.parentDir ?? join(scratch, 'apps'), args.slug);
      // pot:create writes the hive (coding-pot) blueprint.yaml; overlay must
      // preserve it (PROTECTED_REL in overlayTemplateFiles).
      mkdirSync(join(path, '.papercusp'), { recursive: true });
      writeFileSync(join(path, '.papercusp', 'blueprint.yaml'), 'id: my-app\nextends: hive\n');
      return { ok: true, slug: args.slug, path };
    }
    if (name === 'agent_chats:create') {
      if (opts.failCreateChat) throw new Error('gate: agent_chats:write denied');
      return { id: 'chat-abc', slug: args.slug };
    }
    if (name === 'agent_chats:send_message') return { ok: true, chatId: args.chatId };
    throw new Error(`unexpected inner call: ${name}`);
  });
  return { inner, calls };
}

function parse(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

describe('composeNewApp', () => {
  it('materializes the template + kicks off a builder chat with the GUIDE', async () => {
    const { inner, calls } = mockInner();
    const result = await composeNewApp(baseArgs(), inner, baseDeps());
    const payload = parse(result);

    expect(payload.ok).toBe(true);
    expect(payload.harnessSlug).toBe('my-app');
    expect(payload.filesCopied).toEqual(
      expect.arrayContaining(['GUIDE.md', 'package.json', 'PROTOCOL.md']),
    );
    expect(payload.template).toMatchObject({ ref: REF, id: LISTING.id });
    expect(payload.guideBranch).toBe('main');
    expect(payload.builder).toMatchObject({ spawned: true, chatId: 'chat-abc', role: 'architect' });

    // template files really landed on the created dir.
    expect(existsSync(join(scratch, 'apps', 'my-app', 'package.json'))).toBe(true);
    // pot:create's blueprint.yaml survived the overlay.
    expect(existsSync(join(scratch, 'apps', 'my-app', '.papercusp', 'blueprint.yaml'))).toBe(true);
    const protocolPath = join(scratch, 'apps', 'my-app', 'PROTOCOL.md');
    expect(readFileSync(protocolPath, 'utf8')).toContain('papercusp-webapp');

    // dispatch order: create pot → create chat → send GUIDE.
    expect(calls.map((c) => c.name)).toEqual([
      'pot:create',
      'agent_chats:create',
      'agent_chats:send_message',
    ]);
    const sent = calls.find((c) => c.name === 'agent_chats:send_message')!;
    expect(sent.args.content).toContain('read PROTOCOL.md first, then GUIDE.md');
    expect(sent.args.content).toContain('MUST: ship a homepage.');
    expect(calls[0].args).toMatchObject({ slug: 'my-app', repoRemote: 'local-only' });
  });

  it('passes through a source-resolution error', async () => {
    const { inner } = mockInner();
    const result = await composeNewApp(
      baseArgs({ template: 'no-such' }),
      inner,
      baseDeps({
        resolveSource: (async () => ({
          error: 'template not found in the local store: no-such',
          status: 404,
        })) as NewAppDeps['resolveSource'],
      }),
    );
    const payload = parse(result);
    expect(payload).toMatchObject({ ok: false, status: 404 });
    expect(inner).not.toHaveBeenCalled();
  });

  it('with kickoffBuilder:false, materializes but spawns no builder', async () => {
    const { inner, calls } = mockInner();
    const result = await composeNewApp(baseArgs({ kickoffBuilder: false }), inner, baseDeps());
    const payload = parse(result);
    expect(payload.ok).toBe(true);
    expect(payload.builder).toEqual({ spawned: false });
    expect(existsSync(join(scratch, 'apps', 'my-app', 'PROTOCOL.md'))).toBe(true);
    expect(calls.map((c) => c.name)).toEqual(['pot:create']);
  });

  it('still succeeds when the builder kickoff fails (best-effort)', async () => {
    const { inner } = mockInner({ failCreateChat: true });
    const result = await composeNewApp(baseArgs(), inner, baseDeps());
    const payload = parse(result);
    expect(payload.ok).toBe(true);
    expect(payload.harnessSlug).toBe('my-app');
    expect(payload.builder).toMatchObject({ spawned: false });
    expect(payload.builder.error).toContain('denied');
  });

  it('surfaces a pot:create failure as ok:false', async () => {
    const calls: string[] = [];
    const inner = vi.fn(async (name: string) => {
      calls.push(name);
      if (name === 'pot:create') return { ok: false, error: 'slug already exists' };
      throw new Error(`unexpected: ${name}`);
    });
    const result = await composeNewApp(baseArgs(), inner, baseDeps());
    const payload = parse(result);
    expect(payload).toMatchObject({ ok: false, status: 422 });
    expect(payload.error).toContain('slug already exists');
    // no builder dispatch after a failed create.
    expect(calls).toEqual(['pot:create']);
  });

  it('surfaces a THROWN pot:create (handler_error plain-text envelope) instead of "unknown error"', async () => {
    // A sub-handler throw reaches the compound via unwrap() as a PLAIN STRING
    // (`handler_error: …`) — not a { error } object. The owner-hit regression
    // (2026-07-07) reported "unknown error" and sent the agent chasing ghosts.
    const inner = vi.fn(async (name: string) => {
      if (name === 'pot:create') return 'handler_error: ENOSPC: no space left on device';
      throw new Error(`unexpected: ${name}`);
    });
    const result = await composeNewApp(baseArgs(), inner, baseDeps());
    const payload = parse(result);
    expect(payload).toMatchObject({ ok: false, status: 422 });
    expect(payload.error).toContain('handler_error: ENOSPC: no space left on device');
    expect(payload.error).not.toContain('unknown error');
  });
});

/**
 * WI-37768 — pot:create is the first DURABLE step. Anything that throws after it used
 * to strand the slug, which made the caller's natural recovery (retry, same args) the
 * one move that provably could not work: pot:create answers slug_exists forever.
 *
 * Measured 2026-08-10: a PgBouncer `write CONNECTION_CLOSED` mid-call, then an
 * identical retry rejected with 422 slug_exists.
 */
describe('composeNewApp — compensating rollback after a durable create (WI-37768)', () => {
  /** An inner whose pot:create succeeds; obliterate is recorded (and can be made to fail). */
  function rollbackInner(opts: { failObliterate?: boolean; createThrows?: unknown } = {}) {
    const calls: Array<{ name: string; args: any }> = [];
    const inner = vi.fn(async (name: string, args: any) => {
      calls.push({ name, args });
      if (name === 'pot:create') {
        if (opts.createThrows !== undefined) throw opts.createThrows;
        const path = join(args.parentDir ?? join(scratch, 'apps'), args.slug);
        mkdirSync(path, { recursive: true });
        return { ok: true, slug: args.slug, path };
      }
      if (name === 'pot:obliterate') {
        if (opts.failObliterate) return { ok: false, error: 'schema drop blocked' };
        return { ok: true, slug: args.slug, obliterated: true };
      }
      if (name === 'agent_chats:create') return { id: 'chat-abc' };
      if (name === 'agent_chats:send_message') return { ok: true };
      throw new Error(`unexpected inner call: ${name}`);
    });
    return { inner, calls };
  }

  /** Deps whose source dir does not exist → the OVERLAY throws, after pot:create committed. */
  function overlayFailingDeps(): NewAppDeps {
    return baseDeps({
      resolveSource: (async () => ({
        listing: { id: LISTING.id, ref: REF, title: LISTING.title },
        guide: GUIDE.guide,
        guideTruncated: false,
        guideBranch: GUIDE.branch,
        acquireSourceDir: async () => ({
          srcDir: join(scratch, 'does-not-exist'),
          cleanup: async () => {},
        }),
      })) as NewAppDeps['resolveSource'],
    });
  }

  it('rolls the pot back when a step AFTER pot:create fails, so the retry is unblocked', async () => {
    const { inner, calls } = rollbackInner();
    const customParent = join(scratch, 'custom-parent');
    mkdirSync(customParent, { recursive: true });
    const result = await composeNewApp(baseArgs({ parentDir: customParent }), inner, overlayFailingDeps());
    const payload = parse(result);

    expect(payload.ok).toBe(false);
    // The pot really was obliterated — the point of the fix, not just a nicer message.
    expect(calls.map((c) => c.name)).toEqual(['pot:create', 'pot:obliterate']);
    expect(calls[1].args).toMatchObject({ slug: 'my-app', confirm: true });
    expect(existsSync(join(customParent, 'my-app'))).toBe(false);
    // And the caller is TOLD the retry is now safe, rather than having to infer it.
    expect(payload.error).toContain('ROLLED BACK');
    expect(payload.error).toContain('retrying with the same slug is safe');
  });

  it('rolls back when pot:create itself THROWS (the observed PgBouncer failure)', async () => {
    // pot:create commits its registry row before it finishes, so a throw can leave a
    // pot behind with the caller holding no result at all.
    const { inner, calls } = rollbackInner({
      createThrows: new Error('write CONNECTION_CLOSED 127.0.0.1:6432'),
    });
    const result = await composeNewApp(baseArgs(), inner, baseDeps());
    const payload = parse(result);

    expect(payload.ok).toBe(false);
    expect(calls.map((c) => c.name)).toEqual(['pot:create', 'pot:obliterate']);
    expect(payload.error).toContain('CONNECTION_CLOSED');
    expect(payload.error).toContain('ROLLED BACK');
  });

  it('NEVER rolls back on slug_exists — that pot belongs to an earlier call', async () => {
    // The one case where compensating would destroy a project this call never created.
    // If this test ever goes green while an obliterate is dispatched, the fix has become
    // a data-loss bug.
    const { inner, calls } = rollbackInner({
      createThrows: new Error("slug_exists: A harness 'my-app' already exists in this workspace."),
    });
    const result = await composeNewApp(baseArgs(), inner, baseDeps());
    const payload = parse(result);

    expect(payload).toMatchObject({ ok: false, status: 422 });
    expect(calls.map((c) => c.name)).toEqual(['pot:create']);
    expect(inner).not.toHaveBeenCalledWith('pot:obliterate', expect.anything());
    // ...and it says why retrying unchanged is pointless, which the bare passthrough did not.
    expect(payload.error).toContain('RETRYING THIS CALL UNCHANGED CANNOT SUCCEED');
    expect(payload.error).toContain('pot:obliterate');
  });

  it('reports honestly when the rollback ALSO fails (the slug is still taken)', async () => {
    // The failure that triggers a rollback is often the same thing that breaks it — a
    // dropped PG connection cannot be used to un-write. Saying "rolled back" here would
    // send the caller into a retry that cannot succeed.
    const { inner, calls } = rollbackInner({ failObliterate: true });
    const result = await composeNewApp(baseArgs(), inner, overlayFailingDeps());
    const payload = parse(result);

    expect(payload.ok).toBe(false);
    expect(calls.map((c) => c.name)).toEqual(['pot:create', 'pot:obliterate']);
    expect(payload.error).toContain('ROLLBACK ALSO FAILED');
    expect(payload.error).toContain('still taken');
    expect(payload.error).not.toContain('is safe');
  });
});

/**
 * P-005 / WI-37791 — the per-install component-package path reaches the builder.
 *
 * The GUIDE ships one text to every platform and can only cite the dev-checkout
 * example, so the resolved root has to be injected at kickoff time. A builder that
 * never sees it writes `file:../papercusp/libs/generic/<pkg>` and fails npm install
 * on packages that are all private — which is the bug this closes.
 */
describe('composeNewApp — libs/generic supply chain', () => {
  const withTree: NewAppDeps['resolveSupplyChain'] = () => ({
    root: '/opt/install/dev-source/libs/generic',
    sourceRoot: '/opt/install/dev-source',
    source: 'dev-source-tree',
    pending: false,
    available: ['sync', 'ui-primitives'],
    explanation: 'RESOLVED-ROOT-EXPLANATION',
  });
  const noTree: NewAppDeps['resolveSupplyChain'] = () => ({
    root: null,
    sourceRoot: null,
    source: 'none',
    pending: false,
    available: [],
    explanation: 'CANNOT be file:-linked here — NO-TREE-EXPLANATION',
  });

  it('reports the resolved root on the result AND in the builder kickoff', async () => {
    const { inner, calls } = mockInner();
    const result = await composeNewApp(
      baseArgs(),
      inner,
      baseDeps({ resolveSupplyChain: withTree }),
    );
    const payload = parse(result);

    expect(payload.supplyChain).toMatchObject({
      root: '/opt/install/dev-source/libs/generic',
      source: 'dev-source-tree',
    });
    const sent = calls.find((c) => c.name === 'agent_chats:send_message')!;
    expect(sent.args.content).toContain('/opt/install/dev-source/libs/generic');
    // The GUIDE still leads; the supply-chain correction follows it.
    expect(sent.args.content.indexOf('MUST: ship a homepage.')).toBeLessThan(
      sent.args.content.indexOf('/opt/install/dev-source/libs/generic'),
    );
  });

  it('tells the builder plainly when this install has NO tree, rather than staying silent', async () => {
    const { inner, calls } = mockInner();
    const result = await composeNewApp(baseArgs(), inner, baseDeps({ resolveSupplyChain: noTree }));

    expect(parse(result).supplyChain).toMatchObject({ root: null, source: 'none' });
    const sent = calls.find((c) => c.name === 'agent_chats:send_message')!;
    expect(sent.args.content).toContain('NO-TREE-EXPLANATION');
    // Never the dev-checkout path as an instruction.
    expect(sent.args.content).not.toContain('"file:../papercusp/libs/generic');
  });

  it('still reports the supply chain when no builder is kicked off', async () => {
    const { inner } = mockInner();
    const result = await composeNewApp(
      baseArgs({ kickoffBuilder: false }),
      inner,
      baseDeps({ resolveSupplyChain: withTree }),
    );
    expect(parse(result).supplyChain.root).toBe('/opt/install/dev-source/libs/generic');
  });
});
