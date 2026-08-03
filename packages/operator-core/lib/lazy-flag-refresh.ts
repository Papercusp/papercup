/**
 * lazy-flag-refresh — the ONE canonical way to keep a module-level config cache fresh from the flag
 * bus WITHOUT touching a flag binding at import (EI-19416650993725684, residual of WI-6650).
 *
 * ## The trap this exists to close
 *
 * A module that READS a `@papercusp/flags/server` binding at module scope becomes unimportable under
 * a PARTIAL vitest mock of that surface:
 *
 *   vi.mock('@papercusp/flags/server', () => ({ getFlag }));   // narrow mock, for the test's own needs
 *   → Error: [vitest] No "onFlagChange" export is defined on the "@papercusp/flags/server" mock.
 *
 * Vitest's mocked-module proxy throws on binding ACCESS, not on invocation, so the throw lands at
 * COLLECTION time and kills the WHOLE test file (zero tests run). Worse, the error names the MOCK,
 * not the importer — so it reads as unrelated to whoever's change actually grew the import edge, and
 * it reds the fleet's green gate rather than one suite. The reach is arbitrary: any test whose
 * transitive import graph touches such a module inherits the landmine.
 *
 * ⚠ MEASURED, do not "simplify" a caller back to a defensive module-scope form: they do NOT work,
 * because they are all still binding ACCESSES — `onFlagChange?.(...)`, `typeof onFlagChange`,
 * try/catch around the call, and `import * as ns` + `ns.onFlagChange?.()` throw identically. Moving
 * the access inside a function body is the only fix that keeps the import pure.
 *
 * ⚠ AND THIS HELPER MUST NOT MOVE INTO `@papercusp/flags/server`. It looks like it belongs there,
 * and putting it there silently re-creates the bug with a new name: a caller's module-scope
 * `lazyFlagRefresh(...)` would then be a binding access on that same mocked surface, so a partial
 * mock would need to stub `lazyFlagRefresh` instead of `onFlagChange`. The helper only works because
 * it lives on the far side of a DIFFERENT module specifier.
 *
 * ## Usage
 *
 *   const armFlagRefresh = lazyFlagRefresh(refreshMyConfig, {
 *     keys: [FLAGS.MY_FLAG],
 *     unpopulated: {
 *       kind: 'gates-an-override-store',
 *       serves: 'MY_BAKED_DEFAULTS — what production runs whenever no override is stored',
 *     },
 *   });
 *
 *   export function myConfigNow(): MyConfig {   // every SYNC reader arms
 *     armFlagRefresh();
 *     return cached;
 *   }
 *
 * The `unpopulated` declaration is REQUIRED and is the whole point of the second argument — see
 * "The one behaviour this DOES change" below before choosing a `kind`.
 *
 * The `lazyFlagRefresh(...)` call itself is PURE — it closes over the callback and touches no flag
 * binding — so the module stays importable under any mock. The real subscription is installed by
 * whichever reader runs first.
 *
 * ## Why arming from READERS is sufficient (and why refresh functions should NOT arm)
 *
 * The subscription exists solely to keep a cache fresh FOR ITS READERS. A process where no reader
 * ever runs has nothing to keep fresh, so never arming there is correct, not a gap. Callers in this
 * codebase also pair the subscription with a ~60s `managedSetInterval` refresh and a same-process
 * write path; the subscription is an IMMEDIACY optimisation layered on those, never the only route
 * to a fresh value. That is what bounds the blast radius of a missed arm point to one refresh
 * interval instead of "stale forever".
 *
 * Do not also arm from the refresh function itself: it makes the first timer tick re-enter this
 * helper and kick a redundant concurrent refresh, for a guarantee that buys nothing (see above).
 *
 * ## The one behaviour this DOES change — know it before migrating a caller
 *
 * A module-scope subscription got its first population from the boot flag-reload, on the bus's
 * schedule and independent of readers. Lazy arming moves that to the FIRST READER CALL — and because
 * the refresh is async while the reader is sync, THAT FIRST CALL STILL SEES THE PRE-REFRESH VALUE.
 * Where the boot reload had already fired before the first read, this widens that window by one
 * refresh round-trip.
 *
 * ⚠ THIS IS THE ONE PROPERTY NO ROUTINE SIGNAL MEASURES. The source lint, the partial-mock
 * importability test, `tsc` and the unit suites all check IMPORTABILITY and TYPES — they emit an
 * identical green for a safe migration and an unsafe one. So the safety of the pre-refresh window is
 * decided entirely by a judgement the author has to make deliberately, which is why the
 * `unpopulated` declaration below is a REQUIRED argument rather than a doc paragraph. (A doc
 * paragraph was tried first and demonstrably failed: EI-19448574704459898 records an agent reading
 * this very section and still migrating `issues-engineer.ts`, all-green, onto a dead data partition.)
 *
 * ### The discriminator: does the flag gate an OVERRIDE STORE, or SELECT A BEHAVIOUR?
 *
 * "Is the flag default-ON?" is NOT the test — measured 2026-08-03, 4 of the 7 callers here are gated
 * on default-ON flags and all 4 are safe. The test is what the unpopulated value POINTS AT:
 *
 * - **Gates an override store** (`telemetry-buffer-config`, `capability-tier-overrides`,
 *   `capability-envelope-overrides`) — the flag decides only whether a STORED OVERRIDE is honoured,
 *   so unpopulated serves the baked constants, which is what production runs whenever no override is
 *   set (the normal case). Safe by construction, default-ON or not.
 * - **Selects a behaviour** (`work-item-claim-lease-wiring`, `work-item-redundancy`,
 *   `events/cache-eca-rule`) — the flag chooses between two substantive behaviours, so the window
 *   genuinely serves the OTHER one. Safe only if that is a self-healing DEGRADATION (a skipped cache
 *   bump, a claim without its lease) rather than a WRONG ANSWER. Justify it in `safeBecause`.
 *
 * The unsafe shape is a behaviour-selector whose off-branch points at something DEAD or WRONG rather
 * than merely reduced: `issues-engineer.ts` resolves `false` → the legacy `'default'` coord
 * workspace, a partition whose last write was 2026-06-22 while every live row sits elsewhere — so
 * its first read per process would be a hard, deterministic zero, not a degradation. That module is
 * deliberately NOT migrated; see the block comment there.
 *
 * ⚠ There is NO "warm it on a boot path" escape hatch, despite what this file used to claim. It
 * pointed at `task-manager/enabled.ts`'s `warmTaskManagerFlag()` as the pattern to copy —
 * that function has ZERO production call sites (verified 2026-08-03: only its own definition, its
 * post-flip re-warm, and its test). `task-manager` is safe because its unpopulated state is
 * deliberately fail-OPEN (`cached !== false`), i.e. it CHOSE a safe fallback — not because anything
 * warms it early. Choosing the safe fallback is the real remedy; a warm you have to remember to call
 * from every process that reads is not one.
 *
 * ## Guards
 *
 * - `scripts/check-no-module-scope-flag-subscribe.mjs` — shrink-only source lint; fails on a NEW
 *   column-0 `onFlagChange(` / eager `FLAG_DEFAULTS[...]` deref. Its BASELINE is the not-yet-migrated
 *   set; migrating a module off it means DE-LISTING the file in the same change.
 * - `packages/operator-core/lib/flags-partial-mock-importable.test.ts` — the mechanism-level
 *   counterpart: imports every migrated module under an EMPTY flags mock, so a regression the source
 *   lint cannot see (an IIFE, a helper call, a `const _ = subscribe()`) still fails loudly. Add one
 *   import line there per module you migrate.
 * - The SAME source lint also cross-checks each call's `unpopulated.kind` against its own `keys`
 *   (`not-flag-gated` must pass no keys; the other two must pass at least one), so a declaration
 *   cannot contradict its arguments. What it deliberately CANNOT check is whether a
 *   `selects-behaviour` justification is TRUE — that judgement is the author's, which is exactly why
 *   it is a required, greppable, reviewable field rather than an inference.
 */
