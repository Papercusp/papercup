import { describe, expect, it } from 'vitest';
import {
  HARNESS_SHARED_CONFIG_FIELD_ORDER,
  HARNESS_SHARED_CONFIG_REL_PATH,
  HARNESS_SHARED_CONFIG_SCHEMA_VERSION,
  HARNESS_SHARED_PRIVACY_LEVELS,
  buildFreshConfig,
  composeHarnessConfigKey,
  isCupboardEligible,
  isHarnessSharedConfig,
  type HarnessSharedConfig,
} from './harness-shared-config-types';

const VALID_TOPIC = '0'.repeat(63) + 'a';

function makeConfig(over: Partial<HarnessSharedConfig> = {}): HarnessSharedConfig {
  return {
    topic: VALID_TOPIC,
    github_remote: 'git@github.com:papercup-ai/papercup.git',
    github_repository_id: 123456789,
    claim_status: 'unclaimed',
    privacy: 'shared-private',
    created_at: 1716_000_000_000,
    schema_version: 1,
    ...over,
  };
}

describe('constants', () => {
  it('HARNESS_SHARED_CONFIG_REL_PATH', () => {
    expect(HARNESS_SHARED_CONFIG_REL_PATH).toBe('.papercusp/shared.json');
  });

  it('HARNESS_SHARED_CONFIG_SCHEMA_VERSION is 1', () => {
    expect(HARNESS_SHARED_CONFIG_SCHEMA_VERSION).toBe(1);
  });

  it('HARNESS_SHARED_PRIVACY_LEVELS has 2 levels', () => {
    expect([...HARNESS_SHARED_PRIVACY_LEVELS]).toEqual(['shared-private', 'shared-public']);
  });

  it('HARNESS_SHARED_CONFIG_FIELD_ORDER is JCS ascending', () => {
    const sorted = [...HARNESS_SHARED_CONFIG_FIELD_ORDER].sort();
    expect(HARNESS_SHARED_CONFIG_FIELD_ORDER).toEqual(sorted);
  });

  it('HARNESS_SHARED_CONFIG_FIELD_ORDER covers every body field', () => {
    const cfg = makeConfig({ discord_channel: '#x' });
    const cfgKeys = Object.keys(cfg).sort();
    const fieldKeys = [...HARNESS_SHARED_CONFIG_FIELD_ORDER].sort();
    expect(fieldKeys).toEqual(cfgKeys);
  });
});

describe('isHarnessSharedConfig', () => {
  it('accepts a well-formed config', () => {
    expect(isHarnessSharedConfig(makeConfig())).toBe(true);
  });

  it('accepts a config with optional discord_channel', () => {
    expect(isHarnessSharedConfig(makeConfig({ discord_channel: '#engineering' }))).toBe(true);
  });

  it('rejects invalid topic', () => {
    expect(isHarnessSharedConfig(makeConfig({ topic: 'too-short' }))).toBe(false);
    expect(isHarnessSharedConfig(makeConfig({ topic: 'A'.repeat(64) }))).toBe(false);
  });

  it('rejects empty github_remote', () => {
    expect(isHarnessSharedConfig(makeConfig({ github_remote: '' }))).toBe(false);
  });

  it('rejects non-positive github_repository_id', () => {
    expect(isHarnessSharedConfig(makeConfig({ github_repository_id: 0 }))).toBe(false);
    expect(isHarnessSharedConfig(makeConfig({ github_repository_id: -1 }))).toBe(false);
    expect(isHarnessSharedConfig(makeConfig({ github_repository_id: 1.5 }))).toBe(false);
  });

  it('rejects unknown claim_status', () => {
    expect(
      isHarnessSharedConfig({ ...makeConfig(), claim_status: 'pending' }),
    ).toBe(false);
  });

  it('rejects unknown privacy', () => {
    expect(
      isHarnessSharedConfig({ ...makeConfig(), privacy: 'public' }),
    ).toBe(false);
  });

  it('rejects non-string discord_channel when present', () => {
    expect(isHarnessSharedConfig({ ...makeConfig(), discord_channel: 42 })).toBe(false);
  });

  it('rejects non-finite created_at', () => {
    expect(isHarnessSharedConfig(makeConfig({ created_at: Number.NaN }))).toBe(false);
    expect(isHarnessSharedConfig(makeConfig({ created_at: 0 }))).toBe(false);
  });

  it('rejects wrong schema_version', () => {
    expect(isHarnessSharedConfig({ ...makeConfig(), schema_version: 2 })).toBe(false);
  });

  it('rejects non-object input', () => {
    expect(isHarnessSharedConfig(null)).toBe(false);
    expect(isHarnessSharedConfig('not an object')).toBe(false);
    expect(isHarnessSharedConfig(42)).toBe(false);
  });
});

