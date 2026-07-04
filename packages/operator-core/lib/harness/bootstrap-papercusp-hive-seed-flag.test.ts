/**
 * bootstrap-papercusp-hive-seed-flag.test.ts — the P-011 seed-bundle master gate
 * (FLAGS.HIVE_SEED_BUNDLE). Mocks getFlag so the gate's three behaviors are proven
 * without PostHog: honors ON, honors OFF (the runtime kill-switch → cold path), and
 * fails OPEN on a read error (never silently forces cold). Separate file so the flag
 * module-mock does not touch the main bootstrap test's dep-injected graph.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const getFlag = vi.fn();
vi.mock('@papercusp/flags/server', () => ({ getFlag: (...a: unknown[]) => getFlag(...a) }));

import { seedBundleEnabled } from './bootstrap-papercusp-hive';
import { FLAGS } from '@papercusp/flags';

describe('seedBundleEnabled — P-011 seed-bundle master gate', () => {
  beforeEach(() => getFlag.mockReset());

  it('ON (the default) ⇒ true, read against the system distinctId', async () => {
    getFlag.mockResolvedValue(true);
    expect(await seedBundleEnabled()).toBe(true);
    expect(getFlag).toHaveBeenCalledWith(FLAGS.HIVE_SEED_BUNDLE, 'system');
  });

  it('OFF ⇒ false (runtime kill-switch: both restore paths no-op, cold join runs)', async () => {
    getFlag.mockResolvedValue(false);
    expect(await seedBundleEnabled()).toBe(false);
  });

  it('a flag-read THROW ⇒ fails OPEN (true) — a flags hiccup never silently forces cold', async () => {
    getFlag.mockImplementation(async () => {
      throw new Error('posthog unreachable');
    });
    expect(await seedBundleEnabled()).toBe(true);
  });
});
