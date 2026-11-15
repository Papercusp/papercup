/**
 * subscription-lifecycle.test.ts — the pure half of P-002
 * (shared-reference-system-2026-11-13#D-029): the recipient predicate and the
 * fields an automatic subscribe stamps.
 */
import { describe, expect, test } from 'vitest';
import { automaticSubscriptionFields, isMachineIdentity, MACHINE_ID_PREFIXES } from './subscription-lifecycle';

describe('isMachineIdentity (R-7 recipient predicate)', () => {
  test.each([
    'system:operator/s-1794730968871-fa435a9a',
    'system:acceptance-drain',
    'system-staging-sync-review-alarm',
    'routine:rt_papercusp_plan_schedule_daily',
    'durable-spawn:implement:EI-1:abc',
    'admission-rule:4b5d03b3',
    'mcp-call-1018803',
    'self',
    'Human',
    'unassigned',
    '',
    '   ',
    null,
    undefined,
  ])('%j is a machine identity', (id) => {
    expect(isMachineIdentity(id)).toBe(true);
  });

  test.each([
    'su-c735a3e0-6589-4fda-a3b1-ceea5b0895f9',
    'role-000869a6-aad5-4b62-81fc-d7faf5d7c521',
    'alice',
    'systematic-reviewer', // a prefix test, not a substring test
  ])('%j is an agent recipient', (id) => {
    expect(isMachineIdentity(id)).toBe(false);
  });

  test('every listed machine family is classified by its prefix', () => {
    for (const p of MACHINE_ID_PREFIXES) expect(isMachineIdentity(`${p}x`)).toBe(true);
  });
});

describe('automaticSubscriptionFields', () => {
  test('a machine identity is skipped explicitly, for both automatic reasons', async () => {
    for (const reason of ['context', 'held_item'] as const) {
      expect(await automaticSubscriptionFields('system:operator/s-1-ab', reason, { currentEpoch: async () => 3 }))
        .toEqual({ subscribe: false, skipped: 'machine-identity' });
    }
  });

  test('context carries the current epoch; held_item carries none', async () => {
    const agent = 'su-00000001-0000-4000-8000-000000000001';
    expect(await automaticSubscriptionFields(agent, 'context', { currentEpoch: async () => 7 }))
      .toEqual({ subscribe: true, reason: 'context', context_epoch: 7 });
    expect(await automaticSubscriptionFields(agent, 'held_item', { currentEpoch: async () => 7 }))
      .toEqual({ subscribe: true, reason: 'held_item' });
  });
});
