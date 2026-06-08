/**
 * dev:service_health — probe the dev endpoints right now (fleet-coordination-
 * painpoints Phase 3b, P-018 status surface). Up/down + latency per service.
 * The DBOS service-health workflow additionally broadcasts a coord message on
 * each up/down transition; this tool is the on-demand snapshot.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { probeAll } from '../../service-health';

export default defineTool({
  name: 'dev:service_health',
  description:
    'Probe the dev services now (:3070 operator, :3055 vite, :4321 shop, :3350 scout, :3001 web, :8082 code-server, plus the Tauri desktop via its dev-bridge eval + IPC socket + recent error toasts) — up/down + status + latency. The desktop entry reports present:false when no desktop is running. Use before relying on a service or after a "connection refused".',
  guidance: {
    when: 'Confirm which dev services are up before testing against one, or diagnose a "connection refused" / stale-server symptom.',
    notWhen: 'File/lock contention — that is locks:queue. Migration drift — db:check_drift.',
  },
  capability: 'intel:read',
  requirePrincipal: false,
  agentRoles: ['scoper', 'architect', 'worker', 'validator', 'reviewer', 'debugger', 'operator', 'documenter', 'curator', 'bee'],
  args: z.object({}),
  async handler() {
    const services = await probeAll();
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, services }) }],
    };
  },
});
