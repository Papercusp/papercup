/**
 * GET /api/agent-mcp/operator-pause-flag — read the CLI-managed pause
 * sentinel. The chrome's BackgroundScanner polls this so `operator pause`
 * (CLI) stops scans even when the panel hasn't been opened.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { papercuspPath } from '@/lib/papercusp-root';

export const dynamic = 'force-dynamic';

export async function GET() {
  const path = join(papercuspPath('system', 'operator'), 'paused.flag');
  return Response.json({ paused: existsSync(path) });
}
