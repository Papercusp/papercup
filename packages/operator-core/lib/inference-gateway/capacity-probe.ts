/**
 * capacity-probe.ts — the UPSTREAM ground-truth probe for an account's unified budget windows
 * (plan gateway-clamp-advisory-capacity-probe-2026-07-09, P-001).
 *
 * THE GAP THIS CLOSES. The account-pool projection (`rate.utilization7d` / `windowResetAt7d`) is the
 * signal `drainUtil7d()` → `usageWalled` → `accountFull` → spawn-eligibility all read. It is written in
 * exactly ONE place: `makeAccountWindowRecorder` (launch.ts), off the response headers of a LIVE request
 * routed through that account. `drainUtil7d` self-heals on either (a) the projected reset passing, or
 * (b) a fresh sub-cap reading.
 *
 * But a WALLED account is routed no traffic — so it sees no responses, so it gets no fresh reading, so it
 * stays walled until its PROJECTED reset. Nothing in the tree ever re-asks upstream "what is my real
 * budget?". That is a chicken-and-egg: an account whose window ACTUALLY reset (an upstream/plan change, a
 * support credit, a mis-parsed `unified-7d-reset` header) stays stranded for DAYS on a stale projection,
 * and the ONLY levers were `accounts:reset-rate` — which deliberately PRESERVES the windows
 * (`recordAccountReset`, account-pool.ts) and so structurally cannot unwall — or waiting.
 *
 * THE KEY FACT THAT MAKES THIS CHEAP: `anthropic-ratelimit-unified-*` headers ride on 200s, not only 429s
 * (see `parseUnifiedWindow`). So ONE minimal request per account yields authoritative budget state. Even
 * better, a 429 is equally informative — it CONFIRMS a real wall and carries the true reset. So we record
 * the headers off ANY HTTP response and only treat a TRANSPORT failure as "no signal".
 *
 * EVIDENCE BEFORE FORCE (plan D-001). This probe exists so an unwall can be JUSTIFIED rather than
 * asserted. `accounts:reset-rate { resetWindows }` is the deliberate override for when the probe cannot
 * run; this is the detector that should make reaching for it rare. A genuine `utilization7d: 1.0` staying
 * walled is CORRECT behavior — forcing it just makes the fleet hammer a capped account into real 429s.
 *
 * OUT-OF-PROCESS BY DESIGN (plan D-002). This module talks to upstream directly through the account's own
 * egress + credential — it does NOT go through the running :8788 gateway. So it works against a gateway
 * that is wedged, walled, or (as on 2026-07-09) too old to have the routes you need, with no restart. The
 * in-gateway periodic self-heal calls this same code path.
 *
 * PURE-CORE + INJECTED DEPS, mirroring `egress-probe.ts`: `parseCapacityHeaders` is a pure
 * header→projection map (trivially unit-testable), and every I/O edge (fetch, credential resolve,
 * dispatcher build) is a `deps` seam, so the probe is testable with zero network.
 */
import type { AccountEgress, ClaudeAccount } from '../deployment/account-pool';
import { parseUnifiedWindow, parseUnified7dWindow } from './gateway';
import { withOAuthBeta } from './credential-store';

/** Upstream root. Mirrors gateway.ts DEFAULT_UPSTREAM; env-tunable for a staging/mock upstream. */
const UPSTREAM = process.env.PAPERCUSP_GATEWAY_UPSTREAM || 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';
/** The cheapest model that still returns the unified budget headers. Env-tunable in case the id moves. */
export const CAPACITY_PROBE_MODEL = process.env.PAPERCUSP_CAPACITY_PROBE_MODEL || 'claude-haiku-4-5';
/** A probe must never hang a sweep. Short — we only need response HEADERS, never the body. */
const PROBE_TIMEOUT_MS = Number(process.env.PAPERCUSP_CAPACITY_PROBE_TIMEOUT_MS) || 15_000;
/** Bound the fan-out so an 8-account sweep doesn't open 8 simultaneous proxy connections. */
const PROBE_CONCURRENCY = Number(process.env.PAPERCUSP_CAPACITY_PROBE_CONCURRENCY) || 3;

