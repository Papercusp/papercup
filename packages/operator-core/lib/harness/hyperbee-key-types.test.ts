import { describe, expect, it } from 'vitest';
import {
  APPEND_ONLY_TAGS,
  HYPERBEE_PREFIX_TO_TAG,
  HYPERBEE_TABLE_TAGS,
  HYPERBEE_TAG_TO_PREFIX,
  keyClaim,
  keyContributor,
  keyFeatureById,
  keyFeatureByStatus,
  keyIssue,
  keyPresence,
  keyQueueEntry,
  keyUsageEvent,
  parseHyperbeeKey,
  scanPrefix,
  scanPrefixForStatus,
  scanPrefixForUser,
  tagOfKey,
} from './hyperbee-key-types';

describe('table tags', () => {
  it('HYPERBEE_TABLE_TAGS has all federated tables', () => {
    // 9 v5 tables + plans-by-slug (plans-pg-canonical-migration-2026-06-03).
    // `prs` was retired (EI-479) — harness_feature_prs never federated.
    expect(HYPERBEE_TABLE_TAGS.length).toBe(10);
    for (const t of [
      'features-by-id',
      'features-by-status',
      'plans-by-slug',
      'queue',
      'working-set',
      'contributors',
      'usage',
      'presence',
      'claims',
      'issues',
    ]) {
      expect([...HYPERBEE_TABLE_TAGS]).toContain(t);
    }
  });

  it('APPEND_ONLY_TAGS has usage + claims', () => {
    expect(APPEND_ONLY_TAGS.has('usage')).toBe(true);
    expect(APPEND_ONLY_TAGS.has('claims')).toBe(true);
    expect(APPEND_ONLY_TAGS.has('contributors')).toBe(false);
    expect(APPEND_ONLY_TAGS.has('features-by-id')).toBe(false);
  });

  it('HYPERBEE_TAG_TO_PREFIX is bijective with HYPERBEE_PREFIX_TO_TAG', () => {
    for (const tag of HYPERBEE_TABLE_TAGS) {
      const prefix = HYPERBEE_TAG_TO_PREFIX[tag];
      expect(prefix.endsWith('/')).toBe(true);
      expect(HYPERBEE_PREFIX_TO_TAG[prefix]).toBe(tag);
    }
  });
});

describe('composers', () => {
  it('keyFeatureById builds canonical form', () => {
    expect(keyFeatureById('F-001')).toBe('features/by-id/F-001');
  });

  it('keyFeatureByStatus builds canonical form', () => {
    expect(keyFeatureByStatus('todo', 'F-001')).toBe('features/by-status/todo/F-001');
  });

  it('keyQueueEntry builds canonical form', () => {
    expect(keyQueueEntry(12345, 'F-001')).toBe('queue/12345/F-001');
  });

  it('keyContributor builds canonical form', () => {
    expect(keyContributor(12345)).toBe('contributors/12345');
  });

  it('keyUsageEvent builds canonical form', () => {
    expect(keyUsageEvent(12345, '01HZ123')).toBe('usage/12345/01HZ123');
  });

  it('keyPresence builds canonical form', () => {
    expect(keyPresence(12345, 'alice-laptop')).toBe('presence/12345/alice-laptop');
  });

  it('keyClaim builds canonical form', () => {
    expect(keyClaim('F-001', 42)).toBe('claims/F-001/42');
    expect(keyClaim('F-001', 0)).toBe('claims/F-001/0');
  });

  it('keyIssue builds canonical form', () => {
    expect(keyIssue('I-001')).toBe('issues/I-001');
  });

  it('composers reject empty string args', () => {
    expect(() => keyFeatureById('')).toThrow(TypeError);
    expect(() => keyFeatureByStatus('', 'F-1')).toThrow(TypeError);
    expect(() => keyContributor(0)).toThrow(TypeError);
    expect(() => keyQueueEntry(-1, 'F-1')).toThrow(TypeError);
    expect(() => keyClaim('F-1', -1)).toThrow(TypeError);
    expect(() => keyPresence(1, 'has/slash')).toThrow(TypeError);
  });

  it('keyClaim rejects non-integer seq', () => {
    expect(() => keyClaim('F-1', 1.5)).toThrow(TypeError);
  });
});

describe('parseHyperbeeKey — happy paths', () => {
  it('parses features/by-id', () => {
    expect(parseHyperbeeKey('features/by-id/F-001')).toEqual({
      tag: 'features-by-id',
      feature_id: 'F-001',
    });
  });

  it('parses features/by-status', () => {
    expect(parseHyperbeeKey('features/by-status/todo/F-001')).toEqual({
      tag: 'features-by-status',
      status: 'todo',
      feature_id: 'F-001',
    });
  });

  it('parses queue', () => {
    expect(parseHyperbeeKey('queue/12345/F-001')).toEqual({
      tag: 'queue',
      github_user_id: 12345,
      feature_id: 'F-001',
    });
  });

  it('parses contributors', () => {
    expect(parseHyperbeeKey('contributors/12345')).toEqual({
      tag: 'contributors',
      github_user_id: 12345,
    });
  });

  it('parses usage', () => {
    expect(parseHyperbeeKey('usage/12345/01HZ123')).toEqual({
      tag: 'usage',
      github_user_id: 12345,
      event_id: '01HZ123',
    });
  });

  it('parses presence', () => {
    expect(parseHyperbeeKey('presence/12345/alice-laptop')).toEqual({
      tag: 'presence',
      github_user_id: 12345,
      machine_label: 'alice-laptop',
    });
  });

  it('parses claims', () => {
    expect(parseHyperbeeKey('claims/F-001/42')).toEqual({
      tag: 'claims',
      feature_id: 'F-001',
      seq: 42,
    });
  });

  it('parses issues', () => {
    expect(parseHyperbeeKey('issues/I-001')).toEqual({
      tag: 'issues',
      issue_id: 'I-001',
    });
  });
});

