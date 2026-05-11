/**
 * Capability-string → tier heuristic for the Operator's plugin-tier
 * resolver (Phase 5 polish — `tier-table.json` only knows substrate
 * caps; plugin caps would otherwise all default to `high` (fail-safe)).
 *
 * The pattern catalog at /docs/endpoint-system/tool-catalog shows clear
 * conventions: `*:read` is read-only, `*:write` mutates, `compute:exec:*`
 * runs code, `secrets:*` is sensitive, etc. We codify those conventions
 * so a fresh plugin install gets a sensible tier without the operator
 * having to walk every plugin's manifest.
 *
 * Pure function — no I/O. Safe to call sync from the suggestion parser.
 *
 * Matching is in priority order: the first rule that matches wins.
 * High-risk patterns are listed first so they can't be overridden by
 * a downstream `:read` suffix. (For example `secrets:operator-credentials:read`
 * matches `secrets:*` first and stays `high`.)
 */

import type { CapabilityTier } from '@papercusp/plugin-sdk';

interface Rule {
  match: RegExp;
  tier: CapabilityTier;
  reason: string;
}

const RULES: Rule[] = [
  // ── HIGH (sensitive / destructive / network egress to arbitrary hosts) ──
  { match: /^secrets:/, tier: 'high', reason: 'reads/writes secret material' },
  { match: /^compute:exec:/, tier: 'high', reason: 'runs arbitrary code' },
  { match: /^processes:/, tier: 'high', reason: 'process control (kill, etc.)' },
  { match: /^harness:dispatch:/, tier: 'high', reason: 'dispatches a role into another harness' },
  { match: /^pending_events:write/, tier: 'high', reason: 'enqueues into the orchestrator event bus' },
  { match: /^http:fetch:/, tier: 'medium', reason: 'network egress to a specific host' },
  { match: /^db:write:/, tier: 'medium', reason: 'writes to a substrate-managed table' },
  { match: /^fs:write:/, tier: 'medium', reason: 'writes to the filesystem' },
  { match: /^plugins:write/, tier: 'medium', reason: 'mutates plugin runtime state' },
  { match: /^autoloop:write/, tier: 'medium', reason: 'changes the orchestrator autoloop state' },
  { match: /^omp:write/, tier: 'medium', reason: 'mutates omp/CLI config' },

  // ── Patterned suffixes (after the high-risk prefixes above so they
  // don't accidentally downgrade a sensitive capability) ──
  { match: /:write(?::|$)/, tier: 'medium', reason: 'mutates state' },
  { match: /:read(?::|$)/, tier: 'low', reason: 'read-only' },
  { match: /:list$/, tier: 'low', reason: 'enumeration' },
  { match: /:get$/, tier: 'low', reason: 'single read' },

  // ── Tool families that the catalog groups but which don't follow the
  //   prefix conventions. We classify them based on observed behavior. ──
  { match: /^tools:design:(submit|record|validate|lint)/, tier: 'medium', reason: 'design-system mutation' },
  { match: /^tools:design:/, tier: 'low', reason: 'design-system read' },
  { match: /^tools:gitnexus:(rename|.*sync|api_impact|impact|detect_changes)/, tier: 'medium', reason: 'gitnexus mutation' },
  { match: /^tools:gitnexus:/, tier: 'low', reason: 'gitnexus query' },
  { match: /^tools:firecrawl:/, tier: 'medium', reason: 'web scraping (egress + cost)' },
  { match: /^tools:web:fetch/, tier: 'medium', reason: 'web fetch' },
  { match: /^tools:repomix:/, tier: 'low', reason: 'local pack' },
  { match: /^tools:code2prompt:/, tier: 'low', reason: 'local pack' },
  { match: /^tools:orchestrator:spawn:/, tier: 'high', reason: 'spawns another agent' },

  // ── Single-token convenience caps ──
  { match: /^hindsight:recall$/, tier: 'low', reason: 'memory recall' },
  { match: /^search:/, tier: 'low', reason: 'search query' },
  { match: /^audit:/, tier: 'low', reason: 'audit-log read' },
];

export interface HeuristicResult {
  tier: CapabilityTier;
  reason: string;
}

/**
 * Classify a capability by pattern. Returns null when no rule matches —
 * the caller should fall back to the substrate fail-safe (`high`).
 */
export function heuristicTier(capability: string): HeuristicResult | null {
  for (const rule of RULES) {
    if (rule.match.test(capability)) {
      return { tier: rule.tier, reason: rule.reason };
    }
  }
  return null;
}