/** The unified-window projection a probe recovered from upstream response headers. */
export interface CapacityWindows {
  utilization?: number;
  windowResetAt?: number;
  utilization7d?: number;
  windowResetAt7d?: number;
}

export interface CapacityProbeResult {
  accountId: string;
  /** True when we got an HTTP response carrying at least one unified header — i.e. a usable reading.
   *  A 429 counts: it CONFIRMS a wall and carries the real reset. Only transport failures are `false`. */
  ok: boolean;
  /** Upstream HTTP status, when a response was received at all. */
  status?: number;
  /** What upstream says RIGHT NOW. Empty when `ok` is false. */
  windows: CapacityWindows;
  /** The projection as it stood BEFORE this probe — the evidence half of a before/after. */
  before: CapacityWindows;
  /** True when upstream's 7d reading is materially below the stored one ⇒ the stored wall was STALE. */
  unwalls: boolean;
  /** Transport/credential failure detail. Non-fatal: one bad account never fails the sweep. */
  error?: string;
}

export interface CapacityProbeDeps {
  fetchImpl?: typeof fetch;
  /** Resolve a bearer token for the account's credentialRef. Injected in tests. */
  resolveToken?: (account: ClaudeAccount) => Promise<string>;
  /** Build the per-account egress dispatcher (per-account IP). Injected in tests. */
  buildDispatcher?: (egress: AccountEgress | undefined) => Promise<unknown>;
  now?: () => number;
}

/**
 * PURE: upstream response headers → the unified-window projection. Delegates to the SAME parsers the
 * gateway's live recorder uses (`parseUnifiedWindow` / `parseUnified7dWindow`) so a probe reading and a
 * live-traffic reading can never diverge in interpretation.
 */
export function parseCapacityHeaders(h: Record<string, string | undefined>): CapacityWindows {
  return { ...parseUnifiedWindow(h), ...parseUnified7dWindow(h) };
}

/** The stored projection, as `CapacityWindows`. */
export function storedWindows(a: ClaudeAccount): CapacityWindows {
  const r = a.rate;
  return {
    utilization: r.utilization,
    windowResetAt: r.windowResetAt,
    utilization7d: r.utilization7d,
    windowResetAt7d: r.windowResetAt7d,
  };
}

/** How far below the stored reading upstream must be before we call the stored wall STALE. Matches the
 *  `significant` epsilon the live recorder uses, so probe + traffic agree on what counts as a real move. */
export const UNWALL_EPSILON = 0.03;

/**
 * PURE: did this probe prove the stored projection was a STALE wall? True only when the stored 7d (or 5h)
 * reading was at/over the drain-full threshold AND upstream now reports materially lower. Deliberately
 * conservative — a probe that merely FAILS never unwalls anything.
 */
export function provesUnwall(before: CapacityWindows, now: CapacityWindows, fullUtil: number): boolean {
  const wasWalled = (before.utilization7d ?? 0) >= fullUtil || (before.utilization ?? 0) >= fullUtil;
  if (!wasWalled) return false;
  const u7 = now.utilization7d;
  const u5 = now.utilization;
  const freed7 = u7 !== undefined && u7 < (before.utilization7d ?? 1) - UNWALL_EPSILON;
  const freed5 = u5 !== undefined && u5 < (before.utilization ?? 1) - UNWALL_EPSILON;
  return freed7 || freed5;
}

/** The egress this account actually routes through: the FIRST pool entry (the gateway's rotation head)
 *  falling back to the singular legacy `egress`. An empty `{}` pool entry means the box-default IP. */
export function probeEgressFor(a: ClaudeAccount): AccountEgress | undefined {
  const pool = a.egressPool;
  if (pool && pool.length > 0) return pool[0];
  return a.egress;
}

/**
 * Probe ONE account's live budget windows. Never throws — a credential/transport failure is captured on
 * the result so a sweep over N accounts always returns N rows.
 *
 * We send the smallest possible VALID request (1 output token, a one-char prompt). The response BODY is
 * irrelevant and never read; only headers matter. A 4xx/429 still carries the unified headers, so we treat
 * ANY HTTP response as signal and only a thrown transport error as "no reading".
 */
