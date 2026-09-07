/**
 * Install-plugin-from-Cupboard core (revive-cupboard-distribution P2 / D-003).
 * Pure-ish: clone / global-plugins dir / grant / host-invalidate are injected,
 * so this covers the locate→copy→consent→invalidate flow without real git, PG,
 * or the route registry. `cloneRepo` is faked by copying a local fixture dir.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  installPluginFromCupboardCore,
  InstallPluginError,
  type InstallPluginCoreDeps,
} from './install-plugin-core';

let root: string;        // scratch root for fixtures + install target
let fixtureRepo: string; // the "remote" repo a fake clone copies from
let globalDir: string;   // the install target (global-plugins)
let granted: Array<{ pluginName: string; pluginVersion: string; harnessSlug: string; capabilities: string[] }>;
let invalidated: number;
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

async function writeManifest(dir: string, m: Record<string, unknown>): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(join(dir, 'papercusp.json'), JSON.stringify(m), 'utf8');
}

function makeDeps(over: Partial<InstallPluginCoreDeps> = {}): InstallPluginCoreDeps {
  return {
    // Fake clone = copy the fixture repo into dest (incl. a .git dir to prove exclusion).
    cloneRepo: async (_url, dest) => {
      await fs.cp(fixtureRepo, dest, { recursive: true });
    },
    globalPluginsDir: () => globalDir,
    tmpDir: () => root,
    grant: async (args) => { granted.push(args); },
    invalidateHost: () => { invalidated += 1; },
    ...over,
  };
}

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'install-core-'));
  fixtureRepo = join(root, 'remote');
  globalDir = join(root, 'global-plugins');
  granted = [];
  invalidated = 0;
  await fs.mkdir(fixtureRepo, { recursive: true });
  // a .git dir that must NOT be copied into the install
  await writeManifest(join(fixtureRepo, '.git'), { not: 'a manifest' });
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('installPluginFromCupboardCore', () => {
  it('installs a root-level plugin and invalidates the host', async () => {
    await writeManifest(fixtureRepo, { name: 'cool-plugin', version: '1.2.0', capabilities: ['net:fetch'] });
    await fs.writeFile(join(fixtureRepo, 'index.cjs'), 'module.exports = {};', 'utf8');

    const res = await installPluginFromCupboardCore(
      { githubUrl: 'https://github.com/acme/cool-plugin' },
      makeDeps(),
    );
    expect(res.ok).toBe(true);
    expect(res.name).toBe('cool-plugin');
    expect(res.version).toBe('1.2.0');
    expect(res.capabilities).toEqual(['net:fetch']);
    expect(res.granted).toEqual([]); // no harness target → no grant
    expect(invalidated).toBe(1);

    const installed = join(globalDir, 'cool-plugin');
    expect(existsSync(join(installed, 'papercusp.json'))).toBe(true);
    expect(existsSync(join(installed, 'index.cjs'))).toBe(true);
    // .git must be excluded from the install
    expect(existsSync(join(installed, '.git'))).toBe(false);
  });

  it('installs a manifest-only trigger pack, validates its plan, and returns a disarmed discovery receipt', async () => {
    const scopes = [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.compose',
    ];
    await writeManifest(fixtureRepo, {
      name: 'email-draft-responder',
      version: '0.1.0',
      kind: 'plugin',
      capabilities: [],
      oauth: [{ provider: 'google', scopes, fieldName: 'googleWorkspace' }],
      configSchema: {
        type: 'object',
        properties: {
          googleWorkspace: {
            type: 'string',
            secret: true,
            shareable: false,
            snapshotPolicy: 'strip',
            oauth: { provider: 'google', scopes },
          },
        },
      },
      triggerPack: {
        inputs: { type: 'object', properties: {} },
        defaultStormPolicy: { maxRuns: 5, windowSeconds: 60 },
        targets: [
          {
            id: 'draft-reply',
            kind: 'plan',
            path: 'plan.md',
            inputSchema: { type: 'object', properties: { trigger: { type: 'object' } } },
          },
          {
            id: 'record-draft',
            kind: 'recipe',
            ref: 'recipes:record-draft',
            revision: 2,
            argsSchema: {
              type: 'object',
              required: ['draftId'],
              properties: { draftId: { type: 'string' } },
            },
          },
        ],
        bindings: [
          {
            id: 'gmail-to-draft',
            source: { kind: 'external', sourceKind: 'gmail', oauthField: 'googleWorkspace' },
            target: 'draft-reply',
            eventPattern: 'ext:gmail:message.received',
            filter: { direction: 'inbound' },
            mapping: { mode: 'payload-context' },
          },
          {
            id: 'draft-to-record',
            source: { kind: 'internal', event: 'plan-completed' },
            target: 'record-draft',
            mapping: { mode: 'fields', fields: { draftId: 'plan.output.draftId' } },
            retry: { maxAttempts: 3, onExhausted: 'dead-letter' },
          },
        ],
        edges: [{
          from: 'gmail-to-draft',
          to: 'draft-to-record',
          event: 'plan-completed',
          correlation: 'inherit',
        }],
      },
    });
    await fs.writeFile(join(fixtureRepo, 'plan.md'), `---
title: Email draft responder
slug: email-draft-responder
status: draft
---
# Email draft responder
## Phase 1 — Draft
- **P-001** \`todo\` Draft the reply.
`, 'utf8');

    const res = await installPluginFromCupboardCore(
      { githubUrl: 'https://github.com/acme/email-draft-responder' },
      makeDeps(),
    );
    expect(res.triggerPack).toEqual({
      targetCount: 2,
      bindingCount: 2,
      edgeCount: 1,
      sourceKinds: ['gmail'],
      planTargets: [{ id: 'draft-reply', path: 'plan.md', slug: 'email-draft-responder' }],
      armed: false,
    });
    expect(invalidated).toBe(1);
    expect(existsSync(join(globalDir, 'email-draft-responder', 'plan.md'))).toBe(true);
  });

  it.each([
    ['email-draft-responder', 'gmail'],
    ['slack-thread-responder', 'slack'],
    ['meeting-prep-brief', 'gcal'],
  ] as const)('installs the shipped %s plan template through the real validation path', async (slug, sourceKind) => {
    fixtureRepo = join(REPO_ROOT, 'libs/papercusp/plugins', slug);

    const res = await installPluginFromCupboardCore(
      { githubUrl: `https://github.com/papercupai/${slug}` },
      makeDeps(),
    );

    expect(res.triggerPack).toMatchObject({
      targetCount: 1,
      bindingCount: 1,
      edgeCount: 0,
      sourceKinds: [sourceKind],
      planTargets: [{ path: 'plan.md', slug }],
      armed: false,
    });
    expect(existsSync(join(res.installedTo, 'plan.md'))).toBe(true);
  });

  // P-026. Separate from the trio above because the social packs differ in the
  // two places that table hardcodes: they bind SEVERAL platforms to one target,
  // and they declare no oauthField at all (no social platform in scope has a
  // platform-wide OAuth provider to name). Folding them into the P-021 case
  // would have to relax both assertions for every pack, weakening the trio's
  // coverage to accommodate a different shape.
  it.each([
    ['social-mention-triage', 2, ['bluesky', 'mastodon']],
    ['social-comment-digest', 5, ['facebook-pages', 'instagram', 'reddit', 'threads', 'youtube']],
    // A `manual` source contributes no sourceKind: install-plugin-core collects
    // them from external bindings only, so an empty list here is the correct
    // reading of "nothing external feeds this pack", not a missing platform.
    ['social-scheduled-crosspost', 1, []],
  ] as const)('installs the shipped %s social pack through the real validation path', async (slug, bindingCount, sourceKinds) => {
    fixtureRepo = join(REPO_ROOT, 'libs/papercusp/plugins', slug);

    const res = await installPluginFromCupboardCore(
      { githubUrl: `https://github.com/papercupai/${slug}` },
      makeDeps(),
    );

    expect(res.triggerPack).toMatchObject({
      targetCount: 1,
      bindingCount,
      edgeCount: 0,
      sourceKinds: [...sourceKinds],
      planTargets: [{ path: 'plan.md', slug }],
      armed: false,
    });
    expect(existsSync(join(res.installedTo, 'plan.md'))).toBe(true);
    // Installing a starter pack must never grant a capability; these declare none.
    expect(granted.flatMap((g) => g.capabilities)).toEqual([]);
  });

  // P-025. The per-PLATFORM packs, which invert the P-026 shape above: each
  // binds exactly ONE platform, across several of that platform's events.
  //
  // NOTE WHAT IS AND IS NOT ASSERTED HERE. `bindingCount` is compared against
  // the manifest read off disk rather than a literal typed into this table.
  // That is not tautological — the two are different subjects: this checks that
  // the INSTALLER counts what the manifest declares. Whether the manifest
  // declares the RIGHT events is a separate question, owned by
  // external-triggers/social/platform-packs.test.ts, which drives each
  // adapter's real `*EventName` function and fails on a binding no adapter can
  // emit. Restating those counts here would be a second copy of a number that
  // suite already pins.
  it.each(['bluesky', 'mastodon', 'reddit', 'youtube', 'facebook-pages', 'instagram', 'threads'] as const)(
    'installs the shipped social-%s platform pack through the real validation path',
    async (platform) => {
      const slug = `social-${platform}`;
      fixtureRepo = join(REPO_ROOT, 'libs/papercusp/plugins', slug);
      const manifest = JSON.parse(
        await fs.readFile(join(fixtureRepo, 'papercusp.json'), 'utf8'),
      ) as { triggerPack: { bindings: unknown[] } };

      const res = await installPluginFromCupboardCore(
        { githubUrl: `https://github.com/papercupai/${slug}` },
        makeDeps(),
      );

      expect(res.triggerPack).toMatchObject({
        targetCount: 1,
        bindingCount: manifest.triggerPack.bindings.length,
        edgeCount: 0,
        sourceKinds: [platform],
        planTargets: [{ path: 'plan.md', slug }],
        armed: false,
      });
      expect(existsSync(join(res.installedTo, 'plan.md'))).toBe(true);
      expect(granted.flatMap((g) => g.capabilities)).toEqual([]);
    },
  );

  it('refuses an invalid trigger pack before replacing the install target', async () => {
    await writeManifest(fixtureRepo, {
      name: 'broken-trigger-pack',
      version: '0.1.0',
      triggerPack: {
        inputs: { type: 'object', properties: {} },
        targets: [{
          id: 'missing-plan',
          kind: 'plan',
          path: 'missing.md',
          inputSchema: { type: 'object' },
        }],
        bindings: [{
          id: 'gmail-to-missing-plan',
          source: { kind: 'external', sourceKind: 'gmail' },
          target: 'missing-plan',
          eventPattern: 'ext:gmail:message.received',
          mapping: { mode: 'payload-context' },
        }],
        edges: [],
      },
    });
    await expect(
      installPluginFromCupboardCore(
        { githubUrl: 'https://github.com/acme/broken-trigger-pack' },
        makeDeps(),
      ),
    ).rejects.toMatchObject({ status: 422 });
    expect(existsSync(join(globalDir, 'broken-trigger-pack'))).toBe(false);
    expect(invalidated).toBe(0);
  });

  it('locates the plugin in the listing_ref subdir when the repo hosts several', async () => {
    await writeManifest(join(fixtureRepo, 'packages', 'b'), { name: 'plugin-b', version: '0.1.0' });
    const res = await installPluginFromCupboardCore(
      { githubUrl: 'https://github.com/acme/monorepo', listingRef: 'packages/b' },
      makeDeps(),
    );
    expect(res.name).toBe('plugin-b');
    expect(existsSync(join(globalDir, 'plugin-b', 'papercusp.json'))).toBe(true);
  });

  it('records install-consent grants when a harness + acceptCapabilities are given', async () => {
    await writeManifest(fixtureRepo, { name: 'p', version: '2.0.0', capabilities: ['net:fetch', 'secret:read'] });
    const res = await installPluginFromCupboardCore(
      { githubUrl: 'https://github.com/acme/p', harness: 'myharness', acceptCapabilities: true },
      makeDeps(),
    );
    expect(res.granted).toEqual(['net:fetch', 'secret:read']);
    expect(granted).toHaveLength(1);
    expect(granted[0]).toMatchObject({
      pluginName: 'p',
      pluginVersion: '2.0.0',
      harnessSlug: 'myharness',
      capabilities: ['net:fetch', 'secret:read'],
    });
  });

  it('does not grant when acceptCapabilities is false even with a harness', async () => {
    await writeManifest(fixtureRepo, { name: 'p', version: '2.0.0', capabilities: ['net:fetch'] });
    const res = await installPluginFromCupboardCore(
      { githubUrl: 'https://github.com/acme/p', harness: 'myharness', acceptCapabilities: false },
      makeDeps(),
    );
    expect(res.granted).toEqual([]);
    expect(granted).toHaveLength(0);
  });

  it('returns stable pre-write review material and refuses a changed consent receipt', async () => {
    await writeManifest(fixtureRepo, {
      name: 'reviewed-provider',
      version: '2.0.0',
      kind: 'plugin',
      capabilities: ['secret:read', 'net:fetch', 'net:fetch'],
      dependencies: {
        tools: ['crm.lookup'],
        plugins: ['audit-log'],
        events: [{ family: 'crm:updated', optional: true }],
      },
    });
    const first = await installPluginFromCupboardCore(
      { githubUrl: 'https://github.com/acme/reviewed-provider' },
      makeDeps({
        validateDependencies: async () => ({
          ok: true,
          missing: { tools: [], packs: [], plugins: [], events: [] },
          installable: { tools: [], packs: [], plugins: ['audit-log'], events: [] },
          messages: [],
        }),
      }),
    );
    expect(first.review).toEqual({
      name: 'reviewed-provider',
      version: '2.0.0',
      kind: 'plugin',
      capabilities: ['net:fetch', 'secret:read'],
      dependencies: {
        tools: ['crm.lookup'],
        packs: [],
        plugins: ['audit-log'],
        events: [{ family: 'crm:updated', optional: true }],
      },
    });

    await writeManifest(fixtureRepo, {
      name: 'reviewed-provider',
      version: '2.0.0',
      kind: 'plugin',
      capabilities: ['net:fetch', 'secret:read', 'shell:exec'],
      dependencies: { tools: ['crm.lookup'], plugins: ['audit-log'] },
    });
    await expect(installPluginFromCupboardCore(
      {
        githubUrl: 'https://github.com/acme/reviewed-provider',
        expectedReview: first.review,
      },
      makeDeps({
        validateDependencies: async () => ({
          ok: true,
          missing: { tools: [], packs: [], plugins: [], events: [] },
          installable: { tools: [], packs: [], plugins: ['audit-log'], events: [] },
          messages: [],
        }),
      }),
    )).rejects.toMatchObject({ status: 409 });
  });

  it('rejects a non-github URL (400)', async () => {
    await expect(
      installPluginFromCupboardCore({ githubUrl: 'https://evil.example.com/x' }, makeDeps()),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('fails (422) when the repo has no papercusp.json', async () => {
    // fixtureRepo only has the .git fixture, no manifest at root.
    await expect(
      installPluginFromCupboardCore({ githubUrl: 'https://github.com/acme/empty' }, makeDeps()),
    ).rejects.toBeInstanceOf(InstallPluginError);
  });

  it('rejects a path-traversing manifest name (400) and writes nothing outside global-plugins', async () => {
    // Untrusted manifest.name from the cloned repo must never escape the install
    // dir (security review: name "../evil" → fs.rm(target,{recursive}) outside).
    await writeManifest(fixtureRepo, { name: '../evil', version: '1.0.0' });
    await expect(
      installPluginFromCupboardCore({ githubUrl: 'https://github.com/acme/evil' }, makeDeps()),
    ).rejects.toMatchObject({ status: 400 });
    // The escape target would be join(globalDir, '../evil') === join(root, 'evil').
    expect(existsSync(join(root, 'evil'))).toBe(false);
  });

  it('installs a SCOPED @scope/name plugin into global-plugins/@scope/name/ (the loader layout)', async () => {
    // A scoped npm-style name (e.g. @papercupai/papercusp-worker) is exactly what
    // the plugin loader recurses into (global-plugins/@scope/name/). The install
    // core must ACCEPT it, not reject it as a "path" — the fix behind the P-015
    // fresh-install acceptance (the one published plugin listing carries this name).
    await writeManifest(fixtureRepo, { name: '@papercupai/papercusp-worker', version: '0.3.0' });
    await fs.writeFile(join(fixtureRepo, 'index.cjs'), 'module.exports = {};', 'utf8');
    const res = await installPluginFromCupboardCore(
      { githubUrl: 'https://github.com/papercusp/papercusp-worker' },
      makeDeps(),
    );
    expect(res.ok).toBe(true);
    expect(res.name).toBe('@papercupai/papercusp-worker');
    // Lands at the nested scoped path the loader recurses into.
    const installed = join(globalDir, '@papercupai', 'papercusp-worker');
    expect(existsSync(join(installed, 'papercusp.json'))).toBe(true);
    expect(existsSync(join(installed, '.git'))).toBe(false);
  });

  it('rejects a scoped name with an unsafe segment (@a/../evil) — no escape, no write', async () => {
    await writeManifest(fixtureRepo, { name: '@a/../evil', version: '1.0.0' });
    await expect(
      installPluginFromCupboardCore({ githubUrl: 'https://github.com/acme/evil' }, makeDeps()),
    ).rejects.toMatchObject({ status: 400 });
    expect(existsSync(join(globalDir, 'evil'))).toBe(false);
    expect(existsSync(join(root, 'evil'))).toBe(false);
  });

  it('ignores an unsafe listing_ref (no escape) and falls back to the repo root', async () => {
    await writeManifest(fixtureRepo, { name: 'safe-p', version: '1.0.0' });
    const res = await installPluginFromCupboardCore(
      { githubUrl: 'https://github.com/acme/safe-p', listingRef: '../../etc' },
      makeDeps(),
    );
    // The unsafe ref is skipped; install proceeds from the repo root.
    expect(res.name).toBe('safe-p');
    expect(existsSync(join(globalDir, 'safe-p', 'papercusp.json'))).toBe(true);
    // Nothing written outside global-plugins via the traversing ref.
    expect(existsSync(join(root, 'etc'))).toBe(false);
  });

  it('cleans up the clone dir on success', async () => {
    await writeManifest(fixtureRepo, { name: 'p', version: '1.0.0' });
    await installPluginFromCupboardCore({ githubUrl: 'https://github.com/acme/p' }, makeDeps());
    const entries = await fs.readdir(root);
    // only 'remote' + 'global-plugins' remain; the clone temp dir is gone
    expect(entries.filter((e) => e.startsWith('cupboard-plugin-'))).toEqual([]);
  });

  // ── tool-distribution-granularity-2026-06-05: pack installs + the dep gate ──

  it('installs a kind=pack unit and reports kind on the result', async () => {
    await writeManifest(fixtureRepo, {
      name: 'tool-pack',
      version: '0.1.0',
      kind: 'pack',
      tools: [{ name: 'noop' }],
    });
    const res = await installPluginFromCupboardCore(
      { githubUrl: 'https://github.com/acme/tool-pack' },
      makeDeps(),
    );
    expect(res.kind).toBe('pack');
    expect(existsSync(join(globalDir, 'tool-pack', 'papercusp.json'))).toBe(true);
  });

  it('fails (422) BEFORE copying when declared dependencies are hard-missing', async () => {
    await writeManifest(fixtureRepo, {
      name: 'needy',
      version: '1.0.0',
      dependencies: { tools: ['ghost.tool'] },
    });
    await expect(
      installPluginFromCupboardCore(
        { githubUrl: 'https://github.com/acme/needy' },
        makeDeps({
          validateDependencies: async () => ({
            ok: false,
            missing: { tools: ['ghost.tool'], packs: [], plugins: [] },
            installable: { tools: [], packs: [], plugins: [] },
            messages: ['needs tool "ghost.tool" — not in the tool catalog and no Cupboard pack/plugin provides it'],
          }),
        }),
      ),
    ).rejects.toMatchObject({ status: 422 });
    expect(existsSync(join(globalDir, 'needy'))).toBe(false);
  });

  it('proceeds on installable deps and surfaces them advisorily', async () => {
    await writeManifest(fixtureRepo, {
      name: 'soft-needy',
      version: '1.0.0',
      dependencies: { plugins: ['firecrawl'] },
    });
    const res = await installPluginFromCupboardCore(
      { githubUrl: 'https://github.com/acme/soft-needy' },
      makeDeps({
        validateDependencies: async () => ({
          ok: true,
          missing: { tools: [], packs: [], plugins: [] },
          installable: { tools: [], packs: [], plugins: ['firecrawl'] },
          messages: [],
        }),
      }),
    );
    expect(res.ok).toBe(true);
    expect(res.installableDependencies).toEqual({ tools: [], packs: [], plugins: ['firecrawl'] });
  });

  it('does not gate deps when no validateDependencies dep is wired', async () => {
    await writeManifest(fixtureRepo, {
      name: 'ungated',
      version: '1.0.0',
      dependencies: { tools: ['whatever.tool'] },
    });
    const res = await installPluginFromCupboardCore(
      { githubUrl: 'https://github.com/acme/ungated' },
      makeDeps(),
    );
    expect(res.ok).toBe(true);
    expect(res.installableDependencies).toBeUndefined();
  });

  it('skips the validator entirely for a manifest with no declared deps', async () => {
    await writeManifest(fixtureRepo, { name: 'no-deps', version: '1.0.0' });
    const validateDependencies = vi.fn();
    const res = await installPluginFromCupboardCore(
      { githubUrl: 'https://github.com/acme/no-deps' },
      makeDeps({ validateDependencies }),
    );
    expect(res.ok).toBe(true);
    expect(validateDependencies).not.toHaveBeenCalled();
  });

  /* ─────────────────────────────────────────────────────────────────────
   * The EVENT axis at the REAL install gate (D-003 / P-007).
   *
   * These sit at install-plugin-core, not at the resolve-and-install core,
   * on purpose: the loop's own tests inject a fake `installUnit` that hands
   * back `declaredDeps` straight from a fixture, so they can (and did) stay
   * green while THIS file — the thing that actually reads a manifest's
   * `dependencies.events` — ignored the event axis completely. A unit's tests
   * passing is not the same as its real path working.
   * ───────────────────────────────────────────────────────────────────── */

  it('GATES a manifest whose ONLY declared dep is an event family (the events-only unit)', async () => {
    await writeManifest(fixtureRepo, {
      name: 'reactor',
      version: '1.0.0',
      dependencies: { events: [{ family: 'upstream:settled' }] },
    });
    const validateDependencies = vi.fn(
      async (_deps: Parameters<NonNullable<InstallPluginCoreDeps['validateDependencies']>>[0]) => ({
        ok: true,
        missing: { tools: [], packs: [], plugins: [], events: [] },
        installable: { tools: [], packs: [], plugins: [], events: [] },
        messages: [],
      }),
    );
    const res = await installPluginFromCupboardCore(
      { githubUrl: 'https://github.com/acme/reactor' },
      makeDeps({ validateDependencies }),
    );
    expect(res.ok).toBe(true);
    // The whole point: an events-only manifest must NOT skip the gate. If
    // `hasDeclaredDeps` ignored `events`, this validator would never be called
    // and the unit would install with its required family unprovided —
    // installed, resolving nothing, reactions silently never firing.
    expect(validateDependencies).toHaveBeenCalledTimes(1);
    expect(validateDependencies.mock.calls[0]![0]).toMatchObject({
      events: [{ family: 'upstream:settled' }],
    });
  });

  it('fails (422) BEFORE copying when a REQUIRED event family is hard-missing', async () => {
    await writeManifest(fixtureRepo, {
      name: 'event-needy',
      version: '1.0.0',
      dependencies: { events: [{ family: 'nobody:emits' }] },
    });
    await expect(
      installPluginFromCupboardCore(
        { githubUrl: 'https://github.com/acme/event-needy' },
        makeDeps({
          validateDependencies: async () => ({
            ok: false,
            missing: { tools: [], packs: [], plugins: [], events: ['nobody:emits'] },
            installable: { tools: [], packs: [], plugins: [], events: [] },
            messages: ['needs event family "nobody:emits" — nothing on this host provides it'],
          }),
        }),
      ),
    ).rejects.toMatchObject({ status: 422 });
    expect(existsSync(join(globalDir, 'event-needy'))).toBe(false);
  });

  it('surfaces an INSTALLABLE event dep advisorily — the transitive-recursion channel', async () => {
    await writeManifest(fixtureRepo, {
      name: 'soft-event-needy',
      version: '1.0.0',
      dependencies: { events: [{ family: 'canary:flipped' }] },
    });
    const res = await installPluginFromCupboardCore(
      { githubUrl: 'https://github.com/acme/soft-event-needy' },
      makeDeps({
        validateDependencies: async () => ({
          ok: true,
          missing: { tools: [], packs: [], plugins: [], events: [] },
          installable: { tools: [], packs: [], plugins: [], events: [{ family: 'canary:flipped' }] },
          messages: [],
        }),
      }),
    );
    expect(res.ok).toBe(true);
    // resolveAndInstallDeps folds this back into its working set, so the
    // Cupboard unit providing `canary:flipped` gets pulled in on the next round.
    expect(res.installableDependencies).toEqual({
      tools: [],
      packs: [],
      plugins: [],
      events: [{ family: 'canary:flipped' }],
    });
  });
});
