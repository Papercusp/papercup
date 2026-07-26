/**
 * service-model-drift.test.ts — the MISSING DETECTOR (WI-6153, plan P-014).
 *
 * ── Why this file exists ─────────────────────────────────────────────────────
 * `pairs/service.ts` scores coverage against a HAND-MAINTAINED MODEL of
 * `dev:service_health` (`PROBED_PORTS`, `UNIT_TO_PROBE`,
 * `SUPERVISED_BUT_UNPROBED`). That duplication is deliberate — see the note on
 * `PROBED_PORTS` — but its safety claim was FALSE AS BUILT:
 *
 *   "if the real endpoint list changes the recomputed verdict must change with
 *    it rather than silently tracking a shared constant. The `expectedVerdict`
 *    latch is what surfaces the divergence."
 *
 * The `expectedVerdict` latch (seed.ts, equivalence.test.ts) compares a verdict
 * RECOMPUTED FROM `cover()` against the pair's recorded `expectedVerdict`. But
 * `cover()` reads the model constants, NOT the real `HEALTH_ENDPOINTS`. So
 * changing the actual tool without touching the model leaves `cover()`
 * unchanged, leaves the recomputed verdict unchanged, and the latch stays GREEN.
 * It catches "model changed but expectedVerdict didn't". It cannot catch "TOOL
 * changed but MODEL didn't" — which is precisely the drift the comment promises
 * to prevent.
 *
 * That is not hypothetical. WI-6146 added `staging-api` (:3170) to
 * `HEALTH_ENDPOINTS`; the model kept saying :3170 was unprobed and both
 * user-facing `advisoryText` strings kept telling agents to shell out to curl
 * for the exact thing that now had a tool form. The whole bash-substitution
 * suite passed throughout.
 *
 * ── What this file asserts ───────────────────────────────────────────────────
 * The model and the real tool agree, in BOTH directions. Widening
 * `dev:service_health` (or narrowing it) now REDS here until the model is
 * updated — which is what makes the recorded verdicts trustworthy, and what the
 * header comment already promised.
 *
 * This deliberately does NOT collapse the duplication into a shared constant.
 * The model must stay independently readable — an audit that imports its subject
 * proves nothing about it. The guard is the seam: two independent statements,
 * mechanically forced to agree.
 */
import { describe, it, expect } from 'vitest';
import { HEALTH_ENDPOINTS, SUPERVISED_PROCESSES } from '../../service-health';
import { PROBED_PORTS, UNIT_TO_PROBE, SUPERVISED_BUT_UNPROBED } from './service';

/**
 * Probes that are real but do NOT come from `HEALTH_ENDPOINTS`, with the reason.
 * Anything here is exempt from the both-directions check below; keep it short
 * and justified, because every entry is a hole in the guard.
 */
const NON_ENDPOINT_PROBES: Record<string, string> = {
  // Opt-in, probed by probeEmbedSidecar() rather than a HEALTH_ENDPOINTS row.
  'embed-sidecar': 'probed by probeEmbedSidecar(), not a HEALTH_ENDPOINTS entry',
  // Portless probes — no URL, so they can never appear in PROBED_PORTS.
  'bg-host-ticker': 'portless probe',
  'bg-host-code': 'portless probe',
  desktop: 'portless probe',
  'substrate-sidecar': 'portless probe',
};

/** The loopback port a HEALTH_ENDPOINTS url targets, if it has one. */
function endpointPort(url: string): string | null {
  const m = /https?:\/\/(?:127\.0\.0\.1|localhost)(?::(\d+))?/.exec(url);
  if (!m) return null;
  return m[1] ?? '80';
}

