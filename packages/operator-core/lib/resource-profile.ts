/**
 * Papercusp binding for @papercusp/resource-profile — inject the two domain
 * signals the generic lib can't sniff, then expose the memoized profile.
 *
 * The generic lib derives every scale cap from raw host signals (cgroup-aware
 * cores + RAM) plus two bits only THIS app knows:
 *
 *  - `embeddedPg`  — does an embedded Postgres share this box? Read from
 *    embedded-pg-discovery: any source OTHER than the native-fallback means the
 *    operator is wired to an embedded/desktop PG that competes for the same
 *    cores/RAM (so the per-core agent budget halves). The native-:5432 fallback
 *    is the dev box / a dedicated DB → not embedded.
 *  - `hostRole`    — does this process run the background machinery (DBOS queues,
 *    drains) or only serve requests? Derived from background-workers.ts: a
 *    utility host (PAPERCUSP_UTILITY_HOST) → 'utility'; a host with background
 *    workers off (the :3170 request-only staging operator) → 'request-only';
 *    otherwise 'full'.
 *
 * Configuration is idempotent and must precede the first profile read; this
 * module configures lazily on first access so any import order is safe.
 *
 * P0 of operator-scalability-event-loop-2026-06-16: the ONE place the host is
 * read; consumers (rate-limit-config seed, future DBOS/pool sizing) read derived
 * caps from here instead of hardcoding for one machine.
 */
import {
  configureResourceProfile,
  getResourceProfile as getGenericResourceProfile,
  type HostRole,
  type ResourceProfile,
} from '@papercusp/resource-profile';
import { getHarnessAdminUrlWithSource } from './embedded-pg-discovery';
import { backgroundWorkersEnabled, utilityHostEnabled } from './background-workers';

/** An embedded/desktop PG shares the box iff the admin URL resolved to anything
 *  other than the native-:5432 fallback (env or discovery-file ⇒ embedded). */
function detectEmbeddedPg(): boolean {
  return getHarnessAdminUrlWithSource().source !== 'native-fallback';
}

/** Map the background-workers gates onto the generic HostRole. */
function detectHostRole(env: NodeJS.ProcessEnv = process.env): HostRole {
  if (utilityHostEnabled(env)) return 'utility';
  return backgroundWorkersEnabled(env) ? 'full' : 'request-only';
}

let configured = false;

/** The memoized Papercusp resource profile. Configures the injected signals on
 *  first access (idempotent), then delegates to the generic memoized singleton. */
export function getResourceProfile(): ResourceProfile {
  if (!configured) {
    configured = true;
    configureResourceProfile({ embeddedPg: detectEmbeddedPg(), hostRole: detectHostRole() });
  }
  return getGenericResourceProfile();
}

export type { ResourceProfile, HostClass, HostRole } from '@papercusp/resource-profile';
