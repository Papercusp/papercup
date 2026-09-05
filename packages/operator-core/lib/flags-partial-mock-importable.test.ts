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
// Added 2026-08-03 (all FOUR readers of its cached boolean arm, not just the exported getter).
import { workItemClaimLeaseEnabled } from './work-item-claim-lease-wiring';
// The next THREE landed together (WI-8887) and are one unblock, not three. work-item-redundancy
// and events/cache-eca-rule were migrated + de-listed days earlier but stayed UNLISTABLE here for
// something neither of them owns: this file asserts a property of the whole transitive import
// GRAPH, and both reach work-items.ts → issues-engineer.ts, which subscribed at module scope. Each
// import killed COLLECTION naming issues-engineer.ts via work-items.ts:98 — the mock rather than
// the importer, which is exactly why this class reads as unrelated to whoever grew the import edge.
//
// issues-engineer's own migration had been written, measured all-green and REVERTED once (its
// unseeded unpopulated state resolved issue scope to the near-dead 'default' partition); the
// `seed` is what made it safe. Full reasoning at its arm site.
//
// Do NOT "fix" a future collection failure here by deleting an import: a loud, accurate collection
// failure is this guard WORKING, and dropping the import converts it into a silent exemption.
import { workItemRedundancyEnabled } from './work-item-redundancy';
import { cacheTagEcaEnabled } from './events/cache-eca-rule';
import { issuesScopeWorkspace } from './issues-engineer';
// workspace-brain-scope is the one caller with NO sync reader of its flag cache — its only reader is
// async and awaits the real getFlag. It is listed here for the same reason as the rest (importability
// under a partial mock), but note it CANNOT join the reader-throws assertion below: calling its
// reader returns a promise, so the arm's throw would surface as a rejection, not a throw.
import { isWorkspaceCoordinationOn } from './workspace-brain-scope';
// Migrated 2026-09-05 (WI-6650). Worth listing for a reason beyond the class: this module
// is pulled in by flag-bus.ts as a SIDE-EFFECT import, and it had TWO module-scope accesses
// (an eager `void refreshLexiconPack()` reaching getFlag, plus the visible `onFlagChange(`),
// so the source lint could only ever have seen half of it. This assertion sees both.
import { activeServerPackId } from './lexicon/configure';
// EI-19416650993725684's ORIGINALLY REPORTED entry point, added 2026-08-30 — every import above is a
// module that was itself migrated, so together they guard the CLASS; this one guards the reported
// REPRODUCTION. The filed chain is `agent-tools/locks/configure.ts` → `txn-timeouts-config.ts`, whose
// module-scope onFlagChange killed any file that mocked the flags surface without that key. It is a
// side-effect-only module (no exports), so a bare import is the whole assertion — and it is the only
// entry here that reaches the arm through a THIRD party rather than being the migrated module itself,
// which is exactly the shape that made this class read as unrelated to whoever grew the import edge.
import './agent-tools/locks/configure';

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
    expect(() => workItemClaimLeaseEnabled()).toThrow(/onFlagChange/);
    // The last four are SEEDED callers, and they belong in this list for a reason worth stating:
    // `seed` populates the cache correctly BEFORE `onFlagChange` is touched, which invites the
    // reading that a seeded caller is exempt from this boundary. It is not — the seed is wrapped in
    // its own try/catch (a seed must never reach a hot-path reader) while the subscription is not,
    // so arming still throws.
    expect(() => workItemRedundancyEnabled()).toThrow(/onFlagChange/);
    expect(() => cacheTagEcaEnabled()).toThrow(/onFlagChange/);
    expect(() => issuesScopeWorkspace()).toThrow(/onFlagChange/);
    // activeServerPackId is also the module's SOLE arm site — `configureLexicon` is pointed at
    // this same function so `term()` arms through it. That makes this assertion do double duty:
    // it pins the boundary above, and it fails if the arm is ever dropped back out of the getter
    // (which would silently un-arm the hot `term()` read path while every other signal stays green).
    expect(() => activeServerPackId()).toThrow(/onFlagChange/);
  });

  it('an ASYNC reader surfaces the same arm as a REJECTION, not a throw', () => {
    // workspace-brain-scope's only flag reader is async, so its arm failure cannot be caught by the
    // sync `expect(fn).toThrow` form above — it becomes a rejected promise. Pinned separately rather
    // than folded in, because a reader that returns instead of throwing is exactly the shape that
    // would let a regression sit in the list above looking asserted while asserting nothing.
    return expect(isWorkspaceCoordinationOn()).rejects.toThrow(/onFlagChange/);
  });
});