describe('service.ts equivalence model tracks the real dev:service_health (WI-6153)', () => {
  it('every HTTP-probed HEALTH_ENDPOINTS port appears in PROBED_PORTS under its real name', () => {
    const missing: string[] = [];
    for (const spec of HEALTH_ENDPOINTS) {
      const port = endpointPort(spec.url);
      if (port == null) continue;
      const modelled = PROBED_PORTS[port];
      if (modelled !== spec.name) {
        missing.push(
          `:${port} is probed as '${spec.name}' by HEALTH_ENDPOINTS but PROBED_PORTS says ${
            modelled === undefined ? 'NOTHING probes it' : `'${modelled}'`
          }`,
        );
      }
    }
    expect(
      missing,
      `pairs/service.ts's model has drifted from the real tool. dev:service_health was widened (or renamed) ` +
        `without updating PROBED_PORTS, so the equivalence audit is scoring against a tool that no longer exists ` +
        `and the advisoryText may be telling agents to shell out for something now covered:\n  - ${missing.join(
          '\n  - ',
        )}\nUpdate PROBED_PORTS, re-read the recomputed verdict, and fix advisoryText/routing to match.`,
    ).toEqual([]);
  });

  it('PROBED_PORTS claims nothing the real tool does not probe', () => {
    const realByPort = new Map<string, string>();
    for (const spec of HEALTH_ENDPOINTS) {
      const port = endpointPort(spec.url);
      if (port != null) realByPort.set(port, spec.name);
    }
    const overclaimed = Object.entries(PROBED_PORTS)
      .filter(([port, name]) => realByPort.get(port) !== name && !(name in NON_ENDPOINT_PROBES))
      .map(([port, name]) => `PROBED_PORTS says :${port} → '${name}', but HEALTH_ENDPOINTS does not`);
    expect(
      overclaimed,
      `The model claims coverage the tool does not have — this scores the audit OPTIMISTICALLY and can flip a ` +
        `pair to 'equivalent' on the strength of a probe that was removed:\n  - ${overclaimed.join('\n  - ')}`,
    ).toEqual([]);
  });

  it('UNIT_TO_PROBE maps only to probe names the tool can actually emit', () => {
    const realNames = new Set<string>([
      ...HEALTH_ENDPOINTS.map((s) => s.name),
      ...Object.keys(NON_ENDPOINT_PROBES),
    ]);
    const bogus = Object.entries(UNIT_TO_PROBE)
      .filter(([, probe]) => !realNames.has(probe))
      .map(([unit, probe]) => `${unit} → '${probe}', which is not a probe dev:service_health emits`);
    expect(
      bogus,
      `UNIT_TO_PROBE promises a services[] entry that does not exist, so cover() reports a faithful expression ` +
        `an agent cannot actually evaluate:\n  - ${bogus.join('\n  - ')}`,
    ).toEqual([]);
  });

  it('SUPERVISED_BUT_UNPROBED and UNIT_TO_PROBE are disjoint — a unit cannot be both', () => {
    const both = [...SUPERVISED_BUT_UNPROBED].filter((unit) => unit in UNIT_TO_PROBE);
    expect(
      both,
      `These units are listed as UNPROBED while also having a probe. cover() checks UNIT_TO_PROBE first, so the ` +
        `stale SUPERVISED_BUT_UNPROBED entry is dead — but its REASON STRING is what an agent reads, and it now ` +
        `lies:\n  - ${both.join('\n  - ')}`,
    ).toEqual([]);
  });

  it('every SUPERVISED_BUT_UNPROBED unit is really a systemd row in SUPERVISED_PROCESSES', () => {
    // Guards the other drift direction: a unit renamed/removed from supervision
    // leaves the model asserting things about a unit that no longer exists.
    //
    // Scoped to SUPERVISED_BUT_UNPROBED ON PURPOSE. That set's entire claim is
    // "this is IN the supervision registry yet nothing probes it", so every
    // member must be a real systemd row or the claim is meaningless.
    //
    // UNIT_TO_PROBE is deliberately NOT checked this way: it maps a systemd unit
    // an agent might run `is-active` on to the probe that answers it, and such a
    // unit need not be a systemd-layer registry row at all. `papercup-embed-sidecar`
    // is the live example — `embed-sidecar` IS in SUPERVISED_PROCESSES but as a
    // `node-child` with NO `unit` field, so the registry knows the process and not
    // the unit name. Asserting registry membership there conflates "supervised
    // process" with "systemd unit" and reds on a correct model (it did, first run).
    const supervisedUnits = new Set(
      SUPERVISED_PROCESSES.map((p) => p.unit).filter((u): u is string => Boolean(u)),
    );
    const unknown = [...SUPERVISED_BUT_UNPROBED].filter((unit) => !supervisedUnits.has(unit));
    expect(
      unknown,
      `These units are listed as "supervised but unprobed" yet are not systemd rows in SUPERVISED_PROCESSES — ` +
        `either they were renamed/removed, or the model invented them. Either way cover() is emitting a reason ` +
        `string about a unit that does not exist:\n  - ${unknown.join('\n  - ')}`,
    ).toEqual([]);
  });

  it('staging-api specifically is modelled as PROBED (the WI-6146 regression this file was written for)', () => {
    // A named, non-generic assertion so the specific regression that motivated
    // this file can never silently return, even if the generic checks above are
    // later loosened or exempted.
    expect(PROBED_PORTS['3170']).toBe('staging-api');
    expect(UNIT_TO_PROBE['papercup-staging-api']).toBe('staging-api');
    expect(SUPERVISED_BUT_UNPROBED.has('papercup-staging-api')).toBe(false);
    expect(HEALTH_ENDPOINTS.some((s) => s.name === 'staging-api')).toBe(true);
  });
});
