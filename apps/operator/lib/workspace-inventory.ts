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

  const projectLines = projects.slice(0, 6).map((p) => `  - ${p.slug}`);
  const agentLines = agents.map((a) => {
    const ago = a.last_active
      ? `${Math.round((Date.now() - new Date(a.last_active).getTime()) / 60000)}m ago`
      : 'idle';
    return `  - ${a.slug}/${a.role} (${a.chat_count} chats, ${ago})`;
  });

  return [
    '\n\n## Workspace at a glance',
    `\nWorkspace: ${workspace}`,
    projectLines.length
      ? `\nHarnesses (${projects.length}${projects.length > 6 ? ', showing 6' : ''}):\n${projectLines.join('\n')}`
      : '',
    agentLines.length ? `\nMost-active agents:\n${agentLines.join('\n')}` : '',
    '\n\nThis is a snapshot. For deeper info call `harness:list` / `agents:list` / `harness:status`.',
  ].join('');
}
