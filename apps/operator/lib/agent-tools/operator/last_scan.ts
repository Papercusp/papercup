/**
 * operator:last_scan — most-recent scan snapshot, lifecycle-merged.
 *
 * Wraps the same logic as GET /api/agent-mcp/operator-last-scan: reads
 * the persisted last-scan plus reconstructs each card's current state
 * (dispatched / dismissed / consumed / …) by replaying audit_log
 * lifecycle events. The legacy route stays for the operator UI's
 * `fetch('/api/agent-mcp/operator-last-scan')` callers; this tool gives
 * agents the same view via MCP.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { readLastScan } from '@/lib/operator-last-scan';
import { reconstructCards } from '@/lib/operator-card-reconstruction';

const ALL_ROLES = [
  'scoper',
  'architect',
  'worker',
  'validator',
  'reviewer',
  'debugger',
  'operator',
  'documenter',
  'curator',
] as const;

export default defineTool({
  name: 'operator:last_scan',
  description: 'Most-recent operator scan snapshot, with each card merged with its current lifecycle state from audit_log.',
  capability: 'operator:read',
  requirePrincipal: false,
  roles: [...ALL_ROLES],
  args: z.object({}),
  async handler() {
    const last = await readLastScan();
    const reconstructed = await reconstructCards();
    if (!reconstructed.length) {
      const snapshot = last
        ? { cards: last.cards, scanCompletedAt: last.scanCompletedAt }
        : null;
      return {
        content: [{ type: 'text', text: JSON.stringify({ snapshot }) }],
      };
    }
    const snapshot = {
      cards: reconstructed.map((c) => ({
        ...c.payload,
        _status: c.status,
        _dispatchedAt: c.dispatchedAt,
        _ackedAt: c.ackedAt,
        _undoCancelled: c.undoCancelled,
      })),
      scanCompletedAt: last?.scanCompletedAt ?? null,
    };
    return {
      content: [{ type: 'text', text: JSON.stringify({ snapshot }) }],
    };
  },
});
