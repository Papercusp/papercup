/**
 * Capability tier lookup per spec/capabilities §10.6.1.
 *
 * Tiers are a property of the capability namespace, not configurable per
 * install. New capabilities default to `medium` if not enumerated; that is
 * deliberate — adding a capability without a deliberate tier choice should
 * raise an eyebrow at install time, not silently land at low.
 */

import type { CapabilityTier } from './types';

/**
 * Exact-match table. Wildcards (`secrets:read:*`) are matched by prefix
 * after this lookup misses.
 */
const EXACT: Record<string, CapabilityTier> = {
  // Low — internal reads, UI mounts, plugin-private storage
  'tasks:read': 'low',
  'features:read': 'low',
  'goals:read': 'low',
  'projects:read': 'low',
  'comments:read': 'low',
  'issues:read': 'low',
  'harness:read': 'low',
  'messages:read': 'low',
  'pending_events:read': 'low',
  'routines:read': 'low',
  'storage:plugin-private': 'low',
  'db:plugin-schema': 'low',
  'ui:dashboard-tab': 'low',
  'ui:sidebar-item': 'low',
  'ui:harness-route': 'low',
  // Medium — writes, hooks, role registrations, cross-harness messaging
  'tasks:write': 'medium',
  'features:write': 'medium',
  'goals:write': 'medium',
  'projects:write': 'medium',
  'comments:write': 'medium',
  'issues:write': 'medium',
  'messages:write': 'medium',
  'routines:write': 'medium',
  'proposals:write': 'medium',
  'hindsight:recall': 'medium',
  'search:read': 'medium',
  // High — secrets, outbound network, cross-plugin reads, audit, dispatch wildcards
  'audit:read': 'high',
  'harness:dispatch': 'high',
  'hindsight:retain': 'high',
};

const PREFIX_HIGH = ['secrets:', 'http:fetch:', 'data:read:'];
const PREFIX_MEDIUM = ['events:', 'roles:register:'];

/**
 * Look up the tier for a capability string. Returns `medium` when no
 * deliberate classification is found — see file header.
 */
export function tierFor(capability: string): CapabilityTier {
  if (EXACT[capability]) return EXACT[capability]!;
  for (const p of PREFIX_HIGH) {
    if (capability.startsWith(p)) return 'high';
  }
  for (const p of PREFIX_MEDIUM) {
    if (capability.startsWith(p)) return 'medium';
  }
  return 'medium';
}