export async function probeAccountCapacity(
  account: ClaudeAccount,
  deps: CapacityProbeDeps = {},
  fullUtil = 0.97,
): Promise<CapacityProbeResult> {
  const before = storedWindows(account);
  const base: Omit<CapacityProbeResult, 'ok' | 'windows' | 'unwalls'> = { accountId: account.id, before };
  try {
    const fetchImpl = deps.fetchImpl ?? fetch;
    const resolveToken =
      deps.resolveToken ??
      (async (a: ClaudeAccount) => {
        const { makeCredentialResolver } = await import('./credential-store');
        return makeCredentialResolver(a.credentialRef, a.id).current();
      });
    const buildDispatcher =
      deps.buildDispatcher ??
      (async (eg: AccountEgress | undefined) => {
        const { buildEgressDispatcher } = await import('./egress-dispatcher');
        return (await buildEgressDispatcher(eg)).dispatcher;
      });

    const token = await resolveToken(account);
    const dispatcher = await buildDispatcher(probeEgressFor(account));

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), PROBE_TIMEOUT_MS);
    timer.unref?.();
    let res: Response;
    try {
      res = await fetchImpl(`${UPSTREAM}/v1/messages`, {
        method: 'POST',
        signal: ac.signal,
        headers: {
          'content-type': 'application/json',
          'anthropic-version': ANTHROPIC_VERSION,
          'anthropic-beta': withOAuthBeta(null),
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          model: CAPACITY_PROBE_MODEL,
          max_tokens: 1,
          messages: [{ role: 'user', content: '.' }],
        }),
        // undici honours `dispatcher` on the RequestInit; the DOM lib type doesn't know it.
        ...(dispatcher ? ({ dispatcher } as Record<string, unknown>) : {}),
      } as RequestInit);
    } finally {
      clearTimeout(timer);
    }
    // Drain the body so the socket releases cleanly — we never inspect it.
    void res.text().catch(() => undefined);

    const h: Record<string, string | undefined> = {};
    res.headers.forEach((v, k) => {
      h[k.toLowerCase()] = v;
    });
    const windows = parseCapacityHeaders(h);
    const sawHeader = Object.keys(windows).length > 0;
    return {
      ...base,
      ok: sawHeader,
      status: res.status,
      windows,
      unwalls: sawHeader && provesUnwall(before, windows, fullUtil),
      ...(sawHeader
        ? {}
        : { error: `HTTP ${res.status} carried no anthropic-ratelimit-unified-* header` }),
    };
  } catch (e) {
    return { ...base, ok: false, windows: {}, unwalls: false, error: (e as Error).message };
  }
}

/** Should this account be probed under `walledOnly`? Pure, so the selection rule is unit-testable. */
export function isWalledCandidate(a: ClaudeAccount, fullUtil: number): boolean {
  const r = a.rate;
  return (r.utilization7d ?? 0) >= fullUtil || (r.utilization ?? 0) >= fullUtil;
}

/**
 * Probe MANY accounts with bounded concurrency. `claude` provider only — the unified-window dialect is a
 * Claude Max subscription thing; a `codex` account has no such headers and is skipped, never errored.
 */
export async function probeCapacityForAccounts(
  accounts: ClaudeAccount[],
  opts: { walledOnly?: boolean; fullUtil?: number } = {},
  deps: CapacityProbeDeps = {},
): Promise<CapacityProbeResult[]> {
  const fullUtil = opts.fullUtil ?? 0.97;
  const targets = accounts
    .filter((a) => (a.provider ?? 'claude') === 'claude')
    .filter((a) => !opts.walledOnly || isWalledCandidate(a, fullUtil));

  const out: CapacityProbeResult[] = [];
  const queue = [...targets];
  const workers = Array.from({ length: Math.min(PROBE_CONCURRENCY, Math.max(1, queue.length)) }, async () => {
    for (;;) {
      const a = queue.shift();
      if (!a) return;
      out.push(await probeAccountCapacity(a, deps, fullUtil));
    }
  });
  await Promise.all(workers);
  // Stable order for a legible report / deterministic tests.
  const rank = new Map(targets.map((a, i) => [a.id, i]));
  out.sort((x, y) => (rank.get(x.accountId) ?? 0) - (rank.get(y.accountId) ?? 0));
  return out;
}
