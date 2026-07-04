/**
 * Wire tooldef's result-annotator seam to Papercusp's BANDED context-usage gauge
 * (agent-managed-compaction-2026-07-01 P-013 / D-009 — the L1 ambient-awareness layer).
 *
 * `@papercusp/tooldef`'s dispatch invoke-step calls the host-registered annotator on
 * EVERY settled result; the default is a no-op (the library can't see host presence /
 * identity). The HOST owns the policy, so the annotator is registered HERE — imported as
 * a side-effect at startup (see `agent-tools/index.ts`), the same shape as
 * `delta-flag-wiring.ts`.
 *
 * The gauge: resolve the caller's coord identity → read its usage from the in-process
 * cache the compaction watchdog populates (ZERO per-call DB) → render the banded line →
 * append it to the result envelope (a text block + `_meta._contextGauge`). Self-gates to
 * nothing for: an unattributable ctx (system/internal call), an owner the watchdog isn't
 * tracking (no cache entry), a session below the QUIET band (<65% — the common case, so
 * most calls append nothing), or a result that already carries a `context:` line (the
 * coord:inbox usage line — never double-render). NEVER throws (the tooldef seam also
 * swallows), so a gauge fault can't fail a tool call.
 *
 * Runtime kill-switch: FLAGS.CONTEXT_GAUGE (default ON). The annotator is on a SYNC hot
 * path, so it reads a mirror the watchdog refreshes from the flag each 2-min pass rather
 * than paying an async flag read per call (see context-usage-cache.ts).
 */

import { setResultAnnotator, type ResultAnnotator } from '@papercusp/agent-mcp';
import { resolveAgentIdentity, type ResolveIdentityCtx } from './coordination/identity';
import { renderBandedContextGauge } from './coordination/tools/inbox-context-usage';
import {
  getContextUsage,
  isContextGaugeEnabled,
} from '../system-health/context-usage-cache';

/** The tool-result shape, derived from the annotator signature (no extra import). */
type AnnotatedResult = Parameters<ResultAnnotator>[0];

/** A rendered `context: N/L (X%)` usage line already present in the result (coord:inbox). */
const CONTEXT_LINE_RE = /context: \d+\/\d+ \(\d+%\)/;

function resultCarriesContextLine(result: AnnotatedResult): boolean {
  return (
    result.content?.some((c) => c.type === 'text' && CONTEXT_LINE_RE.test(c.text)) ?? false
  );
}

const contextGaugeAnnotator: ResultAnnotator = (result, ctx) => {
  if (!isContextGaugeEnabled()) return result;
  let ownerId: string;
  try {
    ownerId = resolveAgentIdentity(ctx as unknown as ResolveIdentityCtx).ownerId;
  } catch {
    return result; // unattributable ctx (system / in-process call) — no gauge
  }
  const usage = getContextUsage(ownerId);
  if (!usage) return result; // owner not tracked / estimate stale
  const line = renderBandedContextGauge(usage.tokens, usage.limit);
  if (!line) return result; // below the quiet band — silent
  if (resultCarriesContextLine(result)) return result; // don't double-render (coord:inbox)
  return {
    ...result,
    _meta: { ...(result._meta ?? {}), _contextGauge: line },
    content: [...result.content, { type: 'text' as const, text: line }],
  };
};

setResultAnnotator(contextGaugeAnnotator);
