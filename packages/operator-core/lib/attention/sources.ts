/**
 * Pure source transforms for plans:attention (P-011).
 *
 * The tool fetches raw records (I/O) and hands them to these pure
 * mappers — split out so the composition (filter + adapt) is unit-
 * testable against the real parser without a ctx, PG, or coord log.
 */

import { resolveEffectiveStatus, type ParsedPlan } from '@papercusp/plan-parser';
import { planItemToAttention } from './adapters';
import type { AttentionItem } from './types';

/**
 * Map the non-terminal items of already-parsed plans to AttentionItems —
 * the plan-item source of plans:attention. Skips legacy plans and any
 * item that is `done`/`dropped` by stored OR effective status (a
 * blocker dropped upstream un-gates its dependents, which then surface).
 */
export function planItemsToAttention(
  plans: readonly { parsed: ParsedPlan }[],
  harnessSlug: string | null,
): AttentionItem[] {
  const out: AttentionItem[] = [];
  for (const { parsed } of plans) {
    if (parsed.isLegacy) continue;
    const slug = parsed.frontmatter.slug ?? parsed.slug;
    const resolved = resolveEffectiveStatus(parsed);
    for (const it of resolved.items) {
      if (it.storedStatus === 'done' || it.storedStatus === 'dropped') continue;
      if (it.effectiveStatus === 'done' || it.effectiveStatus === 'dropped') continue;
      out.push(
        planItemToAttention({
          slug,
          harnessSlug,
          id: it.id,
          text: it.text,
          storedStatus: it.storedStatus,
          effectiveStatus: it.effectiveStatus,
          importance: it.importance,
        }),
      );
    }
  }
  return out;
}
