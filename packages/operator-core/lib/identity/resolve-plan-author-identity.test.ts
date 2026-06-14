import { describe, it, expect } from 'vitest';
import {
  buildIdentityIndex,
  mapAuthorToIdentity,
  emailLocalPart,
  agentLabel,
  shortPubkey,
  isUuid,
  planAuthorKey,
  type IdentityIndex,
} from './resolve-plan-author-identity';
import type { DeviceAttestationEntry } from '../harness/contributor-row-types';

function att(device_pubkey: string): DeviceAttestationEntry {
  return {
    device_pubkey,
    gist_id: 'g',
    gist_url: 'u',
    device_label: 'laptop',
    created_at: 1,
    signature_by_device: 'sig',
  };
}

const MEMBERS = [
  {
    githubUserId: 42,
    githubUsername: 'aviynw2',
    displayName: 'Avi',
    avatarUrl: 'https://avatars/42.png',
    deviceAttestations: [att('pk-avi-laptop'), att('pk-avi-desktop')],
  },
  {
    githubUserId: 7,
    githubUsername: 'octocat',
    displayName: null,
    avatarUrl: 'https://avatars/7.png',
    deviceAttestations: [att('pk-octo')],
  },
];

const USERS = [{ id: '11111111-1111-1111-1111-111111111111', username: 'localadmin', displayName: 'Local Admin' }];

function idx(): IdentityIndex {
  return buildIdentityIndex(MEMBERS, USERS);
}

describe('pure helpers', () => {
  it('emailLocalPart strips the domain', () => {
    expect(emailLocalPart('aviynw2@gmail.com')).toBe('aviynw2');
    expect(emailLocalPart('noатsign')).toBe('noатsign');
  });
  it('agentLabel keeps the first two dash chunks', () => {
    expect(agentLabel('su-88991fc5-dd92-4436')).toBe('su-88991fc5');
    expect(agentLabel('solo')).toBe('solo');
  });
  it('shortPubkey truncates long keys', () => {
    expect(shortPubkey('pk-1234567890abcdef')).toBe('pk-12345…');
    expect(shortPubkey('short')).toBe('short');
  });
  it('isUuid recognizes uuids only', () => {
    expect(isUuid('11111111-1111-1111-1111-111111111111')).toBe(true);
    expect(isUuid('su-88991')).toBe(false);
  });
  it('planAuthorKey composes the dedupe key', () => {
    expect(planAuthorKey('email', 'a@b.com')).toBe('email:a@b.com');
  });
});

describe('buildIdentityIndex', () => {
  it('indexes by username (lowercased) and device pubkey', () => {
    const i = idx();
    expect(i.byUsername.get('aviynw2')?.githubUserId).toBe(42);
    expect(i.byUsername.get('octocat')?.avatarUrl).toBe('https://avatars/7.png');
    expect(i.byDevicePubkey.get('pk-avi-desktop')?.githubUsername).toBe('aviynw2');
    expect(i.byUserId.get('11111111-1111-1111-1111-111111111111')?.username).toBe('localadmin');
  });
  it('dedupes by github_user_id, preferring a row with an avatar', () => {
    const i = buildIdentityIndex([
      { githubUserId: 42, githubUsername: 'aviynw2', displayName: null, avatarUrl: null, deviceAttestations: [] },
      { githubUserId: 42, githubUsername: 'aviynw2', displayName: 'Avi', avatarUrl: 'https://a/42.png', deviceAttestations: [] },
    ]);
    expect(i.byUsername.get('aviynw2')?.avatarUrl).toBe('https://a/42.png');
  });
});

describe('mapAuthorToIdentity — email (plan owner)', () => {
  it('enriches to a verified member when the local part matches a github username', () => {
    const r = mapAuthorToIdentity({ kind: 'email', value: 'aviynw2@gmail.com' }, idx());
    expect(r).toMatchObject({ id: '42', handle: 'aviynw2', avatarUrl: 'https://avatars/42.png', kind: 'human', verified: true });
  });
  it('falls back to local part + no avatar when unmatched (never a raw email)', () => {
    const r = mapAuthorToIdentity({ kind: 'email', value: 'stranger@example.com' }, idx());
    expect(r).toEqual({ id: 'stranger@example.com', handle: 'stranger', avatarUrl: null, kind: 'human', verified: false });
    expect(r.handle).not.toContain('@');
  });
});

describe('mapAuthorToIdentity — pubkey (per-item author)', () => {
  it('resolves a bound device pubkey to its github member', () => {
    const r = mapAuthorToIdentity({ kind: 'pubkey', value: 'pk-octo' }, idx());
    expect(r).toMatchObject({ id: '7', handle: 'octocat', avatarUrl: 'https://avatars/7.png', kind: 'human', verified: true });
  });
  it('falls back to a short pubkey (machine/agent) when unbound', () => {
    const r = mapAuthorToIdentity({ kind: 'pubkey', value: 'pk-unknown-device-xyz' }, idx());
    expect(r).toEqual({ id: 'pk-unknown-device-xyz', handle: 'pk-unkno…', avatarUrl: null, kind: 'agent', verified: false });
  });
});

describe('mapAuthorToIdentity — authorId (last editor)', () => {
  it('agent authorId → short agent label, no avatar', () => {
    const r = mapAuthorToIdentity({ kind: 'authorId', value: 'su-88991fc5-dd92', authorKind: 'agent' }, idx());
    expect(r).toEqual({ id: 'su-88991fc5-dd92', handle: 'su-88991fc5', avatarUrl: null, kind: 'agent', verified: false });
  });
  it('defaults to agent when authorKind is omitted', () => {
    const r = mapAuthorToIdentity({ kind: 'authorId', value: 'pus-abcd-ef01' }, idx());
    expect(r.kind).toBe('agent');
    expect(r.handle).toBe('pus-abcd');
  });
  it('human authorId that is a known user uuid → local username', () => {
    const r = mapAuthorToIdentity(
      { kind: 'authorId', value: '11111111-1111-1111-1111-111111111111', authorKind: 'human' },
      idx(),
    );
    expect(r).toMatchObject({ handle: 'localadmin', kind: 'human', verified: false });
  });
  it('human authorId that is an unknown uuid → short id', () => {
    const r = mapAuthorToIdentity(
      { kind: 'authorId', value: '99999999-9999-9999-9999-999999999999', authorKind: 'human' },
      idx(),
    );
    expect(r).toMatchObject({ handle: '99999999', kind: 'human', verified: false });
  });
  it('human authorId shaped like an email defers to email resolution', () => {
    const r = mapAuthorToIdentity({ kind: 'authorId', value: 'aviynw2@gmail.com', authorKind: 'human' }, idx());
    expect(r).toMatchObject({ id: '42', handle: 'aviynw2', verified: true });
  });
  it('empty value → safe unknown', () => {
    const r = mapAuthorToIdentity({ kind: 'authorId', value: '   ' }, idx());
    expect(r).toEqual({ id: 'unknown', handle: 'unknown', avatarUrl: null, kind: 'agent', verified: false });
  });
});
