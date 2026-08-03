/**
 * flags-partial-mock-importable.test.ts — the MECHANISM-level counterpart to
 * `scripts/check-no-module-scope-flag-subscribe.mjs` (WI-6650 / EI-19416650993725684).
 *
 * THE CLASS: a module that READS a `@papercusp/flags/server` binding at module scope becomes
 * unimportable under a PARTIAL vitest mock of that surface. Vitest's mocked-module proxy throws on
 * binding ACCESS, not on invocation, so the throw lands at COLLECTION time and kills the WHOLE test
 * file (zero tests run) — and the error names the MOCK, not the importer, so it reads as unrelated to
 * whoever's change actually grew the import edge. It reds the fleet's green gate, not one suite.
 *
 * WHY THIS FILE EXISTS ALONGSIDE THE LINT: the lint is a source-TEXT check (a column-0
 * `onFlagChange(` / eager `FLAG_DEFAULTS[...]` deref). It cannot see a subscription that regresses
 * into a module-scope IIFE, a `const _ = subscribe()`, or a helper call that reaches the binding —
 * all of which pass the lint and still die at collection. This file tests the PROPERTY the lint only
 * approximates: with `@papercusp/flags/server` mocked to NOTHING AT ALL, these modules still import.
 *
 * ⚠⚠ HOW TO EXTEND — read before touching, this file is easy to "improve" into uselessness:
 *
 *   1. ADD an import line per module as it is migrated off module-scope subscription (and de-listed
 *      from the lint's BASELINE). One line, in the static import block below. That is the whole edit.
 *
 *   2. DO NOT CALL A READER in the importability tests. Every reader deliberately ARMS the
 *      subscription on first use, which IS a binding access and throws under this empty mock. A
 *      reader call here does not test the fix — it tests the arming, gets a throw, and reads exactly
 *      like "the fix does not work". (Measured 2026-08-03: a probe that called a reader failed
 *      against a correctly-fixed module and briefly argued the fix had failed.)
 *
 *   3. DO NOT use a dynamic `await import()`. The whole mechanism under test is COLLECTION-time
 *      binding access by a STATIC import. A dynamic import runs later, in a different phase, and
 *      passes whether or not the module is fixed — a green that proves nothing.
 *
 * The scope of the fix, stated precisely so neither half is over-claimed: it makes these modules
 * IMPORTABLE under a partial mock. It does NOT make their readers CALLABLE under one — a caller that
 * wants to exercise a reader must still mock the bindings that reader arms. The last describe block
 * pins that second half, so the distinction cannot quietly erode.
 */
import { describe, expect, it, vi } from 'vitest';

/**
 * The empty mock is the entire instrument: ANY access to ANY export of this surface throws
 * `No "<name>" export is defined on the "@papercusp/flags/server" mock`. A module that reads a
 * binding at module scope therefore cannot survive the static import block below.
 */
vi.mock('@papercusp/flags/server', () => ({}));

// Keep the probe about the FLAG binding only — these modules' PG seam is not what is under test.
vi.mock('./operator-state-pg', () => ({
  readOperatorState: vi.fn(async () => ({})),
  writeOperatorState: vi.fn(async () => {}),
}));

// ── the migrated modules ─────────────────────────────────────────────────────
// STATIC imports, on purpose (see note 3 above). Reaching this line at all is most of the assertion:
// a regressed module fails the FILE at collection, before any test below runs.
import { quotaOverrideKey, quotaOverrideFor } from './quota-overrides';
import { taskManagerEnabledSync } from './task-manager/enabled';
import { envelopeRoleOverrides } from './capability-envelope-overrides';
import { telemetryBufferConfig } from './telemetry-buffer-config';
import { capabilityTierOverrideFor } from './capability-tier-overrides';

describe('modules stay importable under a partial @papercusp/flags/server mock', () => {
  it('collected this file at all (a module-scope binding read would have failed it here)', () => {
    // Reaching this assertion means every static import above resolved with the flags surface
    // mocked to nothing — i.e. none of them touched a flag binding at module scope.
    expect(true).toBe(true);
  });

  it('exposes flag-independent exports without touching the flags surface', () => {
    // A PURE export — no cache read, no arming. Safe to call; proves the module really is usable,
    // not merely importable-and-inert.
    expect(quotaOverrideKey('search:fulltext', 'worker')).toBe('search:fulltext|worker');
  });
});

describe('the fix is IMPORTABILITY, not reader-callability (do not widen this claim)', () => {
  it('a reader still throws under the empty mock, because first use arms the subscription', () => {
    // This is the honest boundary of the fix, pinned so it cannot silently widen: arming reads
    // `onFlagChange`, and under a mock that defines nothing, that read throws. A test that wants to
    // exercise a reader must mock the bindings it arms — see quota-overrides.test.ts, which mocks
    // `{ onFlagChange }` for exactly this reason.
    expect(() => quotaOverrideFor('search:fulltext', 'worker')).toThrow(/onFlagChange/);
    expect(() => taskManagerEnabledSync()).toThrow(/onFlagChange/);
    expect(() => envelopeRoleOverrides()).toThrow(/onFlagChange/);
    expect(() => telemetryBufferConfig()).toThrow(/onFlagChange/);
    expect(() => capabilityTierOverrideFor('capability:bash')).toThrow(/onFlagChange/);
  });
});
