/**
 * Cupboard server base-URL resolution (relocated from the retired
 * per-harness publish route — comb-retire-per-harness-sharing-2026-06-11 P-006).
 *
 *   - PAPERCUSP_CUPBOARD_URL env var if set (override / self-host)
 *   - else 'https://cupboard.papercusp.com' (canonical hostname per 2026-05-26 deploy)
 */

export const DEFAULT_CUPBOARD_URL = 'https://cupboard.papercusp.com';

export function resolveCupboardBaseUrl(): string {
  const env = process.env.PAPERCUSP_CUPBOARD_URL;
  return env && env.trim() ? env.trim().replace(/\/+$/, '') : DEFAULT_CUPBOARD_URL;
}
