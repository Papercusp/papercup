import { createFileRoute, isRedirect, redirect } from '@tanstack/react-router';

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
export const Route = createFileRoute('/')({
  beforeLoad: async () => {
    try {
      const res = await fetch('/api/desktop/setup-wizard-state', {
        credentials: 'same-origin',
      });
      if (!res.ok) throw redirect({ to: '/setup' });
      const state = (await res.json()) as { finished_at?: string };
      if (!state?.finished_at) throw redirect({ to: '/setup' });
      // /adv is the operator's primary surface; /harness is retired as a
      // landing (it now redirects here too). Land on the harnesses tab —
      // the mission-control / feature-queue equivalent.
      throw redirect({ to: '/adv', search: { tab: 'harnesses' } });
    } catch (err) {
      // A thrown TSR redirect must propagate; only network failures fall
      // through to the safe-default landing. TSR `redirect()` returns a
      // `Response` with the navigation options at `err.options.to`, so the
      // old `'to' in err` check incorrectly swallowed every redirect from
      // this beforeLoad — including the success path to `/harness` — and
      // forced every load to `/setup`.
      if (isRedirect(err)) throw err;
      throw redirect({ to: '/setup' });
    }
  },
});
