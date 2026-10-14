import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import {
  jsonResponse,
  recordedHostFetch,
  runProviderConformance,
  validateProviderDescriptor,
  type HostFetch,
  type ProviderAdapter,
  type ProviderRecord,
} from '@papercusp/plugin-sdk';

const adapter = createRequire(import.meta.url)('../../../../../libs/papercusp/plugins/instagram/index.cjs').providerAdapter as ProviderAdapter;
const API = 'https://graph.facebook.com/v23.0';
const config = { igUserId: '17841400000000000', watchWindow: 2, maxMediaPages: 2 };
const at = (n: number) => `2026-10-0${n}T00:00:00+0000`;

function fake() {
  return recordedHostFetch([
    { method: 'GET', url: (u) => u.pathname === '/v23.0/17841400000000000/media', response: jsonResponse(200, { data: [{ id: 'media-1' }, { id: 'media-2' }] }) },
    { url: (u) => u.pathname === '/v23.0/media-1/comments', response: jsonResponse(200, { data: [
      { id: 'c1', timestamp: at(1), text: 'hello', username: 'avi', like_count: 3 },
      { id: 'c2', timestamp: at(2), text: 'reply', username: 'sam', parent_id: 'c1' },
    ] }) },
    { url: (u) => u.pathname === '/v23.0/media-2/comments', response: jsonResponse(200, { data: [] }) },
    { method: 'POST', url: (u) => u.pathname === '/v23.0/c1/replies', response: jsonResponse(200, { id: 'reply-1' }) },
    { method: 'POST', url: (u) => u.pathname === '/v23.0/17841400000000000/media', response: jsonResponse(200, { id: 'container-1' }) },
    { url: (u) => u.pathname === '/v23.0/container-1', response: jsonResponse(200, { status_code: 'FINISHED' }) },
    { method: 'POST', url: (u) => u.pathname === '/v23.0/17841400000000000/media_publish', response: jsonResponse(200, { id: 'media-new' }) },
    { method: 'GET', url: (u) => u.pathname === '/v23.0/c1', response: jsonResponse(200, { id: 'c1', text: 'hello', media: { id: 'media-1' } }) },
    { method: 'DELETE', url: `${API}/c1`, response: jsonResponse(200, { success: true }) },
  ]);
}

async function drain(fetch: HostFetch, cursor: string | null = null) {
  const records: ProviderRecord[] = [];
  for (let n = 0; n < 10; n += 1) {
    const page = await adapter.syncPage({ source: 'instagram-source', cursor, mode: cursor ? 'incremental' : 'backfill', config }, { fetch });
    records.push(...page.records); cursor = page.nextCursor;
    if (!page.hasMore) return { records, cursor };
  }
  throw new Error('Instagram package did not finish');
}

