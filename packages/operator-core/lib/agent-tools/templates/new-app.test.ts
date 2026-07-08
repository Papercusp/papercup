/**
 * Coverage for templates:new-app's composition (WI-3198 / local-first-party-template-
 * bundling-2026-07-07). Hermetic: a mock `inner` stands in for the in-process
 * dispatcher (pot:create + agent_chats), and `resolveSource` yields a source whose
 * `acquireSourceDir` lays down a fixture template dir. The REAL materializeTemplateCore
 * + overlay run against temp dirs. Exercises: happy-path materialize + builder kickoff,
 * source-resolution passthrough, kickoffBuilder:false, and best-effort builder failure.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs, mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
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
      const path = join(scratch, 'apps', args.slug);
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
    expect(payload.filesCopied).toEqual(expect.arrayContaining(['GUIDE.md', 'package.json']));
    expect(payload.template).toMatchObject({ ref: REF, id: LISTING.id });
    expect(payload.guideBranch).toBe('main');
    expect(payload.builder).toMatchObject({ spawned: true, chatId: 'chat-abc', role: 'architect' });

    // template files really landed on the created dir.
    expect(existsSync(join(scratch, 'apps', 'my-app', 'package.json'))).toBe(true);
    // pot:create's blueprint.yaml survived the overlay.
    expect(existsSync(join(scratch, 'apps', 'my-app', '.papercusp', 'blueprint.yaml'))).toBe(true);

    // dispatch order: create pot → create chat → send GUIDE.
    expect(calls.map((c) => c.name)).toEqual([
      'pot:create',
      'agent_chats:create',
      'agent_chats:send_message',
    ]);
    const sent = calls.find((c) => c.name === 'agent_chats:send_message')!;
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
