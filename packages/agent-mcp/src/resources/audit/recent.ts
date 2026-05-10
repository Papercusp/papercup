/**
 * `papercusp://workspace/audit/recent` — last 100 audit log entries.
 *
 * High-tier capability gate (audit:read) — same trust boundary as the
 * `audit:list` tool. Read-only snapshot of `harness_shared.audit_log`.
 */

import { defineResource } from '../../define-resource';
import type { ResourceContents } from '../../types';

export default defineResource({
  name: 'audit:recent',
  uri: 'papercusp://workspace/audit/recent',
  capability: 'audit:read',
  mimeType: 'application/json',
  description:
    'Most-recent 100 audit log entries (id, ts, actor, action, subject, details).',

  async read(uri, ctx): Promise<ResourceContents> {
    const rows = await ctx.tx<
      Array<{
        id: string;
        ts: number;
        actor: string;
        action: string;
        subject: string;
        details: unknown;
      }>
    >`
      SELECT id, ts, actor, action, subject, details
        FROM harness_shared.audit_log
       ORDER BY ts DESC
       LIMIT 100
    `;
    return {
      uri,
      mimeType: 'application/json',
      text: JSON.stringify({ entries: rows }, null, 2),
    };
  },
});
