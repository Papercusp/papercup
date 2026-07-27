'use client';

/**
 * use-su-launch-options — the GUI launcher's option source, which is psu's OWN
 * option source (WI-6321).
 *
 * Owner ask 2026-07-27, and the load-bearing half of the item: "the options in
 * the gui should match the exact same options that the psu utiltiy uses because
 * it should share the same code for getting the options". Not "make the lists
 * look the same" — SHARE the source, so they cannot drift.
 *
 * `GET /api/agent-mcp/console/bootstrap-su/options` is exactly that source:
 * psu-launcher's `fetchFleetChoices` and `fetchAccountChoices` both read it, and
 * its own docblock already describes it as picker data "for the `psu` launcher
 * (and the /adv 'Launch SU' modal)". It was built to be shared; the GUI simply
 * never used the fleet/account halves, which is why a GUI launch could not
 * express either. Reading the same endpoint means a fleet created in a terminal
 * shows up in the GUI picker with the same colour, with no second query to keep
 * in step.
 *
 * The VOCABULARY options that are static rather than live (models, efforts,
 * context sizes, account modes) come from `agent-config-constants`, the
 * client-safe module whose values are pinned to psu-launcher's own menus by the
 * parity suite in apps/operator/lib/psu-launcher.test.ts.
 *
 * Fail-soft by design, matching psu: any error yields empty lists so the picker
 * still renders its "no fleet" / "default account" rows and a launch remains
 * possible. A launcher that refuses to open because a list did not load is worse
 * than one offering the defaults.
 */
import { useCallback, useEffect, useState } from 'react';

/** One curated colour scheme, as the options endpoint serves it. */
export interface FleetColorScheme {
  name: string;
  bg: string;
  fg: string;
  cursor: string;
}

/** A durable named fleet the workspace offers (agent_fleets row). Persists even
 *  with zero live members (named-su-agent-fleets D-003). */
export interface FleetChoice {
  slug: string;
  title: string | null;
  scheme: string | null;
  color: FleetColorScheme;
}

/** A pool account the gateway offers. Empty unless the gateway is on — the
 *  endpoint hides the pool otherwise (resolveAccountChoices). */
export interface AccountChoice {
  id: string;
  label?: string | null;
  detail?: string | null;
}

export interface SuLaunchOptions {
  fleets: FleetChoice[];
  /** The colour a NEW fleet would be allocated — lets the create row preview the
   *  colour it will actually get (the server re-derives the same one). */
  nextScheme: FleetColorScheme | null;
  /** The full curated catalog, for the new-fleet colour picker. */
  schemes: FleetColorScheme[];
  accounts: AccountChoice[];
  loading: boolean;
  error: string | null;
  /** Re-read after a launch creates a fleet, so the new one appears without a reload. */
  refresh: () => void;
}

const EMPTY: Omit<SuLaunchOptions, 'loading' | 'error' | 'refresh'> = {
  fleets: [],
  nextScheme: null,
  schemes: [],
  accounts: [],
};

/**
 * Normalize the endpoint's `accounts` payload into a flat choice list. The shape
 * has varied across the account-routing work (a bare array, or `{ pool: [...] }`
 * as psu's `promptAccount` receives it), so both are accepted rather than
 * assuming one — an unexpected shape degrades to "no pool accounts", never a
 * crash that takes the whole launcher down.
 */
export function normalizeAccountChoices(raw: unknown): AccountChoice[] {
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { pool?: unknown })?.pool)
      ? (raw as { pool: unknown[] }).pool
      : [];
  return list
    .map((a): AccountChoice | null => {
      if (typeof a === 'string') return { id: a };
      if (a && typeof a === 'object') {
        const o = a as Record<string, unknown>;
        const id = typeof o.id === 'string' ? o.id : typeof o.value === 'string' ? o.value : null;
        if (!id) return null;
        return {
          id,
          label: typeof o.label === 'string' ? o.label : typeof o.name === 'string' ? o.name : null,
          detail: typeof o.detail === 'string' ? o.detail : null,
        };
      }
      return null;
    })
    .filter((a): a is AccountChoice => a !== null);
}

export function useSuLaunchOptions(workspaceId?: string | null, agent = 'claude'): SuLaunchOptions {
  const [state, setState] = useState(EMPTY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams();
    if (workspaceId) params.set('workspace', workspaceId);
    // The pool is per-backend (pinning is claude/codex only), so the endpoint
    // wants to know which agent is being launched — same param psu sends.
    if (agent) params.set('agent', agent);
    const qs = params.toString();
    setLoading(true);
    fetch(`/api/agent-mcp/console/bootstrap-su/options${qs ? `?${qs}` : ''}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data: Record<string, unknown>) => {
        if (cancelled) return;
        setState({
          fleets: Array.isArray(data.fleets) ? (data.fleets as FleetChoice[]) : [],
          nextScheme: (data.nextScheme as FleetColorScheme | null) ?? null,
          schemes: Array.isArray(data.schemes) ? (data.schemes as FleetColorScheme[]) : [],
          accounts: normalizeAccountChoices(data.accounts),
        });
        setError(null);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        // Fail-soft (see the header): keep the defaults usable.
        setState(EMPTY);
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, agent, tick]);

  return { ...state, loading, error, refresh };
}
