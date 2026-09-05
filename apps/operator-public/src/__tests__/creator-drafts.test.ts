import { describe, expect, it } from 'vitest';
import { buildApi } from '../routes/index.ts';
import { makeEnv, stubGithub } from './fake-d1.ts';

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return `sha256:${Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

function manifest(contentHash: string, size: number) {
  return {
    listing_kind: 'plugin',
    listing_ref: 'creator-demo',
    github_repository_id: 7,
    github_owner: 'alice',
    github_name: 'creator-demo',
    github_url: 'https://github.com/alice/creator-demo',
    title: 'Creator demo',
    description: 'A signed creator artifact',
    artifact: { content_hash: contentHash, size_bytes: size, content_type: 'application/octet-stream' },
  };
}

describe('authenticated creator draft lifecycle (P-007)', () => {
  it('mints a one-use upload URL, validates bytes, reviews, publishes, and yanks', async () => {
    const api = buildApi();
    const { env, store } = makeEnv({ CUPBOARD_OPERATOR_GITHUB_IDS: '2' });
    const bytes = new TextEncoder().encode('creator artifact');
    const contentHash = await sha256(bytes);
    stubGithub({ user: { id: 1, login: 'alice' } });

    const create = await api.request('/creator-drafts', {
      method: 'POST',
      headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
      body: JSON.stringify({ manifest: manifest(contentHash, bytes.byteLength) }),
    }, env);
    expect(create.status).toBe(201);
    const created = await create.json() as { id: string; state: string; upload_url: string };
    expect(created.state).toBe('draft');
    expect(created.upload_url).toContain(`/creator-drafts/${created.id}/artifact?token=`);

    const upload = await api.request(created.upload_url, { method: 'PUT', body: bytes }, env);
    expect(upload.status).toBe(200);
    expect((await upload.json() as { artifact: { content_hash: string } }).artifact.content_hash).toBe(contentHash);
    const replay = await api.request(created.upload_url, { method: 'PUT', body: bytes }, env);
    expect(replay.status).toBe(410);

    const submit = await api.request(`/creator-drafts/${created.id}/submit`, {
      method: 'POST', headers: { Authorization: 'Bearer owner' },
    }, env);
    expect(submit.status).toBe(200);

    stubGithub({ user: { id: 2, login: 'maintainer' } });
    const queue = await api.request('/admin/creator-drafts?state=submitted', {
      headers: { Authorization: 'Bearer maintainer' },
    }, env);
    expect(queue.status).toBe(200);
    expect((await queue.json() as { drafts: unknown[] }).drafts).toHaveLength(1);

    const review = await api.request(`/admin/creator-drafts/${created.id}/review`, {
      method: 'POST',
      headers: { Authorization: 'Bearer maintainer', 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'approve' }),
    }, env);
    expect(review.status).toBe(200);
    const reviewed = await review.json() as { listing_id: string; state: string };
    expect(reviewed.state).toBe('published');
    expect(store.tables.harnesses).toHaveLength(1);

    stubGithub({ user: { id: 1, login: 'alice' } });
    const yank = await api.request(`/creator-drafts/${created.id}/yank`, {
      method: 'POST', headers: { Authorization: 'Bearer owner' },
    }, env);
    expect(yank.status).toBe(200);
    expect(store.tables.harnesses[0].unlisted_at).not.toBeNull();
    expect(store.tables.harnesses[0].unlisted_reason).toContain('creator_draft:');
  });

  it('refuses a payload whose digest or size differs from the declared artifact', async () => {
    const api = buildApi();
    const { env } = makeEnv();
    const bytes = new TextEncoder().encode('good bytes');
    const declared = new TextEncoder().encode('different bytes');
    stubGithub({ user: { id: 1, login: 'alice' } });
    const create = await api.request('/creator-drafts', {
      method: 'POST',
      headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
      body: JSON.stringify({ manifest: manifest(await sha256(bytes), bytes.byteLength) }),
    }, env);
    const body = await create.json() as { upload_url: string };
    const upload = await api.request(body.upload_url, { method: 'PUT', body: declared }, env);
    expect(upload.status).toBe(400);
    expect((await upload.json() as { error: string }).error).toBe('artifact_size_mismatch');
  });
});
