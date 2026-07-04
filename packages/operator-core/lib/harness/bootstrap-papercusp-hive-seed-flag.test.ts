/**
 * bootstrap-papercusp-hive-seed-flag.test.ts — the P-011 seed-bundle master gate
 * (FLAGS.HIVE_SEED_BUNDLE). Injects the flag reader (the codebase's seam idiom) so
 * the gate's three behaviors are proven with no PostHog and no module mock: honors
 * ON, honors OFF (the runtime kill-switch → cold path), and fails OPEN on a read
 * error (a flags hiccup never silently forces cold).
 */

import { describe, it, expect } from 'vitest';
import { seedBundleEnabled } from './bootstrap-papercusp-hive';

describe('seedBundleEnabled — P-011 seed-bundle master gate', () => {
  it('ON (the default) ⇒ true', async () => {
    expect(await seedBundleEnabled(async () => true)).toBe(true);
  });

  it('OFF ⇒ false (runtime kill-switch: both restore paths no-op, cold join runs)', async () => {
    expect(await seedBundleEnabled(async () => false)).toBe(false);
  });

  it('a flag-read THROW ⇒ fails OPEN (true) — a flags hiccup never silently forces cold', async () => {
    expect(
      await seedBundleEnabled(async () => {
        throw new Error('posthog unreachable');
      }),
    ).toBe(true);
  });
});
