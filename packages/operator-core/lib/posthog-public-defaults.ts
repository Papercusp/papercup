/**
 * Public PostHog defaults bundled with every Papercusp build. These are
 * the same values that ship in `~/.papercusp/posthog.json` for opt-in
 * users — the `host` and `projectKey` are public client-side credentials
 * (the `phc_*` key is anonymous-capture only; it cannot read events or
 * mutate flag definitions).
 *
 * The flow:
 *   - Public builds get these defaults so a user's opt-in alone is
 *     enough to forward telemetry. No "drop a JSON file" step.
 *   - `~/.papercusp/posthog.json` and `PAPERCUSP_POSTHOG_*` env still
 *     override (admin / dev / CI escape hatch).
 *
 * The admin write-side keys (`personalApiKey`, `webhookSecret`) are NEVER
 * bundled — those live only on maintainer machines / CI secrets.
 */
export const POSTHOG_PUBLIC_DEFAULTS = {
  host: 'https://flags.papercuspai.com',
  projectKey: 'phc_tnwKu5QTgaHi6hyrHwA3EUQFKhskJES4c4zAzHCUrPFv',
} as const;
