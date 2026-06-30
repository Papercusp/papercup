/**
 * dev:claude_session — find / search / read local Claude Code chat transcripts
 * (~/.claude/projects/<encoded-cwd>/<session-id>.jsonl). The Claude-Code analogue
 * of dev:omp_session (EI-4911): continuing a prior session used to mean
 * hand-grepping hundreds of JSONLs.
 *
 *   op='list'   → sessions newest-first (optionally filtered by cwd substring).
 *                 The reliable read — "which session for project X around date Y".
 *   op='search' → bounded content search; returns {sessionId, cwd, matchCount,
 *                 snippet}. LOSSY by nature (a final message is often not persisted
 *                 verbatim; markers match incidentally) — treat a hit as a lead, not
 *                 proof; the code + work-item/plan ledger is the real source of truth.
 *   op='read'   → one session as a compact, bounded turn list (most-recent first-N).
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import {
  listClaudeSessions,
  searchClaudeSessions,
  readClaudeSession,
  allClaudeSessionMetas,
} from '../../claude-sessions';

export default defineTool({
  name: 'dev:claude_session',
  profile: 'engineer',
  description:
    'Find / search / read local Claude Code chat transcripts (~/.claude/projects/*/*.jsonl) — the Claude-Code analogue of dev:omp_session. op=list (sessions by cwd + recency, the reliable read), op=search (bounded content search — lossy, returns matchCount + snippet), op=read (one session as a compact bounded turn list). Pass filePath or sessionId to read.',
  capability: 'intel:read',
  guidance: {
    when: 'Find or continue a prior Claude Code session: list by cwd to pin "the operator-vite session from ~06-29", or search content for a distinctive marker. Read a session to see where it left off.',
    notWhen:
      'For PRODUCTION agent runs the orchestrator owns sessions (dev:sessions / dev:session_detail). For OMP CLI sessions use dev:omp_session. To reconstruct "where they left off" the transcript is a LOSSY secondary — prefer the durable artifacts (git per-file history + the work-item/plan ledger), which are canonical.',
    chaining: 'dev:claude_session { op:"list", cwd } → { op:"read", sessionId } (or op:"search" { query } when you have a distinctive marker).',
  },
  requirePrincipal: false,
  agentRoles: ['operator', 'architect', 'debugger', 'bee'],
  args: z.object({
    op: z.enum(['list', 'search', 'read']).optional().describe('Defaults: read if filePath/sessionId given, else search if query given, else list.'),
    query: z.string().min(1).optional().describe('Content to search for (op=search). Case-insensitive substring.'),
    cwd: z.string().min(1).optional().describe('Filter to sessions whose cwd contains this substring (op=list/search).'),
    sessionId: z.string().min(1).optional().describe('Session id (the .jsonl basename) to read.'),
    filePath: z.string().min(1).optional().describe('Absolute transcript path to read (alternative to sessionId).'),
    limit: z.number().int().positive().max(2000).optional().describe('Max rows/turns (list/search default 30/20, read default 200).'),
    maxFilesScanned: z.number().int().positive().max(2000).optional().describe('op=search: cap files scanned, newest-first (default 400).'),
    perFileMaxBytes: z.number().int().positive().max(5_000_000).optional().describe('op=search: cap bytes read per file (default 1_000_000).'),
  }),
  async handler(args) {
    const op = args.op ?? (args.filePath || args.sessionId ? 'read' : args.query ? 'search' : 'list');

    if (op === 'list') {
      const res = await listClaudeSessions({ ...(args.cwd ? { cwd: args.cwd } : {}), ...(args.limit ? { limit: args.limit } : {}) });
      return { content: [{ type: 'text' as const, text: JSON.stringify(res) }] };
    }

    if (op === 'search') {
      if (!args.query) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'query required for op=search' }) }], isError: true };
      }
      const res = await searchClaudeSessions({
        query: args.query,
        ...(args.cwd ? { cwd: args.cwd } : {}),
        ...(args.limit ? { limit: args.limit } : {}),
        ...(args.maxFilesScanned ? { maxFilesScanned: args.maxFilesScanned } : {}),
        ...(args.perFileMaxBytes ? { perFileMaxBytes: args.perFileMaxBytes } : {}),
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(res) }] };
    }

    // op === 'read'
    let filePath = args.filePath;
    if (!filePath) {
      if (!args.sessionId) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'sessionId or filePath required for op=read' }) }], isError: true };
      }
      const all = await allClaudeSessionMetas({});
      const found = all.find((m) => m.sessionId === args.sessionId);
      if (!found) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'no session found', sessionId: args.sessionId }) }], isError: true };
      }
      filePath = found.filePath;
    }
    const res = await readClaudeSession({ filePath, ...(args.limit ? { limit: args.limit } : {}) });
    if (!res) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'unreadable session file', filePath }) }], isError: true };
    }
    return { content: [{ type: 'text' as const, text: JSON.stringify(res) }] };
  },
});
