/**
 * set-content-cas-precedence.test.ts — the INTERACTION of the two compare-and-
 * swap baselines on `evaluateSetContent`, which the existing per-CAS tests
 * (each baseline in isolation) do not exercise.
 *
 * `evaluateSetContent` honors two CAS baselines (set-content.ts §1):
 *
 *     1. version CAS  — opts.expectedVersion vs opts.meta.version   (preferred, D-005)
 *     2. hash CAS     — expectedHash         vs hashPlanContent(current)
 *
 * The ORDER in the source is: version CAS is checked FIRST; only if it passes
 * (or is inapplicable) is the hash CAS checked. This test pins that precedence
 * when BOTH are supplied and they disagree:
 *
 *   - matching version + stale hash  → passes version CAS, then hash CAS REJECTS
 *     (so a stale hash still guards even when the version matched).
 *   - stale version + matching hash  → version CAS REJECTS first (the hash is
 *     never consulted; the rejection carries the stale-version currentVersion).
 *   - both match                     → proceeds to legacy/lint and succeeds.
 *
 * The version CAS only engages when BOTH expectedVersion and meta.version are
 * non-null (set-content.ts:117); with no meta the version branch is skipped and
 * only the hash CAS applies.
 *
 * Pure: drives the exported decision directly, no lock/PG.
 */

import { describe, expect, it } from 'vitest';
import { evaluateSetContent } from '../set-content';
import { hashPlanContent } from '../content-hash';

const SLUG = 'cas-precedence-2026-06-04';

/** Minimal non-legacy plan that lints clean. */
const CURRENT = `---
title: CAS Precedence
slug: ${SLUG}
created: 2026-06-04
updated: 2026-06-04
status: active
---

# CAS Precedence

## Now

**State:** Where things stand.

**Next:** The next concrete action.

## Background

Some prose.

## Decisions
`;

/** A different (also lint-clean) body to write. */
const NEXT = CURRENT.replace('Some prose.', 'Some other prose.');

const LIVE_VERSION = 7;
const LIVE_HASH = hashPlanContent(CURRENT);
const STALE_HASH = 'deadbeef-not-the-current-hash';
const STALE_VERSION = 6; // != LIVE_VERSION

/** meta as withPlanLock would pass it: the live row's {version, contentHash}. */
const META = { version: LIVE_VERSION, contentHash: LIVE_HASH };

describe('evaluateSetContent — CAS precedence when BOTH baselines are supplied', () => {
  it('matching version + STALE hash → hash CAS still rejects (version passing does not bypass the hash guard)', async () => {
    const r = await evaluateSetContent(CURRENT, NEXT, SLUG, STALE_HASH, {
      expectedVersion: LIVE_VERSION, // matches → version CAS passes
      meta: META,
    });
    expect(r.value.ok).toBe(false);
    expect(r.value.ok === false && r.value.code).toBe('stale');
    if (r.value.ok === false && r.value.code === 'stale') {
      // The rejection reports the live state for the UI to reload.
      expect(r.value.currentHash).toBe(LIVE_HASH);
      expect(r.value.currentVersion).toBe(LIVE_VERSION);
      expect(r.value.currentContent).toBe(CURRENT);
    }
    expect(r.newBody).toBeNull();
  });

  it('STALE version + matching hash → version CAS rejects FIRST (the hash is never consulted)', async () => {
    const r = await evaluateSetContent(CURRENT, NEXT, SLUG, LIVE_HASH, {
      expectedVersion: STALE_VERSION, // != LIVE_VERSION → version CAS fails first
      meta: META,
    });
    expect(r.value.ok).toBe(false);
    expect(r.value.ok === false && r.value.code).toBe('stale');
    if (r.value.ok === false && r.value.code === 'stale') {
      // currentVersion is the LIVE version (what the version-CAS branch reports),
      // proving the version branch — not the hash branch — produced this reject.
      expect(r.value.currentVersion).toBe(LIVE_VERSION);
      expect(r.value.currentHash).toBe(LIVE_HASH);
    }
    expect(r.newBody).toBeNull();
  });

  it('both baselines match → CAS passes and the write proceeds (lint clean)', async () => {
    const r = await evaluateSetContent(CURRENT, NEXT, SLUG, LIVE_HASH, {
      expectedVersion: LIVE_VERSION,
      meta: META,
    });
    expect(r.value.ok).toBe(true);
    expect(r.newBody).toBe(NEXT);
  });
});

describe('evaluateSetContent — version CAS only engages with both version inputs present', () => {
  it('stale version but NO meta (currentVersion null) → version branch skipped; only the (matching) hash CAS applies → proceeds', async () => {
    // expectedVersion is stale, but meta is null so opts.meta?.version is
    // undefined → the version CAS guard (needs BOTH non-null) is skipped, and the
    // matching hash CAS lets the write through.
    const r = await evaluateSetContent(CURRENT, NEXT, SLUG, LIVE_HASH, {
      expectedVersion: STALE_VERSION,
      meta: null,
    });
    expect(r.value.ok).toBe(true);
    expect(r.newBody).toBe(NEXT);
  });

  it('matching version, meta present, NO expectedHash → version CAS passes, hash CAS skipped → proceeds', async () => {
    const r = await evaluateSetContent(CURRENT, NEXT, SLUG, undefined, {
      expectedVersion: LIVE_VERSION,
      meta: META,
    });
    expect(r.value.ok).toBe(true);
    expect(r.newBody).toBe(NEXT);
  });
});
