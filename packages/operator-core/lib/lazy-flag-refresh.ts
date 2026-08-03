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
 *   const armFlagRefresh = lazyFlagRefresh(refreshMyConfig, FLAGS.MY_FLAG);
 *
 *   export function myConfigNow(): MyConfig {   // every SYNC reader arms
 *     armFlagRefresh();
 *     return cached;
 *   }
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
 * Why it is acceptable for the callers migrated so far, and the question to ask before adding one:
 * the pre-refresh value is each module's own fail-safe default — the same one its `catch` falls back
 * to, i.e. the baked, pre-feature behaviour — so the window degrades to "the override has not taken
 * effect yet", never to a wrong or unsafe value. It is also not a new window: every one of these
 * modules already served that default between import and the boot reload. If you are migrating a
 * cache whose unpopulated state is NOT a safe default (it opens something up rather than leaving it
 * baked), do not rely on lazy arming alone — give that module an explicit warm call on a boot path,
 * the way task-manager/enabled.ts does with `warmTaskManagerFlag()`.
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
 */
import { onFlagChange } from '@papercusp/flags/server';

/**
 * Build the arming function for a module-level config cache.
 *
 * @param refresh The module's existing refresh routine. Invoked once on the arming call (standing in
 *                for the boot flag-reload that a module-scope subscription used to catch), and again
 *                on every matching flag change. Errors are swallowed — every caller in this codebase
 *                already fails its refresh safe to a baked default, and a config refresh must never
 *                reject into a hot-path reader.
 * @param keys    Flag keys that should trigger a refresh. A `null` key (the bus-wide reload signal)
 *                ALWAYS triggers one, matching the hand-written form this replaces. Pass no keys for
 *                a cache that is not flag-gated and only wants the reload signal.
 * @returns An idempotent, synchronous `arm()` to call from every reader of the cache.
 */
export function lazyFlagRefresh(
  refresh: () => void | Promise<void>,
  ...keys: readonly string[]
): () => void {
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
