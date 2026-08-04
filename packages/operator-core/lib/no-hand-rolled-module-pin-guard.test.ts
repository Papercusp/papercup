/**
 * no-hand-rolled-module-pin-guard.test.ts — the detection predicate behind
 * `scripts/check-no-hand-rolled-module-pin.mjs` (EI-19469900474673886).
 *
 * ## What the guard is for
 *
 * A module that pins its state with `globalThis[Symbol.for('...')]` is CORRECT —
 * two module records then share one object. It is also INVISIBLE:
 * `listModuleDuplications()` only knows about keys pinned through
 * `pinModuleState()`, so the realm-wide report answers a confident, clean `[]`
 * while that module is duplicated. That is the exact shape of the outage the
 * primitive exists to close (EI-19451658870832332): a surface reporting health
 * because its subject is invisible to it, not because the subject is healthy.
 *
 * ## Why the controls below are PERMANENT
 *
 * The whole-tree scan runs green today, which proves only the no-false-positive
 * direction. A guard that has only ever passed is a guard nobody has tested: if
 * the predicate silently stopped matching, the scan would keep printing ✔ and
 * the population would keep growing unseen — the same "detector cannot see its
 * subject" failure, one level up, in the thing built to prevent it.
 *
 * So the known-positive fixtures live here forever rather than being produced by
 * mutating a real file. That also sidesteps the repo's mutation hazards
 * entirely: no in-tree mutation means no git-sync sweep race and no restore
 * needed (see CLAUDE.md § "Proving a guard is falsifiable").
 *
 * ## Coverage limit — stated, not hidden
 *
 * The scan spans libs/ + packages/ + apps/, but this test lives in
 * @papercusp/operator-core, and `test:affected` selects suites by WORKSPACE.
 * Measured 2026-08-03:
 *
 *   libs/flags/src/server.ts                     -> flags, web, operator-core  ✓ selected
 *   apps/operator/lib/chat-cards/ask-user-local.ts -> web                      ✗ NOT selected
 *
 * So a NEW hand-rolled pin added under apps/operator does NOT trip this test on
 * the routine path (the known guard-enforcement trap, WI-9434 / D-034). Closing
 * that needs a `lint:` gate leg, which is deliberately NOT added here — it was
 * written while `main` was frozen on an unrelated red, and a new gate leg is a
 * fleet-wide risk to take when the gate is green. Tracked on
 * EI-19469900474673886. Run `npm run lint:no-hand-rolled-module-pin` for the
 * whole-tree answer in the meantime.
 */
import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — pure JS guard script, no .d.ts; imported for its predicate only.
import { findPins, scanTree } from '../../../scripts/check-no-hand-rolled-module-pin.mjs';

/** The shape the guard exists to catch — a real pin, as written in this repo. */
const HAND_ROLLED_PIN = `
const REGISTRY_KEY = Symbol.for('@papercusp/thing:registry');
type RegistryGlobal = typeof globalThis & { [REGISTRY_KEY]?: Map<string, string> };
function registry() {
  const g = globalThis as RegistryGlobal;
  if (!g[REGISTRY_KEY]) g[REGISTRY_KEY] = new Map();
  return g[REGISTRY_KEY];
}
`;

/** The sanctioned form — no Symbol.for, no globalThis, nothing to flag. */
const PINNED_THROUGH_PRIMITIVE = `
import { pinModuleState } from '@papercusp/module-singleton';
const state = pinModuleState('@papercusp/thing:registry', () => ({ registry: new Map() }));
`;

describe('no-hand-rolled-module-pin — predicate (known-positive controls)', () => {
  it('FLAGS a globalThis + Symbol.for pin', () => {
    const hits = findPins(HAND_ROLLED_PIN);
    expect(hits).toHaveLength(1);
    expect(hits[0].key).toBe('@papercusp/thing:registry');
  });

  it('FLAGS the direct-index form too (no mapped-type cast)', () => {
    const src = `
      const SLOT = Symbol.for('papercusp.someCache');
      const cache = (globalThis as any)[SLOT] ?? ((globalThis as any)[SLOT] = new Map());
    `;
    expect(findPins(src)).toHaveLength(1);
  });

  it('FLAGS every distinct key in a file that pins more than one', () => {
    const src = `
      const A_KEY = Symbol.for('papercusp.a');
      const B_KEY = Symbol.for('papercusp.b');
      const g = globalThis as any;
      g[A_KEY] ??= new Map();
      g[B_KEY] ??= new Map();
    `;
    expect(findPins(src).map((h: { key: string }) => h.key).sort()).toEqual([
      'papercusp.a',
      'papercusp.b',
    ]);
  });
});

describe('no-hand-rolled-module-pin — predicate (known-negative controls)', () => {
  it('does NOT flag state pinned through the primitive', () => {
    expect(findPins(PINNED_THROUGH_PRIMITIVE)).toEqual([]);
  });

  it('does NOT flag reading a THIRD-PARTY well-known symbol (no globalThis)', () => {
    // packages/operator-core/lib/endpoint-route/routes/dev/table-schema.ts
    const src = `const ftName = ft[Symbol.for('drizzle:Name')];`;
    expect(findPins(src)).toEqual([]);
  });

  it('does NOT flag tagging a shared object that is not globalThis', () => {
    // packages/operator-core/lib/log-events.ts tags `console`, not the realm.
    const src = `
      const __installedFlag = Symbol.for('papercusp.console.intercepted');
      export function install(): void {
        const c = console as Console & { [k: symbol]: boolean };
        if (c[__installedFlag]) return;
        c[__installedFlag] = true;
      }
    `;
    expect(findPins(src)).toEqual([]);
  });

  it('does NOT flag a globalThis access that uses no Symbol.for key', () => {
    const src = `const g = globalThis as Record<string, unknown>; g.someFlag = true;`;
    expect(findPins(src)).toEqual([]);
  });
});

describe('no-hand-rolled-module-pin — the tree', () => {
  it('has no UNALLOWLISTED hand-rolled pin', () => {
    const { violations } = scanTree();
    expect(
      violations.map((v: { rel: string; key: string }) => `${v.rel} (${v.key})`),
    ).toEqual([]);
  });

  it('the allowlist is not stale — every entry still holds a pin', () => {
    // A stale entry is not cosmetic: ALLOW is keyed by path, so an entry whose
    // file was migrated or moved silently re-permits a future pin at that path.
    const { stale } = scanTree();
    expect(stale).toEqual([]);
  });

  it('the five migrated libs are GONE from the population (the fix, asserted)', () => {
    const { everyPin } = scanTree();
    const paths = new Set(everyPin.map((p: { rel: string }) => p.rel));
    for (const migrated of [
      'libs/generic/lexicon/src/config.ts',
      'libs/generic/kokoro-tts/src/config.ts',
      'libs/generic/memory/src/config.ts',
      'libs/generic/memory/src/backend-registry.ts',
      'libs/generic/deployment-driver/src/registry.ts',
      'libs/generic/scheduled-registry/src/index.ts',
    ]) {
      expect(paths.has(migrated)).toBe(false);
    }
  });
});
