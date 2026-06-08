/**
 * derive-hive-topic.test.ts — the hive-directory topics (p2p-hive-directory P-002 / D-004).
 *
 * The global directory topic is ONE deterministic well-known 32-byte topic every
 * peer joins; invite-scoped topics are derived from a shared secret. Pure +
 * deterministic — same input → same topic across runs/processes.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  deriveDirectoryTopic,
  deriveInviteTopic,
  hiveTopicAsHex,
  GLOBAL_DIRECTORY_KEY,
  HIVE_TOPIC_PREFIX,
} from './derive-hive-topic';

describe('deriveDirectoryTopic — the single global directory topic (P-002)', () => {
  it('is a 32-byte Buffer (Hyperswarm topic length)', () => {
    const t = deriveDirectoryTopic();
    expect(Buffer.isBuffer(t)).toBe(true);
    expect(t.length).toBe(32);
  });

  it('is deterministic — every peer derives the SAME topic (the whole point)', () => {
    expect(deriveDirectoryTopic().equals(deriveDirectoryTopic())).toBe(true);
  });

  it('is exactly sha256("papercusp-hive-v1:directory")', () => {
    expect(GLOBAL_DIRECTORY_KEY).toBe('papercusp-hive-v1:directory');
    const expected = createHash('sha256').update(GLOBAL_DIRECTORY_KEY, 'utf8').digest();
    expect(deriveDirectoryTopic().equals(expected)).toBe(true);
  });

  it('does NOT collide with the per-harness substrate topic scheme', () => {
    // substrate-v1 prefix vs hive-v1 prefix — the directory rotates independently.
    const substrateStyle = createHash('sha256').update('papercusp-substrate-v1:directory', 'utf8').digest();
    expect(deriveDirectoryTopic().equals(substrateStyle)).toBe(false);
  });
});

describe('deriveInviteTopic — invite-scoped directory topics (D-004)', () => {
  it('is a deterministic 32-byte topic per secret', () => {
    const a = deriveInviteTopic('secret-xyz');
    expect(a.length).toBe(32);
    expect(a.equals(deriveInviteTopic('secret-xyz'))).toBe(true);
  });

  it('differs per secret AND differs from the global topic', () => {
    const a = deriveInviteTopic('secret-A');
    const b = deriveInviteTopic('secret-B');
    expect(a.equals(b)).toBe(false);
    expect(a.equals(deriveDirectoryTopic())).toBe(false);
  });

  it('is exactly sha256("papercusp-hive-v1:invite:" + secret)', () => {
    const expected = createHash('sha256').update(`${HIVE_TOPIC_PREFIX}invite:s1`, 'utf8').digest();
    expect(deriveInviteTopic('s1').equals(expected)).toBe(true);
  });

  it('rejects an empty secret (an invite needs a real secret)', () => {
    expect(() => deriveInviteTopic('')).toThrow(/non-empty/);
  });
});

describe('hiveTopicAsHex', () => {
  it('renders a 64-hex string', () => {
    const hex = hiveTopicAsHex(deriveDirectoryTopic());
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
  });
});
