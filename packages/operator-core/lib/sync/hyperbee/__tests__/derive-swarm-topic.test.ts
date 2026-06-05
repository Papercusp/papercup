import { describe, expect, it } from 'vitest';
import {
  deriveSwarmTopic,
  serializeBinding,
  topicAsHex,
} from '../derive-swarm-topic';

describe('serializeBinding', () => {
  it('gh binding includes the repo id', () => {
    expect(serializeBinding({ kind: 'gh', github_repository_id: 12345 })).toBe('gh:12345');
  });

  it('gh accepts string ids (BIGINT JSON friendly)', () => {
    expect(serializeBinding({ kind: 'gh', github_repository_id: '12345' })).toBe('gh:12345');
  });

  it('local includes both workspace + slug', () => {
    expect(
      serializeBinding({ kind: 'local', workspace_id: 'default', harness_slug: 'papercup' }),
    ).toBe('local:default/papercup');
  });

  it('rejects empty gh id', () => {
    expect(() => serializeBinding({ kind: 'gh', github_repository_id: '' })).toThrow(/repository_id/);
  });

  it('rejects missing local fields', () => {
    expect(() => serializeBinding({ kind: 'local', workspace_id: '', harness_slug: 'x' })).toThrow(/workspace_id/);
    expect(() => serializeBinding({ kind: 'local', workspace_id: 'w', harness_slug: '' })).toThrow(/harness_slug/);
  });
});

describe('deriveSwarmTopic', () => {
  it('produces a 32-byte buffer', () => {
    const t = deriveSwarmTopic({ kind: 'gh', github_repository_id: 1 });
    expect(t).toBeInstanceOf(Buffer);
    expect(t.length).toBe(32);
  });

  it('is deterministic for the same binding', () => {
    const a = deriveSwarmTopic({ kind: 'gh', github_repository_id: 12345 });
    const b = deriveSwarmTopic({ kind: 'gh', github_repository_id: 12345 });
    expect(a.equals(b)).toBe(true);
  });

  it('different repo ids → different topics', () => {
    const a = deriveSwarmTopic({ kind: 'gh', github_repository_id: 1 });
    const b = deriveSwarmTopic({ kind: 'gh', github_repository_id: 2 });
    expect(a.equals(b)).toBe(false);
  });

  it('gh and local with the "same looking" name differ (prefix isolation)', () => {
    // Even if a string happens to overlap, the prefix keeps them apart.
    const a = deriveSwarmTopic({ kind: 'gh', github_repository_id: '42' });
    const b = deriveSwarmTopic({ kind: 'local', workspace_id: 'default', harness_slug: '42' });
    expect(a.equals(b)).toBe(false);
  });

  it('different workspace → different topic even for same slug', () => {
    const a = deriveSwarmTopic({ kind: 'local', workspace_id: 'w1', harness_slug: 's' });
    const b = deriveSwarmTopic({ kind: 'local', workspace_id: 'w2', harness_slug: 's' });
    expect(a.equals(b)).toBe(false);
  });

  it('topicAsHex returns 64 hex chars', () => {
    const t = deriveSwarmTopic({ kind: 'gh', github_repository_id: 1 });
    expect(topicAsHex(t)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('stable snapshot — known gh:1 → fixed sha256 of "papercusp-substrate-v1:gh:1"', () => {
    // Snapshot test: if the scheme changes, this fails loud + an
    // explicit version bump is needed in the helper.
    const t = topicAsHex(deriveSwarmTopic({ kind: 'gh', github_repository_id: 1 }));
    expect(t).toMatch(/^[0-9a-f]{64}$/);
    // Recompute by hand here to detect drift.
    const expected = require('node:crypto')
      .createHash('sha256')
      .update('papercusp-substrate-v1:gh:1', 'utf8')
      .digest('hex');
    expect(t).toBe(expected);
  });
});