describe('Instagram provider package (P-028)', () => {
  it('validates the descriptor and declares the media-primary capabilities', async () => {
    const descriptor = await adapter.describe();
    expect(validateProviderDescriptor(descriptor)).toEqual([]);
    expect(descriptor.capabilities).toEqual(['social.post', 'social.reply', 'social.delete']);
    expect(descriptor.oauth?.clientRegistrationRef).toBe('facebook');
  });

  it('maps comments and nested replies through the installed package', async () => {
    const result = await drain(fake().fetch);
    expect(result.records.map((r) => [r.nativeId, r.event])).toEqual([['c1', 'comment'], ['c2', 'reply']]);
    expect(result.records[0]?.payload).toMatchObject({ platform: 'instagram', kind: 'comment', subjectId: 'media-1', likeCount: 3 });
    expect(result.records[1]?.payload).toMatchObject({ platform: 'instagram', kind: 'reply', subjectId: 'media-1' });
    expect(result.records[1]?.payload.replyToId).toBe('c1');
  });

  it('resumes without replaying a completed media window', async () => {
    const world = fake();
    const first = await drain(world.fetch);
    expect((await drain(world.fetch, first.cursor)).records).toEqual([]);
  });

  it('passes the shared provider conformance kit for all declared writes', async () => {
    const report = await runProviderConformance({
      adapter, source: 'instagram-source', config, createFetch: () => fake().fetch,
      invocations: [
        { capability: 'social.post', args: { destination: config.igUserId, text: 'caption', media: [{ type: 'image', url: 'https://cdn.example/image.jpg' }] } },
        { capability: 'social.reply', args: { target: { objectId: 'c1' }, text: 'reply' } },
        { capability: 'social.delete', args: { externalId: 'c1' } },
      ],
      validatePayload: (_datatype, payload) => typeof payload.id === 'string' && typeof payload.text === 'string' ? null : 'id/text missing',
    });
    expect(report.failures.map((failure) => `${failure.check}: ${failure.detail}`)).toEqual([]);
  });

  it('refuses a text-only post before host.fetch', async () => {
    let calls = 0;
    await expect(adapter.invoke({ source: 's', config, capability: 'social.post', args: { destination: config.igUserId, text: 'caption' } }, { fetch: async () => { calls += 1; return jsonResponse(200, {}); } })).rejects.toThrow('media_required');
    expect(calls).toBe(0);
  });

  it('keeps Graph faults classified and never retries them', async () => {
    let calls = 0;
    await expect(adapter.syncPage({ source: 's', cursor: null, mode: 'backfill', config }, { fetch: async () => { calls += 1; return jsonResponse(429, { error: { code: 80002 } }); } })).rejects.toMatchObject({ kind: 'rate-limited' });
    expect(calls).toBe(1);
  });

  it('does not commit a full capped comment window that lost the watermark', async () => {
    const first = await drain(fake().fetch);
    const fetch: HostFetch = async ({ request }) => new URL(request.url).pathname.endsWith('/media')
      ? jsonResponse(200, { data: [{ id: 'media-1' }] })
      : jsonResponse(200, { data: Array.from({ length: 50 }, (_, n) => ({ id: `new-${n}`, text: 'new', timestamp: at(3) })) });
    await expect(drain(fetch, first.cursor)).rejects.toMatchObject({ kind: 'transient', lossRisk: { kind: 'capped-window-overflow', mediaId: 'media-1' } });
  });

  it('keeps timestamp boundary ids, captionless replies and partial-page resume lossless', async () => {
    const first = await drain(fake().fetch);
    const fetch: HostFetch = async ({ request }) => new URL(request.url).pathname.endsWith('/media')
      ? jsonResponse(200, { data: [{ id: 'media-1' }] })
      : jsonResponse(200, { data: [{ id: 'c2', timestamp: at(2), text: 'old', parent_id: 'c1' }, { id: 'c3', timestamp: at(2), text: null, replies: { data: [{ id: 'r3', timestamp: at(3), text: 'reply' }] } }] });
    const result = await drain(fetch, first.cursor);
    expect(result.records.map((r) => r.nativeId)).toEqual(['c3', 'r3']);
    expect(result.records[0]?.payload).toMatchObject({ text: '', textAbsent: true });
    expect(result.records[1]?.payload.replyToId).toBe('c3');
    const page = await adapter.syncPage({ source: 's', cursor: null, mode: 'backfill', config }, fake());
    expect((await drain(fake().fetch, page.nextCursor)).records).toHaveLength(2);
  });

  it('a newer nested reply does not move the top-level comment watermark', async () => {
    const world = (withNew: boolean): HostFetch => async ({ request }) => new URL(request.url).pathname.endsWith('/media')
      ? jsonResponse(200, { data: [{ id: 'media-1' }] })
      : jsonResponse(200, { data: [
        { id: 'top-1', timestamp: at(1), text: 'old', replies: { data: [{ id: 'reply-1', timestamp: at(4), text: 'newer reply' }] } },
        ...(withNew ? [{ id: 'top-2', timestamp: at(2), text: 'later top-level comment' }] : []),
      ] });
    const first = await drain(world(false));
    expect((await drain(world(true), first.cursor)).records.map((r) => r.nativeId)).toEqual(['top-2']);
  });

  it('refuses malformed cursors, unsafe paging, hidden replies and unsupported media before writing', async () => {
    await expect(drain(fake().fetch, 'broken')).rejects.toMatchObject({ kind: 'cursor-expired' });
    await expect(drain(async () => jsonResponse(200, { data: [], paging: { next: 'https://evil.example/x?after=token' } }))).rejects.toThrow('paging_outside_resource');
    for (const args of [
      { target: { objectId: 'c1', hidden: true }, text: 'reply' },
      { target: { objectId: 'c1', platform: 'facebook-pages' }, text: 'reply' },
    ]) {
      const world = fake();
      await expect(adapter.invoke({ source: 's', config, capability: 'social.reply', args }, world)).rejects.toThrow();
      expect(world.calls).toEqual([]);
    }
    const world = fake();
    await expect(adapter.invoke({ source: 's', config, capability: 'social.post', args: { destination: config.igUserId, media: [{ type: 'image', url: 'https://cdn.example/a.jpg' }, { type: 'image', url: 'https://cdn.example/b.jpg' }] } }, world)).rejects.toThrow('carousel_unsupported');
    expect(world.calls).toEqual([]);
  });

  it('polls container readiness once per minute without recreating or republishing', async () => {
    vi.useFakeTimers();
    try {
      const world = fake(); let probes = 0;
      const fetch: HostFetch = async (input) => new URL(input.request.url).pathname === '/v23.0/container-1'
        ? jsonResponse(200, { status_code: ++probes === 1 ? 'IN_PROGRESS' : 'FINISHED' })
        : world.fetch(input);
      const pending = adapter.invoke({ source: 's', config, capability: 'social.post', args: { destination: config.igUserId, text: 'caption', media: [{ type: 'image', url: 'https://cdn.example/a.jpg' }] } }, { fetch });
      await vi.advanceTimersByTimeAsync(59_999);
      expect(probes).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toEqual({ externalId: 'media-new' });
      expect(probes).toBe(2);
      expect(world.calls.filter((c) => c.request.method === 'POST')).toHaveLength(2);
    } finally { vi.useRealTimers(); }
  });

  it('reports the measured status after an ambiguous publish without retrying or inventing a permalink', async () => {
    for (const afterStatus of ['PUBLISHED', 'FINISHED', 'IN_PROGRESS']) {
      const world = fake(); let probes = 0; let publishes = 0;
      const fetch: HostFetch = async (input) => {
        const path = new URL(input.request.url).pathname;
        if (path.endsWith('/media_publish')) { publishes++; return jsonResponse(503, {}); }
        if (path.endsWith('/container-1')) return jsonResponse(200, { status_code: ++probes === 1 ? 'FINISHED' : afterStatus });
        return world.fetch(input);
      };
      await expect(adapter.invoke({ source: 's', config, capability: 'social.post', args: { destination: config.igUserId, text: 'caption', media: [{ type: 'image', url: 'https://cdn.example/a.jpg' }] } }, { fetch })).rejects.toMatchObject({ observedStatus: afterStatus, retrySafe: afterStatus === 'FINISHED' ? true : afterStatus === 'PUBLISHED' ? false : null });
      expect(publishes).toBe(1);
    }
  });

  it('refuses deletion when the supplied id is not confirmed as a comment', async () => {
    const calls: string[] = [];
    await expect(adapter.invoke({ source: 's', config, capability: 'social.delete', args: { externalId: 'media-1' } }, { fetch: async ({ request }) => { calls.push(request.method!); return jsonResponse(200, { id: 'media-1' }); } })).rejects.toThrow('delete_requires_comment_object');
    expect(calls).toEqual(['GET']);
  });
});
