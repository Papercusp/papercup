/**
 * dev:listening_ports — what is listening on a TCP port, and which process owns
 * it. Plan `bash-to-tool-substitution-2026-07-26`, D-010 item 3 / D-017.
 *
 * A SEPARATE VERB from dev:service_health on purpose (D-017): service_health
 * probes a FIXED endpoint registry and feeds an alarm path, while this answers a
 * point-in-time question about an ARBITRARY port. The corpus that motivated it
 * is full of ephemeral, agent-allocated ports no registry could contain.
 *
 * The honest-null contract lives in `guidance.returns` — deliberately, because
 * the prompt-weight budget counts description + when + notWhen + chaining and
 * NOT returns/seeAlso, and this semantics is too important to trim.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import {
  listListeningSockets,
  ListeningSocketsError,
  LISTENING_SOCKETS_DEFAULT_LIMIT,
} from '../../listening-sockets';

export default defineTool({
  name: 'dev:listening_ports',
  profile: 'engineer',
  description:
    'What is listening on a TCP port and WHICH PROCESS owns it — the `ss -tlnp` / `lsof -iTCP:<port> -sTCP:LISTEN` / `netstat -tlnp` answer, structured. Filter by `port` (what owns this port) or by `pid` (which ports does this process listen on). Owner resolution is same-uid only: a socket owned by another user is reported as listening with ownerVisible:false, which is NOT the same as nothing being bound.',
  capability: 'intel:read',
  guidance: {
    when: 'You need to know whether something is bound to a port and who owns it — diagnosing EADDRINUSE, finding the pid squatting a port, confirming a server you started actually bound, or checking which ports a pid opened. Works for ANY port, including ephemeral ones you just allocated.',
    notWhen: 'NOT for "is my service healthy" — dev:service_health probes the known endpoints and is the right tool for a registered service. This reports only TCP sockets in LISTEN state: no UDP, no established connections, no traffic.',
    returns:
      '{ sockets[], matched, totalListening, truncated, ownerHidden }. Each socket: { port, address, family, pid, pids[], listeners, command, ownerVisible, reserved }.\n\nOne row per (port, address, command), NOT per socket: a SO_REUSEPORT cluster binds one socket per worker (the operator on :3070 has 16), so `pids` lists every listener and `listeners` counts them. `pid` is the representative — filtering by `pid` matches any worker in the group.\n\nREAD ownerVisible BEFORE pid. The kernel reveals a socket owner only to the same uid, so:\n  • listening + ownerVisible:true  → `pid`/`command` are the real owner.\n  • listening + ownerVisible:false → the port IS bound, by ANOTHER USER (root system services, Postgres on :5432, …). pid/command are null because they are unreadable, NOT because the port is free. Do not report it as unowned.\n  • no row at all → nothing is listening on that port.\nOn this host ~60% of listening sockets fall in the middle case, so conflating it with the third is a confident wrong answer. `reserved:true` marks a RESERVED_SERVICE_PORTS core-service port — never squat it. `ownerHidden` counts matched rows in the middle case.',
    seeAlso: [
      'dev:service_health (is a KNOWN service healthy — probes the endpoint registry)',
      'dev:processes (the agent-kind process inventory; not a general ps)',
      'capability:bash_output (did MY background job finish, and what did it print)',
    ],
  },
  requirePrincipal: false,
  agentRoles: ['operator', 'architect', 'debugger', 'cup'],
  args: z.object({
    port: z.number().int().positive().max(65535).optional().describe('Only sockets bound to this port.'),
    pid: z.number().int().positive().optional().describe('Only sockets owned by this pid (same-uid processes only).'),
    limit: z
      .number()
      .int()
      .positive()
      .max(500)
      .optional()
      .describe(`Max rows (default ${LISTENING_SOCKETS_DEFAULT_LIMIT}). This host has ~240 listening sockets.`),
  }),
  async handler(args) {
    try {
      const result = await listListeningSockets({ port: args.port, pid: args.pid, limit: args.limit });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, ...result }, null, 2) }],
      };
    } catch (err) {
      const message = err instanceof ListeningSocketsError ? err.message : String(err);
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify({ ok: false, reason: 'listen_table_unreadable', message }) },
        ],
        isError: true,
      };
    }
  },
});