import { onFlagChange } from '@papercusp/flags/server';

/**
 * What a SYNC reader of the cache serves BEFORE the first async refresh lands — the one property no
 * routine signal in this repo measures, so it is declared explicitly at every call site.
 *
 * The `kind` is cross-checked by `scripts/check-no-module-scope-flag-subscribe.mjs` against the
 * call's flag keys, so a declaration cannot silently contradict its own arguments.
 */
export type UnpopulatedState =
  /**
   * The flag decides only whether a STORED OVERRIDE is honoured. Unpopulated therefore serves the
   * module's baked constants — exactly what production runs whenever no override is set. Safe by
   * construction, whether or not the flag is default-ON.
   */
  | { kind: 'gates-an-override-store'; serves: string }
  /** The cache is not flag-gated at all; the `key === null` bus reload is used purely as a "refresh now" signal. */
  | { kind: 'not-flag-gated'; serves: string }
  /**
   * The flag selects between two substantive behaviours, so the pre-refresh window genuinely serves
   * the OTHER one. Permitted only when that is a self-healing DEGRADATION rather than a wrong
   * answer — and `safeBecause` has to say which, in terms of what the off-branch actually points at.
   */
  | { kind: 'selects-behaviour'; serves: string; safeBecause: string };

export interface LazyFlagRefreshOptions {
  /**
   * Flag keys that should trigger a refresh. A `null` key (the bus-wide reload signal) ALWAYS
   * triggers one, matching the hand-written form this replaces. Omit for a cache that is not
   * flag-gated and only wants the reload signal.
   */
  keys?: readonly string[];
  /** REQUIRED — see {@link UnpopulatedState}. This argument exists to force the judgement. */
  unpopulated: UnpopulatedState;
}

/**
 * Build the arming function for a module-level config cache.
 *
 * @param refresh The module's existing refresh routine. Invoked once on the arming call (standing in
 *                for the boot flag-reload that a module-scope subscription used to catch), and again
 *                on every matching flag change. Errors are swallowed — every caller in this codebase
 *                already fails its refresh safe to a baked default, and a config refresh must never
 *                reject into a hot-path reader.
 * @param options Flag keys plus the REQUIRED `unpopulated` declaration.
 * @returns An idempotent, synchronous `arm()` to call from every reader of the cache.
 */
export function lazyFlagRefresh(
  refresh: () => void | Promise<void>,
  options: LazyFlagRefreshOptions,
): () => void {
  const keys: readonly string[] = options.keys ?? [];
  let armed = false;
  const kick = (): void => {
    try {
      void Promise.resolve(refresh()).catch(() => {});
    } catch {
      /* a synchronous throw in a config refresh must never reach a hot-path reader */
    }
  };
  return function armFlagRefresh(): void {
    if (armed) return;
    armed = true; // set FIRST — a refresh that reaches a reader cannot re-enter this arming path
    onFlagChange((key) => {
      if (key === null || keys.includes(key)) kick();
    });
    kick(); // first population; the module-scope subscription used to get this from the boot reload
  };
}
