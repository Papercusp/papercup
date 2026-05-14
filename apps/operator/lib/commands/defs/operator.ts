/**
 * operator.* — scan / approve / across-workspaces.
 *
 * Replaces the four legacy voice callbacks (onIntentOpen, onIntentScan,
 * onIntentApprove, onIntentAcrossWorkspaces) by registering them as
 * proper commands. Voice engines now drive these via the registry like
 * any other action; the panel listens for the same window events.
 */
import { z } from 'zod';
import { register } from '../registry';
import { CommandError, type CommandDef } from '../types';

const ScanArg = z.object({
  query: z.string().nullable().optional().describe('Optional natural-language query to seed the scan.'),
});
type ScanArgT = z.infer<typeof ScanArg>;

const ApproveArg = z.object({
  slug: z.string().describe('Harness slug, e.g. "sheets" or "forms".'),
  capability: z.string().nullable().optional().describe('Optional capability id. Omit if there is exactly one pending.'),
});
type ApproveArgT = z.infer<typeof ApproveArg>;

const Empty = z.object({}).strict();

const scan: CommandDef<ScanArgT, { ok: true }> = {
  id: 'operator.scan',
  kind: 'command',
  description: 'Open the Papercup panel and trigger a scan with an optional query.',
  schema: ScanArg,
  agents: ['operator', 'oracle', 'palette'],
  browser: 'required',
  concurrent: 'allow',
  tier: 'reflexive',
  paletteEntry: { section: 'Papercup', title: 'Run Papercup scan', icon: '⚲', keywords: 'operator scan run' },
  handler: async ({ query }) => {
    if (typeof window === 'undefined') {
      throw new CommandError({ code: 'wrong-process', message: 'scan must run in the browser', retryable: false });
    }
    window.dispatchEvent(new CustomEvent('operator:scan-request', { detail: { query: query ?? '' } }));
    return { ok: true };
  },
};

const approve: CommandDef<ApproveArgT, { ok: true }> = {
  id: 'operator.approve-pending',
  kind: 'command',
  description: 'Approve a pending capability for a harness slug. Server-side; no panel needed.',
  schema: ApproveArg,
  agents: ['operator', 'oracle', 'palette'],
  // Has to be 'required' for the EL Conv AI agent: it's pushed via
  // el-agent-sync.mjs as a client-tool, and buildClientTools only
  // exposes browser:'required'. Otherwise the agent calls it and crashes
  // with "Client tool with name operator_approve_pending is not defined
  // on client". The handler still does a server-side fetch — browser
  // tag is about *where the handler runs*, not where it talks to.
  browser: 'required',
  concurrent: 'queue',
  tier: 'short',
  handler: async ({ slug, capability }) => {
    const r = await fetch('/api/agent-mcp/operator-standing-approvals', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ targetHarness: slug, capability, decision: 'approve' }),
    });
    if (!r.ok) {
      throw new CommandError({
        code: 'http-error',
        message: `approve failed: HTTP ${r.status}`,
        retryable: r.status >= 500,
      });
    }
    return { ok: true };
  },
};

const across: CommandDef<{}, { ok: true }> = {
  id: 'operator.across-workspaces',
  kind: 'command',
  description: 'Read out a summary of pending suggestions across all workspaces.',
  schema: Empty,
  agents: ['operator', 'oracle', 'palette'],
  browser: 'required',
  concurrent: 'allow',
  tier: 'reflexive',
  paletteEntry: { section: 'Papercup', title: 'Summarize across workspaces', icon: '⌖', keywords: 'across workspaces summary' },
  handler: async () => {
    if (typeof window === 'undefined') {
      throw new CommandError({ code: 'wrong-process', message: 'must run in the browser', retryable: false });
    }
    window.dispatchEvent(new CustomEvent('operator:across-workspaces'));
    return { ok: true };
  },
};

register(scan);
register(approve);
register(across);
