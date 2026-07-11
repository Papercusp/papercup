/**
 * context-gauge-annotator — the PURE result annotator for Papercusp's banded
 * context-usage gauge (agent-managed-compaction-2026-07-01 P-013 / D-009 L1).
 *
 * Split out of the registration side-effect (context-gauge-wiring.ts) so the annotator
 * logic is unit-testable WITHOUT pulling in the `@papercusp/agent-mcp` bootstrap graph —
 * the same pure/presentation split as inbox-context-usage.ts. It imports the
 * `ResultAnnotator` type only (`import type`, fully erased), so at runtime it depends on
 * just identity + the in-process cache + the renderer.
 *
 * Behaviour: resolve the caller's coord identity → read its usage from the cache the
 * compaction watchdog populates (ZERO per-call DB) → render the banded line → append it
 * to the envelope (a text block + `_meta._contextGauge`). Self-gates to nothing for an
 * unattributable ctx, an untracked owner, a below-quiet-band percent, a disabled flag, or
 * a result that already carries a `context:` line (coord:inbox — never double-render).
 */

import type { ResultAnnotator } from '@papercusp/agent-mcp';
import { resolveAgentIdentity, type ResolveIdentityCtx } from './coordination/identity';
import { renderBandedContextGauge } from './coordination/tools/inbox-context-usage';
import {
  getContextUsage,
  isContextGaugeEnabled,
} from '../system-health/context-usage-cache';
import { gaugeNeedsVerification } from '../system-health/context-estimate-verify';

/** The tool-result shape, derived from the annotator signature (no extra import). */
type AnnotatedResult = Parameters<ResultAnnotator>[0];

/** A rendered `context: N/L (X%)` usage line already present in the result (coord:inbox). */
const CONTEXT_LINE_RE = /context: \d+\/\d+ \(\d+%\)/;

function resultCarriesContextLine(result: AnnotatedResult): boolean {
  return (
    result.content?.some((c) => c.type === 'text' && CONTEXT_LINE_RE.test(c.text)) ?? false
  );
}

export const contextGaugeAnnotator: ResultAnnotator = (result, ctx) => {
  if (!isContextGaugeEnabled()) return result;
  let ownerId: string;
  try {
    ownerId = resolveAgentIdentity(ctx as unknown as ResolveIdentityCtx).ownerId;
  } catch {
    return result; // unattributable ctx (system / in-process call) — no gauge
  }
  const usage = getContextUsage(ownerId);
  if (!usage) return result; // owner not tracked / estimate stale
  // WI-4154 verify-before-alarm: an alarm-band cached reading may be stale across a
  // compaction boundary — suppress it and kick a background transcript re-derive
  // (this annotator is a sync hot path and cannot await one); the corrected value
  // renders from the next call on, so a REAL alarm is delayed by at most one result.
  if (gaugeNeedsVerification(ownerId, usage.tokens, usage.limit)) return result;
  const line = renderBandedContextGauge(usage.tokens, usage.limit);
  if (!line) return result; // below the quiet band — silent
  if (resultCarriesContextLine(result)) return result; // don't double-render (coord:inbox)
  return {
    ...result,
    _meta: { ...(result._meta ?? {}), _contextGauge: line },
    content: [...result.content, { type: 'text' as const, text: line }],
  };
};