describe('parseHyperbeeKey — composer round-trip', () => {
  it('composers + parser round-trip for every table', () => {
    expect(parseHyperbeeKey(keyFeatureById('F-1'))?.tag).toBe('features-by-id');
    expect(parseHyperbeeKey(keyFeatureByStatus('todo', 'F-1'))?.tag).toBe('features-by-status');
    expect(parseHyperbeeKey(keyQueueEntry(1, 'F-1'))?.tag).toBe('queue');
    expect(parseHyperbeeKey(keyContributor(1))?.tag).toBe('contributors');
    expect(parseHyperbeeKey(keyUsageEvent(1, 'e'))?.tag).toBe('usage');
    expect(parseHyperbeeKey(keyPresence(1, 'm'))?.tag).toBe('presence');
    expect(parseHyperbeeKey(keyClaim('F-1', 0))?.tag).toBe('claims');
    expect(parseHyperbeeKey(keyIssue('I-1'))?.tag).toBe('issues');
  });
});

describe('parseHyperbeeKey — malformed', () => {
  it('rejects empty / non-string input', () => {
    expect(parseHyperbeeKey('')).toBeNull();
    // @ts-expect-error
    expect(parseHyperbeeKey(null)).toBeNull();
    // @ts-expect-error
    expect(parseHyperbeeKey(undefined)).toBeNull();
  });

  it('rejects unknown prefixes', () => {
    expect(parseHyperbeeKey('unknown/x')).toBeNull();
    expect(parseHyperbeeKey('feature/x')).toBeNull(); // singular form, wrong
  });

  it('rejects bare features/ (needs by-id or by-status discriminator)', () => {
    expect(parseHyperbeeKey('features/F-001')).toBeNull();
  });

  it('rejects missing-id forms', () => {
    expect(parseHyperbeeKey('features/by-id/')).toBeNull();
    expect(parseHyperbeeKey('features/by-status/todo/')).toBeNull();
    expect(parseHyperbeeKey('queue/12345/')).toBeNull();
    expect(parseHyperbeeKey('contributors/')).toBeNull();
    expect(parseHyperbeeKey('claims/F-1/')).toBeNull();
    expect(parseHyperbeeKey('issues/')).toBeNull();
  });

  it('rejects multi-slash extension in single-id tables', () => {
    expect(parseHyperbeeKey('features/by-id/F-1/extra')).toBeNull();
    expect(parseHyperbeeKey('contributors/12345/extra')).toBeNull();
    expect(parseHyperbeeKey('issues/I-1/extra')).toBeNull();
  });

  it('rejects non-numeric github_user_id', () => {
    expect(parseHyperbeeKey('contributors/abc')).toBeNull();
    expect(parseHyperbeeKey('queue/abc/F-1')).toBeNull();
    expect(parseHyperbeeKey('usage/abc/x')).toBeNull();
    expect(parseHyperbeeKey('presence/abc/m')).toBeNull();
  });

  it('rejects non-integer seq on claims', () => {
    expect(parseHyperbeeKey('claims/F-1/abc')).toBeNull();
    expect(parseHyperbeeKey('claims/F-1/-1')).toBeNull();
  });

  it('correctly handles claims with feature_id containing slashes (theoretical)', () => {
    // claims/F-1/42 — but if feature_id were 'F/sub' (unusual), the parser
    // uses lastIndexOf('/') so seq is unambiguous.
    expect(parseHyperbeeKey('claims/F/sub/42')).toEqual({
      tag: 'claims',
      feature_id: 'F/sub',
      seq: 42,
    });
  });
});

describe('tagOfKey', () => {
  it('returns the tag for a well-formed key', () => {
    expect(tagOfKey('contributors/12345')).toBe('contributors');
    expect(tagOfKey('issues/I-1')).toBe('issues');
  });

  it('returns null for malformed', () => {
    expect(tagOfKey('garbage')).toBeNull();
    expect(tagOfKey('')).toBeNull();
  });
});

describe('scanPrefix', () => {
  it('returns the tag prefix for prefix scans', () => {
    expect(scanPrefix('contributors')).toBe('contributors/');
    expect(scanPrefix('queue')).toBe('queue/');
    expect(scanPrefix('features-by-id')).toBe('features/by-id/');
  });
});

describe('scanPrefixForUser', () => {
  it('builds per-user prefixes', () => {
    expect(scanPrefixForUser('queue', 12345)).toBe('queue/12345/');
    expect(scanPrefixForUser('usage', 12345)).toBe('usage/12345/');
    expect(scanPrefixForUser('presence', 12345)).toBe('presence/12345/');
  });

  it('rejects non-positive user_id', () => {
    expect(() => scanPrefixForUser('queue', 0)).toThrow(TypeError);
    expect(() => scanPrefixForUser('queue', -1)).toThrow(TypeError);
  });
});

describe('scanPrefixForStatus', () => {
  it('builds per-status prefix for features-by-status', () => {
    expect(scanPrefixForStatus('todo')).toBe('features/by-status/todo/');
    expect(scanPrefixForStatus('shipped')).toBe('features/by-status/shipped/');
  });

  it('rejects empty status', () => {
    expect(() => scanPrefixForStatus('')).toThrow(TypeError);
  });
});
