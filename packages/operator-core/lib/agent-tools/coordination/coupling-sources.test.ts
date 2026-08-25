/**
 * coupling-sources.test.ts — the injected-source contract behind P-013's querying
 * coupling signals, and the gate that decides whether the lock lane is armed at all.
 *
 * WHY THIS FILE EXISTS. `couplingSourcesFor` was already correct: hand it a
 * coordination domain and it arms `heldFiles`; omit one and the lock signal
 * degrades to nothing. The defect was one layer up, in the CALLER's decision about
 * when to resolve that domain — `coord:presence` resolved it under `include_detail`
 * alone, so `include_coupling`'s lock derivation silently inherited an unrelated
 * flag's gate. Measured 2026-08-09 over the full retained `tool_invocations`
 * history: 243 presence calls passed neither flag, 11 passed `include_coupling`
 * alone, 9 passed `include_detail` alone, and ZERO passed both. The signal never
 * fired once in production.
 *
 * So the rule lives in a named predicate rather than an `if` inside the handler,
 * and it is asserted here — an `if` in a handler is not reachable by a unit test,
 * which is precisely why the wrong one survived unnoticed.
 */
import { describe, expect, it } from 'vitest';

import { couplingSourcesFor, presenceNeedsCoordinationDomain } from './coupling-sources';

describe('presenceNeedsCoordinationDomain — each consumer gets its OWN reason to need it', () => {
  it('arms on include_coupling ALONE — the case that never fired for 12 days', () => {
    // THE REGRESSION GUARD. `include_coupling` is a consumer in its own right: the
    // `holds-a-lock-on` derivation never touches a roster row, so it has no reason
    // to require detail's roster lane. If this flips back to false, the one
    // automatic "this agent is on this file" signal goes dead again — silently,
    // because nothing errors and every fixture-based test still passes.
    expect(presenceNeedsCoordinationDomain({ include_coupling: true })).toBe(true);
  });

  it('arms on include_detail ALONE — the original consumer is unaffected', () => {
    expect(presenceNeedsCoordinationDomain({ include_detail: true })).toBe(true);
  });

  it('arms when BOTH are asked for', () => {
    expect(presenceNeedsCoordinationDomain({ include_detail: true, include_coupling: true })).toBe(
      true,
    );
  });

  it('stays OFF for the lean default read — the 243-call path pays nothing', () => {
    // The whole justification for gating at all: the default presence read must
    // not touch the lock pool. Without this case the predicate could be a constant
    // `true` and every assertion above would still pass.
    expect(presenceNeedsCoordinationDomain({})).toBe(false);
    expect(presenceNeedsCoordinationDomain({ include_detail: false, include_coupling: false })).toBe(
      false,
    );
    expect(
      presenceNeedsCoordinationDomain({ include_detail: undefined, include_coupling: undefined }),
    ).toBe(false);
  });
});

describe('couplingSourcesFor — the lock lane is ALWAYS armed; the domain does not gate it', () => {
  const base = { selfOwnerId: 'su-me', rosterOwnerIds: ['su-me', 'su-peer'] };

  it('arms heldFiles when a coordination domain is supplied', () => {
    expect(typeof couplingSourcesFor({ ...base, coordinationDomain: '/repo' }).heldFiles).toBe(
      'function',
    );
  });

  it('ALSO arms heldFiles with NO domain — domain-gating is what killed this signal', () => {
    // CONTRACT REVERSED DELIBERATELY (EI-20199756190949760). This used to assert
    // `toBeUndefined()`: no domain ⇒ no lock lane. That gate looked like a safe
    // degradation and was in fact the kill switch, for a reason no amount of care
    // at the call site could fix — agents write locks under the PROXYING operator's
    // checkout while a reader resolves its OWN tree, so the domain a caller can
    // honestly supply is the one guaranteed to match nothing. Measured: 100% of live
    // `agent_file_locks` rows sit under one domain that no agent-side reader resolves.
    //
    // The domain is a PARTITION key, never an access control. Access is bounded by
    // `rosterOwnerIds` here and re-intersected against the roster inside
    // `deriveCouplings` before emission (D-044 / D-078c), both of which hold with or
    // without a domain — so arming the lane unconditionally cannot widen anything.
    expect(typeof couplingSourcesFor({ ...base }).heldFiles).toBe('function');
  });

  it('always supplies the domain-INDEPENDENT legs, with or without a domain', () => {
    // Proves the domain gates ONLY the lock lane. If a future change accidentally
    // hangs plan edges or coord exchange off the same flag, they would inherit the
    // same silent AND-condition this file exists to prevent.
    for (const sources of [
      couplingSourcesFor({ ...base }),
      couplingSourcesFor({ ...base, coordinationDomain: '/repo' }),
    ]) {
      expect(typeof sources.planEdges).toBe('function');
      expect(typeof sources.recentPartners).toBe('function');
      // P-004. Armed UNCONDITIONALLY and asserted here rather than at each reader:
      // wiring a source per call site is exactly how `holds-a-lock-on` stayed dark for
      // 12 days (D-088). It must also never become conditional — the census reads
      // `armed: !!sources.obligations`, so an omitted source reports the leg STARVED,
      // making a genuinely empty obligation list indistinguishable from an unwired one.
      expect(typeof sources.obligations).toBe('function');
    }
  });
});
