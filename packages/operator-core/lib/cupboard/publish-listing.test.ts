/**
 * Shared Cupboard listing-publish core (revive-cupboard-distribution P1/P2).
 * gh-token + attestation + resolveCupboardBaseUrl are mocked; fetch is mocked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../identity/gh-token', () => ({
  getGhAuthToken: vi.fn(async () => ({ kind: 'ok', token: 'gh-test' })),
}));
vi.mock('./base-url', () => ({
  resolveCupboardBaseUrl: () => 'https://cupboard.test',
}));
vi.mock('./publisher-attestation', () => ({
  resolvePublisherAttestation: vi.fn(async () => null),
}));

import { publishListingToCupboard } from './publish-listing';
import * as ghToken from '../identity/gh-token';
import * as cupboardPublish from './publisher-attestation';

const baseInput = {
  listing_kind: 'plugin' as const,
  listing_ref: 'my-plugin',
  github_repository_id: 7,
  github_owner: 'acme',
  github_name: 'my-plugin',
  github_url: 'https://github.com/acme/my-plugin',
  title: 'My Plugin',
};

const originalFetch = global.fetch;
const fetchMock = vi.fn();

beforeEach(() => {
  vi.mocked(ghToken.getGhAuthToken).mockResolvedValue({ kind: 'ok', token: 'gh-test' } as any);
  vi.mocked(cupboardPublish.resolvePublisherAttestation).mockResolvedValue(null);
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true, id: 'listing-1' }), { status: 200 }));
  global.fetch = fetchMock as unknown as typeof fetch;
});
afterEach(() => { global.fetch = originalFetch; });

describe('publishListingToCupboard', () => {
  it('returns 401 when gh auth is unavailable', async () => {
    vi.mocked(ghToken.getGhAuthToken).mockResolvedValue({ kind: 'gh_auth_required', error: { kind: 'no_token' } } as any);
    const r = await publishListingToCupboard(baseInput);
    expect(r).toMatchObject({ ok: false, status: 401, error: 'gh_auth_required' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('POSTs /listings with the bearer token and returns the parsed data', async () => {
    const r = await publishListingToCupboard(baseInput);
    expect(r.ok).toBe(true);
    expect((r as { data: { id: string } }).data.id).toBe('listing-1');
    const [url, opts] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://cupboard.test/listings');
    expect(opts.method).toBe('POST');
    expect(opts.headers.Authorization).toBe('Bearer gh-test');
    const body = JSON.parse(opts.body as string);
    expect(body.listing_kind).toBe('plugin');
    expect(body.listing_ref).toBe('my-plugin');
  });

  it('attaches the publisher attestation when available', async () => {
    vi.mocked(cupboardPublish.resolvePublisherAttestation).mockResolvedValue({
      attestation_gist_id: 'gist1',
      publisher_device_pubkey: 'pk1',
    } as any);
    await publishListingToCupboard(baseInput);
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.attestation_gist_id).toBe('gist1');
    expect(body.publisher_device_pubkey).toBe('pk1');
  });

  it('surfaces a non-2xx upstream as cupboard_error', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'invalid_field' }), { status: 400 }));
    const r = await publishListingToCupboard(baseInput);
    expect(r).toMatchObject({ ok: false, status: 400, error: 'cupboard_error' });
  });

  it('returns cupboard_unreachable when the fetch throws', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const r = await publishListingToCupboard(baseInput);
    expect(r).toMatchObject({ ok: false, status: 502, error: 'cupboard_unreachable' });
  });

  it('passes provides_tools through to the wire body for a pack listing (migration 006)', async () => {
    const r = await publishListingToCupboard({
      ...baseInput,
      listing_kind: 'pack',
      listing_ref: 'markdown-tools',
      provides_tools: ['md.render', 'md.lint'],
    });
    expect(r.ok).toBe(true);
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.listing_kind).toBe('pack');
    expect(body.provides_tools).toEqual(['md.render', 'md.lint']);
  });

  it('falls back to /harnesses on a 404 only for kind=harness', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('not found', { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, id: 'h1' }), { status: 200 }));
    const r = await publishListingToCupboard({ ...baseInput, listing_kind: 'harness', topic_hex: 'a'.repeat(64) });
    expect(r.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]![0]).toBe('https://cupboard.test/harnesses');
  });
});
