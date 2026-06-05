/**
 * Cupboard publish proxy — pure-logic + validation tests.
 *
 * Handler-level integration (gh-token + upstream fetch) is covered
 * by the broader operator e2e suite; here we focus on the
 * validator + url resolver which are the pieces most likely to
 * regress and are pure functions.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  resolveCupboardBaseUrl,
  resolvePublisherAttestation,
  validatePublishInput,
  type AttestationDeps,
} from '../cupboard-publish';

const ORIGINAL_ENV = process.env.PAPERCUSP_CUPBOARD_URL;
beforeEach(() => { delete process.env.PAPERCUSP_CUPBOARD_URL; });
afterEach(() => {
  if (ORIGINAL_ENV !== undefined) process.env.PAPERCUSP_CUPBOARD_URL = ORIGINAL_ENV;
  else delete process.env.PAPERCUSP_CUPBOARD_URL;
});

describe('resolveCupboardBaseUrl', () => {
  it('defaults to the canonical host when no env var', () => {
    expect(resolveCupboardBaseUrl()).toBe('https://cupboard.papercusp.com');
  });

  it('uses PAPERCUSP_CUPBOARD_URL when set', () => {
    process.env.PAPERCUSP_CUPBOARD_URL = 'https://cupboard.example.com';
    expect(resolveCupboardBaseUrl()).toBe('https://cupboard.example.com');
  });

  it('strips trailing slashes', () => {
    process.env.PAPERCUSP_CUPBOARD_URL = 'https://cupboard.example.com/';
    expect(resolveCupboardBaseUrl()).toBe('https://cupboard.example.com');
  });

  it('falls back to default on blank env var', () => {
    process.env.PAPERCUSP_CUPBOARD_URL = '   ';
    expect(resolveCupboardBaseUrl()).toBe('https://cupboard.papercusp.com');
  });
});

describe('validatePublishInput', () => {
  function valid() {
    return {
      github_repository_id: 12345,
      github_owner: 'alice',
      github_name: 'cool',
      github_url: 'https://github.com/alice/cool',
      title: 'Cool',
      description: 'A cool harness',
      topic_hex: 'a'.repeat(64),
    };
  }

  it('accepts a fully-valid input', () => {
    const r = validatePublishInput(valid());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.input.github_repository_id).toBe(12345);
      expect(r.input.title).toBe('Cool');
    }
  });

  it('accepts input without optional title/description', () => {
    const v = valid();
    delete (v as Record<string, unknown>).title;
    delete (v as Record<string, unknown>).description;
    const r = validatePublishInput(v);
    expect(r.ok).toBe(true);
  });

  it('rejects non-object input', () => {
    expect(validatePublishInput(null).ok).toBe(false);
    expect(validatePublishInput('str').ok).toBe(false);
    expect(validatePublishInput(42).ok).toBe(false);
  });

  it('rejects non-integer github_repository_id', () => {
    const r = validatePublishInput({ ...valid(), github_repository_id: 12.5 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe('github_repository_id');
  });

  it('rejects zero / negative github_repository_id', () => {
    expect(validatePublishInput({ ...valid(), github_repository_id: 0 }).ok).toBe(false);
    expect(validatePublishInput({ ...valid(), github_repository_id: -5 }).ok).toBe(false);
  });

  it('rejects empty github_owner', () => {
    const r = validatePublishInput({ ...valid(), github_owner: '' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe('github_owner');
  });

  it('rejects empty github_name', () => {
    const r = validatePublishInput({ ...valid(), github_name: '' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe('github_name');
  });

  it('rejects non-github_url', () => {
    expect(validatePublishInput({ ...valid(), github_url: 'http://example.com/x/y' }).ok).toBe(false);
    expect(validatePublishInput({ ...valid(), github_url: 'https://gitlab.com/x/y' }).ok).toBe(false);
    expect(validatePublishInput({ ...valid(), github_url: 'not a url' }).ok).toBe(false);
  });

  it('rejects malformed topic_hex (length / chars)', () => {
    expect(validatePublishInput({ ...valid(), topic_hex: 'too-short' }).ok).toBe(false);
    expect(validatePublishInput({ ...valid(), topic_hex: 'A'.repeat(64) }).ok).toBe(false); // uppercase
    expect(validatePublishInput({ ...valid(), topic_hex: 'g'.repeat(64) }).ok).toBe(false); // non-hex char
  });

  it('rejects too-long title (>200) / description (>280)', () => {
    expect(validatePublishInput({ ...valid(), title: 'x'.repeat(201) }).ok).toBe(false);
    expect(validatePublishInput({ ...valid(), description: 'x'.repeat(281) }).ok).toBe(false);
  });

  it('accepts boundary lengths (200 / 280)', () => {
    expect(validatePublishInput({ ...valid(), title: 'x'.repeat(200) }).ok).toBe(true);
    expect(validatePublishInput({ ...valid(), description: 'x'.repeat(280) }).ok).toBe(true);
  });

  // ── listing_kind (migration 004 / D-005) ──
  it('defaults to listing_kind=harness when omitted', () => {
    const r = validatePublishInput(valid());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.input.listing_kind).toBe('harness');
  });

  it('rejects an unknown listing_kind', () => {
    const r = validatePublishInput({ ...valid(), listing_kind: 'widget' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe('listing_kind');
  });

  it('a blueprint requires listing_ref', () => {
    const v = valid();
    delete (v as Record<string, unknown>).topic_hex;
    const r = validatePublishInput({ ...v, listing_kind: 'blueprint' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe('listing_ref');
  });

  it('a blueprint publishes WITHOUT topic_hex when listing_ref is present', () => {
    const v = valid();
    delete (v as Record<string, unknown>).topic_hex;
    const r = validatePublishInput({ ...v, listing_kind: 'blueprint', listing_ref: 'web-app', project_ref: 'papercupai/demo' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.input.listing_kind).toBe('blueprint');
      expect(r.input.listing_ref).toBe('web-app');
      expect(r.input.project_ref).toBe('papercupai/demo');
      expect(r.input.topic_hex).toBeUndefined();
    }
  });

  it('a plugin publishes with a slug listing_ref', () => {
    const v = valid();
    delete (v as Record<string, unknown>).topic_hex;
    const r = validatePublishInput({ ...v, listing_kind: 'plugin', listing_ref: 'slack-notify' });
    expect(r.ok).toBe(true);
  });

  it('rejects an over-long project_ref', () => {
    const r = validatePublishInput({ ...valid(), project_ref: 'x'.repeat(301) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe('project_ref');
  });
});

describe('resolvePublisherAttestation (item 1)', () => {
  function deps(over: Partial<AttestationDeps> = {}): Partial<AttestationDeps> {
    return {
      resolveIdentity: async () => ({ kind: 'ok', githubUserId: 1, githubLogin: 'alice', token: 'tok' }),
      keychainIdFor: () => 'kc-1',
      loadKeypair: async () => ({ pubkeyBase64: 'PK' }),
      ensureGist: async () => 'gist123',
      ...over,
    };
  }

  it('returns gist id + pubkey on success', async () => {
    const r = await resolvePublisherAttestation(deps());
    expect(r).toEqual({ attestation_gist_id: 'gist123', publisher_device_pubkey: 'PK' });
  });

  it('returns null when gh auth is required (best-effort skip)', async () => {
    const r = await resolvePublisherAttestation(deps({ resolveIdentity: async () => ({ kind: 'gh_auth_required' }) }));
    expect(r).toBeNull();
  });

  it('returns null when the identity lacks a token', async () => {
    const r = await resolvePublisherAttestation(
      deps({ resolveIdentity: async () => ({ kind: 'ok', githubUserId: 1, githubLogin: 'alice' }) }),
    );
    expect(r).toBeNull();
  });

  it('never throws — returns null when gist resolution fails', async () => {
    const r = await resolvePublisherAttestation(
      deps({ ensureGist: async () => { throw new Error('gist api down'); } }),
    );
    expect(r).toBeNull();
  });
});
