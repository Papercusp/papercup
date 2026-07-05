import { createFileRoute, isRedirect, redirect } from '@tanstack/react-router';
import { FLAGS, FLAG_DEFAULTS } from '@papercusp/flags';
import { getFlagSnapshot, loadFlags } from '@papercusp/flags/client';
import { fetchWithTimeout } from '../lib/route-fetch';

/**
 * Root route — gateways the desktop's first-run experience.
 *
 * Translated from `apps/operator/app/page.tsx`. The original was a server
 * component that called `readOperatorState('setup_wizard_state')` directly
 * and redirected via `next/navigation`'s `redirect()`. Under Vite/SPA there
 * is no server render, so we fetch the same state via the public-API
 * endpoint `/api/desktop/setup-wizard-state` (port of the same DB read,
 * `apps/operator/lib/endpoint-route/routes/desktop/setup-wizard-state.ts`)
 * inside `beforeLoad` and throw a TSR redirect.
 *
 * Behavior parity with the Next root page:
 *   - If `finished_at` is unset → redirect to `/setup`.
 *   - Otherwise → redirect to `/adv` (the primary surface; `/harness` is
 *     retired as a landing and itself redirects to `/adv`).
 *   - On fetch failure → treat as "wizard not finished" and redirect to
 *     `/setup`. The wizard surface is the safer landing (it gracefully
 *     handles partial PG state); `/harness` assumes a fully-bootstrapped
 *     workspace and would render an empty/broken shell.
 */
/**
 * Where an UNFINISHED first-run lands (agent-first-onboarding-2026-07-03
 * P-003): the agent-chat Onboarding Console when ONBOARDING_AGENT_FIRST is
 * on, else the classic GUI wizard. Pure; exported for tests.
 */
export function firstRunTarget(onboardingAgentFirst: boolean): '/onboarding' | '/setup' {
  return onboardingAgentFirst ? '/onboarding' : '/setup';
}

/** Resolve ONBOARDING_AGENT_FIRST client-side (same pattern as requireFlag). */
async function onboardingFlagEnabled(): Promise<boolean> {
  await loadFlags().catch(() => {
    // flags unreachable → FLAG_DEFAULTS via getFlagSnapshot (default ON)
  });
  const snapshot = getFlagSnapshot();
  return (
    snapshot.flags[FLAGS.ONBOARDING_AGENT_FIRST] ?? FLAG_DEFAULTS[FLAGS.ONBOARDING_AGENT_FIRST]
  );
}

/**
 * A wedged/mid-restart backend used to hang this gateway fetch forever (bare
 * `fetch`, no timeout) → the router stayed `status:'pending'` → blank content
 * under a stuck `bprogress-busy` bar → "desktop isn't launching, it's stalling;
 * needs a manual relaunch" (WI-2817). `fetchWithTimeout` bounds each attempt and
 * retries a transient outage so the app auto-recovers; if the gateway is slow
 * enough to be an actual outage the `pendingComponent` shows an honest
 * "Connecting…" instead of a blank screen (never on the sub-second happy path,
 * gated by `pendingMs`).
 */
export const Route = createFileRoute('/')({
  pendingMs: 700,
  pendingComponent: ConnectingScreen,
  beforeLoad: async () => {
    let res: Response;
    try {
      res = await fetchWithTimeout('/api/desktop/setup-wizard-state', {
        timeoutMs: 4000,
        retries: 2,
        init: { credentials: 'same-origin' },
      });
    } catch {
      // Backend UNREACHABLE after retries (timeout/network). This is the
      // substrate-restart / cold-start blip, NOT a genuine first run — a first
      // run's sidecar is serving this very page, so setup-wizard-state would
      // have answered. A returning user must not be dumped into onboarding by a
      // transient outage, so land on /adv (the primary surface), which
      // reconnects via the resilient transports + OfflineIndicator and recovers
      // WITHOUT a manual relaunch. No response arrived → nothing to swallow.
      throw redirect({ to: '/adv', search: { tab: 'harnesses' } });
    }
    try {
      if (!res.ok) throw redirect({ to: firstRunTarget(await onboardingFlagEnabled()) });
      const state = (await res.json()) as { finished_at?: string };
      if (!state?.finished_at) {
        throw redirect({ to: firstRunTarget(await onboardingFlagEnabled()) });
      }
      // /adv is the operator's primary surface; /harness is retired as a
      // landing (it now redirects here too). Land on the harnesses tab —
      // the mission-control / feature-queue equivalent.
      throw redirect({ to: '/adv', search: { tab: 'harnesses' } });
    } catch (err) {
      // A thrown TSR redirect must propagate; only a malformed/parse failure
      // falls through to the safe first-run landing. TSR `redirect()` returns a
      // `Response` with the navigation options at `err.options.to`, so the
      // old `'to' in err` check incorrectly swallowed every redirect from
      // this beforeLoad — including the success path — and forced /setup.
      if (isRedirect(err)) throw err;
      throw redirect({ to: firstRunTarget(await onboardingFlagEnabled()) });
    }
  },
});

/** Shown only while the first-run gateway fetch is slow (an outage) — past
 *  `pendingMs`. The happy path redirects in well under a second, so this never
 *  flashes on a healthy launch. Honest "loading", not a blank stall. */
function ConnectingScreen() {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '0.6rem',
        height: '100vh',
        width: '100%',
        opacity: 0.65,
        fontSize: '0.9rem',
      }}
    >
      <span>Connecting to Papercusp…</span>
    </div>
  );
}