describe('composeHarnessConfigKey', () => {
  it('combines repo_id + topic prefix', () => {
    const cfg = makeConfig({ github_repository_id: 12345, topic: 'abcdef12' + '0'.repeat(56) });
    expect(composeHarnessConfigKey(cfg)).toBe('12345@abcdef12');
  });
});

describe('isCupboardEligible', () => {
  it('true for shared-public + unclaimed', () => {
    expect(
      isCupboardEligible(makeConfig({ privacy: 'shared-public', claim_status: 'unclaimed' })),
    ).toBe(true);
  });

  it('true for shared-public + claimed', () => {
    expect(
      isCupboardEligible(makeConfig({ privacy: 'shared-public', claim_status: 'claimed' })),
    ).toBe(true);
  });

  it('false for shared-private', () => {
    expect(
      isCupboardEligible(makeConfig({ privacy: 'shared-private', claim_status: 'claimed' })),
    ).toBe(false);
  });

  it('false for superseded / stale even if shared-public', () => {
    expect(
      isCupboardEligible(makeConfig({ privacy: 'shared-public', claim_status: 'superseded' })),
    ).toBe(false);
    expect(
      isCupboardEligible(makeConfig({ privacy: 'shared-public', claim_status: 'stale' })),
    ).toBe(false);
  });
});

describe('buildFreshConfig', () => {
  it('builds a config with claim_status=unclaimed + provided fields', () => {
    const cfg = buildFreshConfig({
      topic: VALID_TOPIC,
      github_remote: 'git@github.com:x/y.git',
      github_repository_id: 12345,
      privacy: 'shared-private',
      now: 1716_000_000_000,
    });
    expect(cfg.claim_status).toBe('unclaimed');
    expect(cfg.topic).toBe(VALID_TOPIC);
    expect(cfg.github_remote).toBe('git@github.com:x/y.git');
    expect(cfg.github_repository_id).toBe(12345);
    expect(cfg.privacy).toBe('shared-private');
    expect(cfg.created_at).toBe(1716_000_000_000);
    expect(cfg.schema_version).toBe(1);
    expect(cfg.discord_channel).toBeUndefined();
  });

  it('includes discord_channel only when supplied', () => {
    const cfg = buildFreshConfig({
      topic: VALID_TOPIC,
      github_remote: 'git@github.com:x/y.git',
      github_repository_id: 12345,
      privacy: 'shared-private',
      discord_channel: '#engineering',
      now: 1,
    });
    expect(cfg.discord_channel).toBe('#engineering');
  });

  it('rejects bad topic', () => {
    expect(() =>
      buildFreshConfig({
        topic: 'too-short',
        github_remote: 'x',
        github_repository_id: 1,
        privacy: 'shared-private',
        now: 1,
      }),
    ).toThrow(TypeError);
  });

  it('rejects bad github_remote', () => {
    expect(() =>
      buildFreshConfig({
        topic: VALID_TOPIC,
        github_remote: '',
        github_repository_id: 1,
        privacy: 'shared-private',
        now: 1,
      }),
    ).toThrow(TypeError);
  });

  it('rejects non-positive repo id', () => {
    expect(() =>
      buildFreshConfig({
        topic: VALID_TOPIC,
        github_remote: 'x',
        github_repository_id: 0,
        privacy: 'shared-private',
        now: 1,
      }),
    ).toThrow(TypeError);
  });

  it('round-trips through isHarnessSharedConfig', () => {
    const cfg = buildFreshConfig({
      topic: VALID_TOPIC,
      github_remote: 'x',
      github_repository_id: 1,
      privacy: 'shared-public',
      now: 1,
    });
    expect(isHarnessSharedConfig(cfg)).toBe(true);
  });
});
