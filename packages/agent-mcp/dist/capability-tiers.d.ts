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
 * Look up the tier for a capability string. Returns `medium` when no
 * deliberate classification is found — see file header.
 */
export declare function tierFor(capability: string): CapabilityTier;
