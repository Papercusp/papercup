/**
 * Cupboard generalized /listings route tests (migration 004 / D-005 / D-008).
 *
 * Covers the listing kinds (harness/blueprint/plugin/pack), the
 * project-centric 1:N model (N listings per project remote), kind filtering,
 * and kind-aware publish validation. /harnesses back-compat is in
 * harnesses.test.ts.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { buildApi } from '../routes/index.ts';
import { makeEnv, stubGithub } from './fake-d1.ts';

function publish(
  api: ReturnType<typeof buildApi>,
  env: ReturnType<typeof makeEnv>['env'],
  body: Record<string, unknown>,
) {
  return api.request('/listings', {
    method: 'POST',
    headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, env);
}

const BLUEPRINT_BASE = {
  github_owner: 'papercupai',
  github_name: 'demo-project',
  github_url: 'https://github.com/papercupai/demo-project',
  project_ref: 'papercupai/demo-project',
};

describe('Cupboard /listings — three kinds + project-centric 1:N', () => {
  let api: ReturnType<typeof buildApi>;
  beforeEach(() => {
    api = buildApi();
  });

  it('GET /listings returns empty on fresh db', async () => {
    const { env } = makeEnv();
    const res = await api.request('/listings', {}, env);
    expect(res.status).toBe(200);
    const body = await res.json() as { results: unknown[]; next_cursor: unknown };
    expect(body.results).toEqual([]);
    expect(body.next_cursor).toBe(null);
  });

  it('GET /listings?kind=bogus rejects an unknown kind', async () => {
    const { env } = makeEnv();
    const res = await api.request('/listings?kind=bogus', {}, env);
    expect(res.status).toBe(400);
    expect((await res.json() as { field: string }).field).toBe('kind');
  });

  it('POST /listings rejects an unknown listing_kind', async () => {
    const { env } = makeEnv();
    stubGithub({ user: { id: 1, login: 'alice' }, repo: { id: 7, private: false } });
    const res = await publish(api, env, { ...BLUEPRINT_BASE, github_repository_id: 7, listing_kind: 'widget', listing_ref: 'x' });
    expect(res.status).toBe(400);
    expect((await res.json() as { field: string }).field).toBe('listing_kind');
  });

  it('POST /listings blueprint requires listing_ref', async () => {
    const { env } = makeEnv();
    stubGithub({ user: { id: 1, login: 'alice' }, repo: { id: 7, private: false } });
    const res = await publish(api, env, { ...BLUEPRINT_BASE, github_repository_id: 7, listing_kind: 'blueprint' });
    expect(res.status).toBe(400);
    expect((await res.json() as { field: string }).field).toBe('listing_ref');
  });

  it('POST /listings blueprint publishes WITHOUT a topic_hex', async () => {
    const { env, store } = makeEnv();
    stubGithub({ user: { id: 5, login: 'pub' }, repo: { id: 7, private: false, permissions: { admin: true } } });
    const res = await publish(api, env, {
      ...BLUEPRINT_BASE, github_repository_id: 7, listing_kind: 'blueprint',
      listing_ref: 'web-app', title: 'Web App blueprint',
    });
    expect(res.status).toBe(200);
    const j = await res.json() as { ok: boolean; listing: Record<string, unknown> };
    expect(j.ok).toBe(true);
    expect(j.listing.listing_kind).toBe('blueprint');
    expect(j.listing.listing_ref).toBe('web-app');
    expect(j.listing.project_ref).toBe('papercupai/demo-project');
    expect(j.listing.topic_hex).toBe(null);
    expect(j.listing.publisher_permission).toBe('admin'); // trust signal applies to every kind
    expect(store.tables.harnesses).toHaveLength(1);
  });

  it('a project hosts N blueprints (1:N): two listing_refs on one repo both publish', async () => {
    const { env, store } = makeEnv();
    stubGithub({ user: { id: 5, login: 'pub' }, repo: { id: 7, private: false } });
    const a = await publish(api, env, { ...BLUEPRINT_BASE, github_repository_id: 7, listing_kind: 'blueprint', listing_ref: 'web-app' });
    const b = await publish(api, env, { ...BLUEPRINT_BASE, github_repository_id: 7, listing_kind: 'blueprint', listing_ref: 'cli-tool' });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(store.tables.harnesses).toHaveLength(2);                // NOT deduped — distinct refs
    expect((await a.json() as { id: string }).id).not.toBe((await b.json() as { id: string }).id);
  });

  it('re-publishing the same (repo, kind, ref) dedups', async () => {
    const { env, store } = makeEnv();
    stubGithub({ user: { id: 5, login: 'pub' }, repo: { id: 7, private: false } });
    const body = { ...BLUEPRINT_BASE, github_repository_id: 7, listing_kind: 'blueprint', listing_ref: 'web-app' };
    const a = await publish(api, env, body);
    const b = await publish(api, env, body);
    expect((await b.json() as { dedup: boolean }).dedup).toBe(true);
    expect(store.tables.harnesses).toHaveLength(1);
    void a;
  });

  it('POST /listings plugin publishes (install kind)', async () => {
    const { env, store } = makeEnv();
    stubGithub({ user: { id: 5, login: 'pub' }, repo: { id: 9, private: false } });
    const res = await publish(api, env, {
      github_owner: 'papercupai', github_name: 'plugins', github_url: 'https://github.com/papercupai/plugins',
      github_repository_id: 9, listing_kind: 'plugin', listing_ref: 'slack-notify', project_ref: 'papercupai/plugins',
      title: 'Slack notify plugin',
    });
    expect(res.status).toBe(200);
    expect((await res.json() as { listing: { listing_kind: string } }).listing.listing_kind).toBe('plugin');
    expect(store.tables.harnesses[0].topic_hex).toBe(null);
  });

  it('POST /listings with no kind defaults to harness and requires topic_hex', async () => {
    const { env } = makeEnv();
    stubGithub({ user: { id: 1, login: 'alice' }, repo: { id: 11, private: false } });
    const res = await publish(api, env, {
      github_owner: 'alice', github_name: 'r', github_url: 'https://github.com/alice/r',
      github_repository_id: 11,
    });
    expect(res.status).toBe(400);
    expect((await res.json() as { field: string }).field).toBe('topic_hex');
  });

  it('GET /listings?kind=blueprint filters to blueprints; bare /listings returns all kinds', async () => {
    const { env } = makeEnv();
    // Seed one of each kind directly.
    stubGithub({ user: { id: 5, login: 'pub' }, repo: { id: 20, private: false } });
    await publish(api, env, { github_owner: 'o', github_name: 'n', github_url: 'https://github.com/o/n', github_repository_id: 20, listing_kind: 'blueprint', listing_ref: 'bp1' });
    stubGithub({ user: { id: 5, login: 'pub' }, repo: { id: 21, private: false } });
    await publish(api, env, { github_owner: 'o', github_name: 'n2', github_url: 'https://github.com/o/n2', github_repository_id: 21, listing_kind: 'plugin', listing_ref: 'pl1' });
    stubGithub({ user: { id: 5, login: 'pub' }, repo: { id: 22, private: false } });
    await publish(api, env, { github_owner: 'o', github_name: 'n3', github_url: 'https://github.com/o/n3', github_repository_id: 22, topic_hex: 'a'.repeat(64) });

    const bps = await api.request('/listings?kind=blueprint', {}, env);
    const bpBody = await bps.json() as { results: Array<{ listing_kind: string }> };
    expect(bpBody.results).toHaveLength(1);
    expect(bpBody.results[0].listing_kind).toBe('blueprint');

    const all = await api.request('/listings', {}, env);
    const allBody = await all.json() as { results: unknown[] };
    expect(allBody.results).toHaveLength(3);
  });

  it('/harnesses/:id 404s for a non-harness listing; /listings/:id returns it', async () => {
    const { env, store } = makeEnv();
    stubGithub({ user: { id: 5, login: 'pub' }, repo: { id: 30, private: false } });
    const pub = await publish(api, env, { github_owner: 'o', github_name: 'n', github_url: 'https://github.com/o/n', github_repository_id: 30, listing_kind: 'blueprint', listing_ref: 'bp' });
    const id = (await pub.json() as { id: string }).id;
    void store;

    const viaHarness = await api.request(`/harnesses/${id}`, {}, env);
    expect(viaHarness.status).toBe(404);                    // kind-pinned view rejects it

    const viaListings = await api.request(`/listings/${id}`, {}, env);
    expect(viaListings.status).toBe(200);
    expect((await viaListings.json() as { listing_kind: string }).listing_kind).toBe('blueprint');
  });

  it('a blueprint publish still rejects a private project remote', async () => {
    const { env } = makeEnv();
    stubGithub({ user: { id: 5, login: 'pub' }, repo: { id: 40, private: true } });
    const res = await publish(api, env, { ...BLUEPRINT_BASE, github_repository_id: 40, listing_kind: 'blueprint', listing_ref: 'x' });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe('private_repo_rejected');
  });
});

describe('Cupboard /listings — pack kind + provides_tools (migration 006)', () => {
  let api: ReturnType<typeof buildApi>;
  beforeEach(() => {
    api = buildApi();
  });

  const PACK_BASE = {
    github_owner: 'papercupai',
    github_name: 'tool-packs',
    github_url: 'https://github.com/papercupai/tool-packs',
    project_ref: 'papercupai/tool-packs',
  };

  it('POST /listings pack publishes with provides_tools; GET returns the JSON passthrough', async () => {
    const { env } = makeEnv();
    stubGithub({ user: { id: 5, login: 'pub' }, repo: { id: 50, private: false } });
    const res = await publish(api, env, {
      ...PACK_BASE, github_repository_id: 50, listing_kind: 'pack',
      listing_ref: 'markdown-tools', title: 'Markdown tools pack',
      provides_tools: ['md.render', 'md.lint'],
    });
    expect(res.status).toBe(200);
    const j = await res.json() as { ok: boolean; id: string; listing: Record<string, unknown> };
    expect(j.ok).toBe(true);
    expect(j.listing.listing_kind).toBe('pack');
    expect(j.listing.provides_tools).toBe(JSON.stringify(['md.render', 'md.lint']));

    const got = await api.request(`/listings/${j.id}`, {}, env);
    expect(got.status).toBe(200);
    expect((await got.json() as { provides_tools: string }).provides_tools)
      .toBe(JSON.stringify(['md.render', 'md.lint']));
  });

  it('POST /listings plugin also carries provides_tools', async () => {
    const { env } = makeEnv();
    stubGithub({ user: { id: 5, login: 'pub' }, repo: { id: 51, private: false } });
    const res = await publish(api, env, {
      ...PACK_BASE, github_repository_id: 51, listing_kind: 'plugin',
      listing_ref: 'repomix', provides_tools: ['repomix.pack'],
    });
    expect(res.status).toBe(200);
    expect((await res.json() as { listing: { provides_tools: string } }).listing.provides_tools)
      .toBe(JSON.stringify(['repomix.pack']));
  });

  it('pack kind requires listing_ref like every non-harness kind', async () => {
    const { env } = makeEnv();
    stubGithub({ user: { id: 5, login: 'pub' }, repo: { id: 52, private: false } });
    const res = await publish(api, env, { ...PACK_BASE, github_repository_id: 52, listing_kind: 'pack' });
    expect(res.status).toBe(400);
    expect((await res.json() as { field: string }).field).toBe('listing_ref');
  });

  it('provides_tools is rejected on non-installable kinds', async () => {
    const { env } = makeEnv();
    stubGithub({ user: { id: 5, login: 'pub' }, repo: { id: 53, private: false } });
    const res = await publish(api, env, {
      ...PACK_BASE, github_repository_id: 53, listing_kind: 'blueprint',
      listing_ref: 'bp', provides_tools: ['x'],
    });
    expect(res.status).toBe(400);
    const j = await res.json() as { field: string; reason: string };
    expect(j.field).toBe('provides_tools');
    expect(j.reason).toBe('plugin_or_pack_kind_only');
  });

  it('provides_tools rejects bad shapes: non-array, empty array, empty strings, oversize', async () => {
    const { env } = makeEnv();
    const bad: unknown[] = [
      'not-an-array',
      [],
      [''],
      ['  '],
      [42],
      ['a'.repeat(129)],
      Array.from({ length: 201 }, (_, i) => `t${i}`),
    ];
    let userId = 100; // fresh user per publish — stay under the 5/hr per-user cap
    for (const provides_tools of bad) {
      stubGithub({ user: { id: userId++, login: 'pub' }, repo: { id: 54, private: false } });
      const res = await publish(api, env, {
        ...PACK_BASE, github_repository_id: 54, listing_kind: 'pack',
        listing_ref: 'p', provides_tools,
      });
      expect(res.status, `shape: ${JSON.stringify(provides_tools)}`).toBe(400);
      expect((await res.json() as { field: string }).field).toBe('provides_tools');
    }
  });

  it('provides_tools is optional for pack kind (nullable column)', async () => {
    const { env } = makeEnv();
    stubGithub({ user: { id: 5, login: 'pub' }, repo: { id: 55, private: false } });
    const res = await publish(api, env, {
      ...PACK_BASE, github_repository_id: 55, listing_kind: 'pack', listing_ref: 'bare',
    });
    expect(res.status).toBe(200);
    expect((await res.json() as { listing: { provides_tools: unknown } }).listing.provides_tools).toBe(null);
  });

  it('GET /listings?kind=pack filters to packs; (repo, kind, ref) dedup applies', async () => {
    const { env, store } = makeEnv();
    stubGithub({ user: { id: 5, login: 'pub' }, repo: { id: 56, private: false } });
    const body = { ...PACK_BASE, github_repository_id: 56, listing_kind: 'pack', listing_ref: 'dup', provides_tools: ['a.b'] };
    await publish(api, env, body);
    const again = await publish(api, env, body);
    expect((await again.json() as { dedup: boolean }).dedup).toBe(true);
    expect(store.tables.harnesses).toHaveLength(1);

    stubGithub({ user: { id: 5, login: 'pub' }, repo: { id: 57, private: false } });
    await publish(api, env, { ...PACK_BASE, github_name: 'other', github_url: 'https://github.com/papercupai/other', github_repository_id: 57, listing_kind: 'plugin', listing_ref: 'pl' });

    const packs = await api.request('/listings?kind=pack', {}, env);
    const packBody = await packs.json() as { results: Array<{ listing_kind: string }> };
    expect(packBody.results).toHaveLength(1);
    expect(packBody.results[0].listing_kind).toBe('pack');
  });
});

describe('Cupboard /listings — repo→Hive binding fields (migration 007 / D-004 HYBRID)', () => {
  let api: ReturnType<typeof buildApi>;
  beforeEach(() => {
    api = buildApi();
  });

  // Raw 32-byte Ed25519 pubkey, base64 (44 chars: 43 + '=') — the hive
  // directory announce encoding.
  const HIVE_PUBKEY = 'A'.repeat(43) + '=';

  const HARNESS_BASE = {
    github_owner: 'papercupai',
    github_name: 'hive-member',
    github_url: 'https://github.com/papercupai/hive-member',
    topic_hex: 'a'.repeat(64),
  };

  it('publish WITH hive fields → create response + GET lookup return them', async () => {
    const { env } = makeEnv();
    stubGithub({ user: { id: 5, login: 'pub' }, repo: { id: 70, private: false } });
    const res = await publish(api, env, {
      ...HARNESS_BASE, github_repository_id: 70,
      hive_pubkey: HIVE_PUBKEY, hive_title: 'Demo Hive',
    });
    expect(res.status).toBe(200);
    const j = await res.json() as { ok: boolean; id: string; listing: Record<string, unknown> };
    expect(j.listing.hive_pubkey).toBe(HIVE_PUBKEY);
    expect(j.listing.hive_title).toBe('Demo Hive');

    const got = await api.request(`/listings/${j.id}`, {}, env);
    const row = await got.json() as Record<string, unknown>;
    expect(row.hive_pubkey).toBe(HIVE_PUBKEY);
    expect(row.hive_title).toBe('Demo Hive');
  });

  it('publish WITHOUT hive fields → lookup returns them null (pre-hive binding)', async () => {
    const { env } = makeEnv();
    stubGithub({ user: { id: 5, login: 'pub' }, repo: { id: 71, private: false } });
    const res = await publish(api, env, { ...HARNESS_BASE, github_repository_id: 71 });
    expect(res.status).toBe(200);
    const j = await res.json() as { id: string; listing: Record<string, unknown> };
    expect(j.listing.hive_pubkey).toBe(null);
    expect(j.listing.hive_title).toBe(null);

    const binding = await api.request('/binding/71', {}, env);
    const b = await binding.json() as { exists: boolean; harness: Record<string, unknown> };
    expect(b.exists).toBe(true);
    expect(b.harness.hive_pubkey).toBe(null);
    expect(b.harness.hive_title).toBe(null);
  });

  it('one row per member repo, same hive_pubkey: any member repo lookup finds the hive', async () => {
    const { env, store } = makeEnv();
    stubGithub({ user: { id: 5, login: 'pub' }, repo: { id: 72, private: false } });
    await publish(api, env, {
      ...HARNESS_BASE, github_repository_id: 72,
      hive_pubkey: HIVE_PUBKEY, hive_title: 'Demo Hive',
    });
    stubGithub({ user: { id: 5, login: 'pub' }, repo: { id: 73, private: false } });
    await publish(api, env, {
      ...HARNESS_BASE, github_name: 'hive-member-2',
      github_url: 'https://github.com/papercupai/hive-member-2',
      github_repository_id: 73, topic_hex: 'b'.repeat(64),
      hive_pubkey: HIVE_PUBKEY, hive_title: 'Demo Hive',
    });
    expect(store.tables.harnesses).toHaveLength(2);

    for (const repoId of [72, 73]) {
      const res = await api.request(`/binding/${repoId}`, {}, env);
      const b = await res.json() as { exists: boolean; harness: Record<string, unknown> };
      expect(b.exists).toBe(true);
      expect(b.harness.hive_pubkey).toBe(HIVE_PUBKEY);
      expect(b.harness.hive_title).toBe('Demo Hive');
    }
  });

  it('rejects a malformed hive_pubkey (not 32-byte base64)', async () => {
    const { env } = makeEnv();
    const bad = ['nope', 'a'.repeat(64), HIVE_PUBKEY + '=', 'A'.repeat(44), 42, ''];
    let userId = 200; // fresh user per publish — stay under the 5/hr cap
    for (const hive_pubkey of bad) {
      stubGithub({ user: { id: userId++, login: 'pub' }, repo: { id: 74, private: false } });
      const res = await publish(api, env, { ...HARNESS_BASE, github_repository_id: 74, hive_pubkey });
      expect(res.status, `pubkey: ${JSON.stringify(hive_pubkey)}`).toBe(400);
      expect((await res.json() as { field: string }).field).toBe('hive_pubkey');
    }
  });

  it('rejects hive_title without hive_pubkey (display sugar needs an identity)', async () => {
    const { env } = makeEnv();
    stubGithub({ user: { id: 5, login: 'pub' }, repo: { id: 75, private: false } });
    const res = await publish(api, env, { ...HARNESS_BASE, github_repository_id: 75, hive_title: 'Orphan' });
    expect(res.status).toBe(400);
    const j = await res.json() as { field: string; reason: string };
    expect(j.field).toBe('hive_title');
    expect(j.reason).toBe('requires_hive_pubkey');
  });

  it('rejects an over-long or non-string hive_title', async () => {
    const { env } = makeEnv();
    let userId = 300;
    for (const hive_title of ['x'.repeat(201), 42, '']) {
      stubGithub({ user: { id: userId++, login: 'pub' }, repo: { id: 76, private: false } });
      const res = await publish(api, env, {
        ...HARNESS_BASE, github_repository_id: 76, hive_pubkey: HIVE_PUBKEY, hive_title,
      });
      expect(res.status, `title: ${JSON.stringify(hive_title)}`).toBe(400);
      expect((await res.json() as { field: string }).field).toBe('hive_title');
    }
  });

  it('hive_pubkey alone (no title) is accepted', async () => {
    const { env } = makeEnv();
    stubGithub({ user: { id: 5, login: 'pub' }, repo: { id: 77, private: false } });
    const res = await publish(api, env, { ...HARNESS_BASE, github_repository_id: 77, hive_pubkey: HIVE_PUBKEY });
    expect(res.status).toBe(200);
    const j = await res.json() as { listing: Record<string, unknown> };
    expect(j.listing.hive_pubkey).toBe(HIVE_PUBKEY);
    expect(j.listing.hive_title).toBe(null);
  });

  it('non-harness kinds carry hive fields too (a Hive facet listing)', async () => {
    const { env } = makeEnv();
    stubGithub({ user: { id: 5, login: 'pub' }, repo: { id: 78, private: false } });
    const res = await publish(api, env, {
      github_owner: 'papercupai', github_name: 'hive-member',
      github_url: 'https://github.com/papercupai/hive-member',
      github_repository_id: 78, listing_kind: 'blueprint', listing_ref: 'web-app',
      hive_pubkey: HIVE_PUBKEY, hive_title: 'Demo Hive',
    });
    expect(res.status).toBe(200);
    const j = await res.json() as { listing: Record<string, unknown> };
    expect(j.listing.listing_kind).toBe('blueprint');
    expect(j.listing.hive_pubkey).toBe(HIVE_PUBKEY);
  });
});
