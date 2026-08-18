import { describe, expect, test } from 'vitest';

import {
  crossCheckLaunchVerification,
  type OwnerWorkActivity,
} from './launch-verification-cross-check';

const activity = (o: Partial<OwnerWorkActivity> & { ownerId: string }): OwnerWorkActivity => ({
  closes: 0,
  claims: 0,
  firstSeenAt: null,
  lastSeenAt: null,
  ...o,
});

describe('crossCheckLaunchVerification', () => {
  test('THE 2026-08-16 CASE: members stamped failed that closed 15 items are reported, not swallowed', async () => {
    const r = await crossCheckLaunchVerification(
      ['su-80b15f7a-d64e-4dda-8c38-da33472b38aa', 'su-23e0b88c-e442-45d7-8666-dc8dcb2fe8bb'],
      async () => [
        activity({
          ownerId: 'su-80b15f7a-d64e-4dda-8c38-da33472b38aa',
          closes: 8,
          claims: 8,
          firstSeenAt: '2026-08-16T04:20:18.000Z',
          lastSeenAt: '2026-08-16T23:20:04.000Z',
        }),
        activity({
          ownerId: 'su-23e0b88c-e442-45d7-8666-dc8dcb2fe8bb',
          closes: 7,
          claims: 7,
          firstSeenAt: '2026-08-16T05:24:38.000Z',
          lastSeenAt: '2026-08-16T20:10:53.000Z',
        }),
      ],
    );
    expect(r.launchVerificationFalseNegative).toHaveLength(2);
    // Ordered by impact so the worst false negative leads.
    expect(r.launchVerificationFalseNegative?.[0].ownerId).toBe('su-80b15f7a-d64e-4dda-8c38-da33472b38aa');
    expect(r.launchVerificationFalseNegative?.[0].closes).toBe(8);
    expect(r.note).toContain('LAUNCH VERIFICATION FALSE NEGATIVE');
    expect(r.note).toContain('15 close(s)');
    expect(r.note).toContain('Do NOT report this fleet as having no members');
  });

  test('genuinely-failed members produce an EMPTY list, distinct from an unknown', async () => {
    const r = await crossCheckLaunchVerification(['su-dead-1', 'su-dead-2'], async () => [
      activity({ ownerId: 'su-dead-1' }),
      activity({ ownerId: 'su-dead-2' }),
    ]);
    expect(r.launchVerificationFalseNegative).toEqual([]);
    expect(r.note).toBeUndefined();
  });

  test('a member with claims but zero closes still counts — it started, which is the claim under test', async () => {
    const r = await crossCheckLaunchVerification(['su-slow'], async () => [
      activity({ ownerId: 'su-slow', closes: 0, claims: 3 }),
    ]);
    expect(r.launchVerificationFalseNegative).toHaveLength(1);
    expect(r.launchVerificationFalseNegative?.[0].claims).toBe(3);
  });

  test('a FAILING ledger read degrades to null (unknown) — never to a confident empty list', async () => {
    const r = await crossCheckLaunchVerification(['su-a'], async () => {
      throw new Error('pool timeout');
    });
    // This distinction is the whole point: `[]` means checked-and-clean, `null` means not checked.
    expect(r.launchVerificationFalseNegative).toBeNull();
    expect(r.launchVerificationFalseNegative).not.toEqual([]);
    expect(r.note).toContain('UNVERIFIED');
    expect(r.note).toContain('pool timeout');
  });

  test('no failed members ⇒ nothing to check, and no query is issued', async () => {
    let called = false;
    const r = await crossCheckLaunchVerification([], async () => {
      called = true;
      return [];
    });
    expect(called).toBe(false);
    expect(r.launchVerificationFalseNegative).toEqual([]);
  });

  test('duplicate and empty owner ids are normalised away before the query', async () => {
    let asked: readonly string[] = [];
    await crossCheckLaunchVerification(['su-a', 'su-a', '', 'su-b'], async (ids) => {
      asked = ids;
      return [];
    });
    expect(asked).toEqual(['su-a', 'su-b']);
  });
});
