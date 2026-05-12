/**
 * Workspace-at-a-glance block.
 *
 * Cheap pre-computed snapshot of "what's in this workspace" — harness
 * list, most-active agents — injected into the system prompt of any
 * chat surface that needs to answer "what do I have?" or open a new
 * conversation with concrete suggestions instead of generic
 * greetings.
 *
 * Used by:
 *   - oracle (always-mounted dock; this block lets it answer 'show me
 *     my harnesses' without a round-trip)
 *   - operator-converse open_canvas trigger (so the operator opens a
 *     fresh chat with 'Sheets is at 28 of 88, want to look at what's
 *     blocked?' instead of 'Hi, what can I help with?')
 *
 * Refreshed every turn; lookups are local PG / file scans so cost is
 * ~10-30ms. Returns the empty string in degraded states (no projects,
 * no agents) so callers can suppress the section cleanly.
 */
import { listAgentsAcrossWorkspace } from '@/lib/agents-list';
import { activeWorkspaceId } from '@/lib/workspace-registry';
import { listPendingReviews, getEscalation, listFeaturesForHarness } from '@/lib/harness-readers';
import { phasePhaseLabel } from '@/lib/harness-phases';

/**
 * Per-harness summary line — the actionable surface area the brain
 * uses to compose concrete suggestions. Each line surfaces:
 *   - features: total / passed / awaiting-review
 *   - pending reviews: count (when > 0)
 *   - escalations: flagged badge (when present)
 * Lines without any actionable signal are dropped so the inventory
 * doesn't pad with empty "sheets: 0/0" noise.
 */
async function buildHarnessSummary(slug: string): Promise<string | null> {
  const phase = phasePhaseLabel(undefined);
  const [featuresR, reviewsR, escalationR] = await Promise.allSettled([
    listFeaturesForHarness(slug, phase),
    listPendingReviews(slug, phase),
    getEscalation(slug, phase),
  ]);
  const features = featuresR.status === 'fulfilled' && featuresR.value.ok ? featuresR.value.data.features : [];
  const reviews = reviewsR.status === 'fulfilled' && reviewsR.value.ok ? reviewsR.value.data.reviews : [];
  const escalation = escalationR.status === 'fulfilled' && escalationR.value.ok ? escalationR.value.data : null;
  const total = features.length;
  const passed = features.filter((f) => f.status === 'passed').length;
  const review = features.filter((f) => f.needs_human_review).length;
  const reviewCount = reviews.length;
  const escalated = !!(escalation?.escalation && String(escalation.escalation).trim());
  if (total === 0 && reviewCount === 0 && !escalated) return null;
  const parts: string[] = [`${slug}: ${passed}/${total} passed`];
  if (review > 0) parts.push(`${review} awaiting review`);
  if (reviewCount > 0) parts.push(`${reviewCount} pending review(s)`);
  if (escalated) parts.push(`⚠ ESCALATED`);
  return `  - ${parts.join(' · ')}`;
}

export async function buildWorkspaceInventoryBlock(): Promise<string> {
  const workspace = activeWorkspaceId();
  const port = process.env.PORT ?? '3055';
  const base = process.env.INTERNAL_API_BASE ?? `http://127.0.0.1:${port}`;
  let projects: Array<{ slug: string; path: string }> = [];
  try {
    const r = await fetch(`${base}/api/harness/projects`);
    if (r.ok) {
      const d = await r.json();
      projects = (d?.projects ?? []).map((p: { slug: string; path: string }) => ({
        slug: p.slug,
        path: p.path,
      }));
    }
  } catch { /* degraded */ }

  let agents: Array<{ slug: string; role: string; chat_count: number; last_active: string | null }> = [];
  try { agents = await listAgentsAcrossWorkspace({ limit: 8 }); } catch { /* degraded */ }

  if (!projects.length && !agents.length) return '';

  // Enriched per-harness summaries — features/reviews/escalations.
  // Suggestions the brain composes from this are now grounded in real
  // actionable state, not just slugs.
  const topProjects = projects.slice(0, 8);
  const summaries = await Promise.all(topProjects.map((p) => buildHarnessSummary(p.slug).catch(() => null)));
  const summaryLines = summaries.filter((s): s is string => !!s);
  // Fallback: harnesses with no actionable state still get a thin
  // line so they're visible.
  const quietLines = topProjects
    .filter((_, i) => summaries[i] == null)
    .map((p) => `  - ${p.slug}: (no activity)`);

  const agentLines = agents.map((a) => {
    const ago = a.last_active
      ? `${Math.round((Date.now() - new Date(a.last_active).getTime()) / 60000)}m ago`
      : 'idle';
    return `  - ${a.slug}/${a.role} (${a.chat_count} chats, ${ago})`;
  });

  const harnessSection = [...summaryLines, ...quietLines];

  return [
    '\n\n## Workspace at a glance',
    `\nWorkspace: ${workspace}`,
    harnessSection.length
      ? `\nHarnesses (${projects.length}${projects.length > 8 ? ', showing 8' : ''}):\n${harnessSection.join('\n')}`
      : '',
    agentLines.length ? `\nMost-active agents:\n${agentLines.join('\n')}` : '',
    '\n\nThis is a snapshot. Use these specific facts to compose suggestions; for deeper info call `harness:list` / `harness:status` / `harness:escalation`.',
  ].join('');
}
