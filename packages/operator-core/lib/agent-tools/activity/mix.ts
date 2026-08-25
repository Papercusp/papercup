/**
 * activity:mix — the bounded, server-side reader for goal-mode activity shape.
 *
 * The rubric deliberately measures what an owner DID, not the mode row written at
 * launch. Keeping the raw `tool_invocations` read here means callers receive a
 * small, argument-free summary while the implementation can still unwrap
 * dispatch wrappers and classify mixed bursts correctly. A saved code:run recipe
 * can therefore reuse this surface without embedding opaque SQL.
 */

import { z } from 'zod';
import { AGENT_ROLES, defineTool } from '@papercusp/agent-mcp';
import { automaticToolInvocationPredicate, dispatchWrapperExclusionPredicate } from '../sessions/automatic-tool-names';
import { resolveAgentIdentity } from '../coordination/identity';

export type ActivityMixMode =
  | 'owner-comms'
  | 'supervise'
  | 'record-durably'
  | 'implement'
  | 'investigate'
  | 'self-admin'
  | `other: ${string}`;

export interface ActivityMixRow {
  ts: number;
  tool_name: string;
  args_json?: unknown;
  metadata_json?: unknown;
  total?: number;
}

export interface ActivityCall {
  ts: number;
  tool: string;
  args: unknown;
}

interface ActivityBurst {
  start: number;
  last: number;
  calls: ActivityCall[];
}

export interface ActivityMixResult {
  rowsPulled: number;
  logicalCalls: number;
  bursts: number;
  attributedMin: number;
  idleTrimmedMin: number;
  truncated: boolean;
  telemetryDropped: number;
  wrappersUnwrapped: number;
  byMode: Array<[string, string, string]>;
  byResponsibility: Array<[string, string, string]>;
  burstsPerMode: Record<string, number>;
  responsibilitySwitches: number;
  minutesPerSwitch: number | null;
}

const AUTO_TOOL_NAMES = new Set(['activity:report', 'coord:glance', 'coord:inbox']);
const OWNER_REPORTING = new Set(['coord:escalate', 'notifications:send_owner', 'notifications:send-owner']);
const COORDINATION_READS = new Set([
  'coord:inbox',
  'coord:presence',
  'coord:read',
  'coord:feed',
  'coord:orient',
  'coord:whoami',
  'coord:plan-events',
]);
const MODE_PRIORITY: ActivityMixMode[] = [
  'owner-comms',
  'supervise',
  'record-durably',
  'implement',
  'investigate',
  'self-admin',
];

const BURST_GAP_SEC = 20;
const IDLE_CAP_SEC = 180;

function canonicalToolName(value: unknown): string {
  const tool = String(value ?? '').trim();
  if (!tool) return 'other: unknown';
  if (tool.includes(':')) {
    const [namespace, ...verb] = tool.split(':');
    return `${namespace.toLowerCase()}:${verb.join(':').toLowerCase()}`;
  }
  if (tool.includes('.')) {
    const [namespace, ...verb] = tool.split('.');
    return `${namespace.toLowerCase()}:${verb.join(':').toLowerCase()}`;
  }
  return tool.toLowerCase();
}

function parseJson(value: unknown): unknown {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string' || value.trim() === '') return {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value ?? '');
  }
}

function camelToLower(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

/** Extract statically visible inner calls from a code:run script. */
function callsInScript(script: string, ts: number): ActivityCall[] {
  const calls: ActivityCall[] = [];
  const dotted = /\btools\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)/g;
  for (const match of script.matchAll(dotted)) {
    calls.push({ ts, tool: `${match[1]}:${camelToLower(match[2])}`, args: script });
  }
  const named = /\btools\.call\(\s*['"]([^'"]+)['"]/g;
  for (const match of script.matchAll(named)) {
    calls.push({ ts, tool: match[1], args: script });
  }
  return calls;
}

/**
 * Turn one raw ledger row into logical calls. Marked dispatch-wrapper rows are
 * filtered in SQL; this fallback handles old/unmarked rows and makes the
 * wrapper correction explicit for the activity instrument.
 */
export function unwrapActivityRow(row: ActivityMixRow): { calls: ActivityCall[]; unwrapped: boolean } {
  const ts = Number(row.ts);
  const tool = canonicalToolName(row.tool_name);
  const args = parseJson(row.args_json);
  const record = asRecord(args);

  if (tool === 'tools:invoke') {
    const inner = record.name;
    if (typeof inner !== 'string' || inner.length === 0) return { calls: [], unwrapped: true };
    return { calls: [{ ts, tool: inner, args: record.args ?? {} }], unwrapped: true };
  }

  if (tool === 'code:run' || tool === 'recipes:run') {
    const script = typeof record.script === 'string' ? record.script : '';
    return { calls: callsInScript(script, ts), unwrapped: true };
  }

  return { calls: [{ ts, tool, args }], unwrapped: false };
}

export function activityMode(call: ActivityCall): ActivityMixMode {
  const tool = canonicalToolName(call.tool);
  const args = asText(call.args).toLowerCase();
  const record = asRecord(call.args);
  const recipients = record.to;
  const explicitlyTargetsHuman =
    (typeof recipients === 'string' && recipients.toLowerCase() === 'human') ||
    (Array.isArray(recipients) && recipients.some((recipient) => String(recipient).toLowerCase() === 'human')) ||
    (typeof call.args === 'string' && /(?:to|recipients?)\s*[:=].{0,80}["']human["']/.test(args));

  if (OWNER_REPORTING.has(tool) || (tool === 'coord:send' && explicitlyTargetsHuman)) return 'owner-comms';
  if (COORDINATION_READS.has(tool)) return 'investigate';
  if (
    tool.startsWith('coord:') ||
    tool.startsWith('fleet:') ||
    tool.startsWith('pot:') ||
    tool.startsWith('scheduler:')
  ) return 'supervise';
  if (
    tool.startsWith('work_items:') ||
    tool.startsWith('workitems:') ||
    tool.startsWith('plans:') ||
    tool.startsWith('issues:') ||
    tool.startsWith('improvements:') ||
    tool.startsWith('facts:') ||
    tool === 'memory:remember'
  ) return 'record-durably';
  if (
    tool === 'capability:edit' ||
    tool === 'capability:write' ||
    tool === 'capability:apply_patch' ||
    tool === 'capability:apply-patch' ||
    tool === 'capability:delete' ||
    tool === 'capability:move'
  ) return 'implement';
  if (
    tool.startsWith('dev:') ||
    tool.startsWith('search:') ||
    tool.startsWith('sessions:') ||
    tool.startsWith('docs:') ||
    tool.startsWith('memory:') ||
    tool.startsWith('facts:') ||
    tool.startsWith('session:') ||
    tool.startsWith('rubrics:') ||
    tool.startsWith('scorecards:') ||
    tool.startsWith('activity:')
  ) return 'investigate';
  if (tool.startsWith('loop:') || tool.startsWith('mode:') || tool.startsWith('journal:')) return 'self-admin';
  if (tool.startsWith('goals:')) return 'self-admin';
  if (tool.startsWith('git-sync:')) return 'supervise';
  if (tool.startsWith('testing:') || tool.startsWith('build:') || tool.startsWith('locks:') || tool.startsWith('capability:')) {
    return 'investigate';
  }
  return `other: ${tool}`;
}

const responsibilityMatchers: Array<[string, RegExp]> = [
  ['windows leg / VM incident', /windows|win-|qcow2|qemu|qemu2|wi-39360/],
  ['linux leg', /linux|\bdeb\b|dpkg|\bpax\b|wi-39364|wi-39357|wi-39355/],
  ['macos leg', /macos|darwin|\bdmg\b|\.app\b/],
];

function responsibilities(calls: ActivityCall[]): string[] {
  const text = calls.map((call) => `${call.tool} ${asText(call.args)}`).join(' ').toLowerCase();
  const matches = responsibilityMatchers.filter(([, pattern]) => pattern.test(text)).map(([label]) => label);
  return matches.length ? matches : ['cross-cutting / portfolio mgmt'];
}

function percentages(values: Record<string, number>, denominator: number): Array<[string, string, string]> {
  return Object.entries(values)
    .sort((a, b) => b[1] - a[1])
    .map(([key, value]) => [key, `${(100 * value / denominator).toFixed(1)}%`, `${Math.round(value / 60)}m`]);
}

/** Pure burst attribution, exported so calibration and regression tests share the exact code path. */
export function summarizeActivityMix(rows: ActivityMixRow[], totalRows = rows.length): ActivityMixResult {
  const calls: ActivityCall[] = [];
  let wrappersUnwrapped = 0;
  let telemetryDropped = 0;

  for (const row of rows) {
    const rawTool = canonicalToolName(row.tool_name);
    if (AUTO_TOOL_NAMES.has(rawTool)) {
      telemetryDropped += 1;
      continue;
    }
    const unwrapped = unwrapActivityRow(row);
    if (unwrapped.unwrapped) wrappersUnwrapped += 1;
    calls.push(...unwrapped.calls.filter((call) => call.tool !== 'other: unknown'));
  }
  calls.sort((a, b) => a.ts - b.ts);

  const bursts: ActivityBurst[] = [];
  for (const call of calls) {
    const burst = bursts[bursts.length - 1];
    if (burst && call.ts - burst.last <= BURST_GAP_SEC) {
      burst.last = call.ts;
      burst.calls.push(call);
    } else {
      bursts.push({ start: call.ts, last: call.ts, calls: [call] });
    }
  }

  const modeSeconds: Record<string, number> = {};
  const responsibilitySeconds: Record<string, number> = {};
  const burstsPerMode: Record<string, number> = {};
  let attributed = 0;
  let capped = 0;
  for (let index = 0; index < bursts.length; index += 1) {
    const burst = bursts[index];
    const nextStart = bursts[index + 1]?.start ?? burst.last + 30;
    let duration = Math.max(0, nextStart - burst.start);
    if (duration > IDLE_CAP_SEC) {
      capped += duration - IDLE_CAP_SEC;
      duration = IDLE_CAP_SEC;
    }
    const modes = burst.calls.map(activityMode).filter((mode) => mode !== 'other: wrapper');
    const selectedMode = MODE_PRIORITY.find((mode) => modes.includes(mode)) ?? modes[0] ?? 'investigate';
    modeSeconds[selectedMode] = (modeSeconds[selectedMode] ?? 0) + duration;
    burstsPerMode[selectedMode] = (burstsPerMode[selectedMode] ?? 0) + 1;

    const matchedResponsibilities = responsibilities(burst.calls);
    const share = duration / matchedResponsibilities.length;
    for (const responsibility of matchedResponsibilities) {
      responsibilitySeconds[responsibility] = (responsibilitySeconds[responsibility] ?? 0) + share;
    }
    attributed += duration;
  }

  let responsibilitySwitches = 0;
  let previous: string | null = null;
  for (const burst of bursts) {
    const current = responsibilities(burst.calls).join('|');
    if (previous && current !== previous) responsibilitySwitches += 1;
    previous = current;
  }

  const denominator = attributed || 1;
  return {
    rowsPulled: rows.length,
    logicalCalls: calls.length,
    bursts: bursts.length,
    attributedMin: Number((attributed / 60).toFixed(1)),
    idleTrimmedMin: Number((capped / 60).toFixed(1)),
    truncated: totalRows > rows.length,
    telemetryDropped,
    wrappersUnwrapped,
    byMode: percentages(modeSeconds, denominator),
    byResponsibility: percentages(responsibilitySeconds, denominator),
    burstsPerMode,
    responsibilitySwitches,
    minutesPerSwitch: responsibilitySwitches ? Number((attributed / 60 / responsibilitySwitches).toFixed(1)) : null,
  };
}

const isoBoundary = z
  .string()
  .datetime({ offset: true })
  .describe('Absolute ISO 8601 timestamp; defaults to the last 24 hours when omitted.');

export default defineTool({
  name: 'activity:mix',
  profile: 'engineer',
  description:
    'Measure one owner\'s goal-mode activity shape from tool_invocations: exclude automatic telemetry, unwrap dispatch wrappers, collapse calls into bursts, and return bounded BY_MODE/BY_RESPONSIBILITY percentages.',
  capability: 'activity:read',
  requirePrincipal: false,
  needsWorkspaceTx: true,
  agentRoles: [...AGENT_ROLES],
  rolesQuota: { operator: { perRun: 20 } },
  args: z.object({
    owner: z.string().min(1).max(256).describe("Coord owner id or 'self'."),
    since: isoBoundary.optional(),
    until: isoBoundary.optional(),
    maxRows: z.number().int().positive().max(2000).optional().describe('Bounded raw-row limit; default 2000.'),
  }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const owner = args.owner === 'self' ? identity.ownerId : args.owner;
    if (!owner) {
      return { isError: true, content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'owner_unavailable' }) }] };
    }
    const until = args.until ? new Date(args.until).toISOString() : new Date().toISOString();
    const since = args.since
      ? new Date(args.since).toISOString()
      : new Date(Date.parse(until) - 24 * 60 * 60 * 1000).toISOString();
    const maxRows = args.maxRows ?? 2000;
    const workspace = ctx.workspaceId;
    const automatic = automaticToolInvocationPredicate(ctx.tx, 'ti');
    const wrapper = dispatchWrapperExclusionPredicate(ctx.tx, 'ti');
    const rows = await ctx.tx<ActivityMixRow[]>`
      SELECT extract(epoch FROM ti.invoked_at)::float8 AS ts,
             ti.tool_name,
             ti.args_json,
             ti.metadata_json,
             count(*) OVER ()::int AS total
        FROM harness_shared.tool_invocations ti
       WHERE ti.coord_owner_id = ${owner}
         AND ti.workspace_id = ${workspace}
         AND ti.invoked_at >= ${since}::timestamptz
         AND ti.invoked_at < ${until}::timestamptz
         AND NOT ${automatic}
         AND ${wrapper}
       ORDER BY ti.invoked_at ASC
       LIMIT ${maxRows}
    `;
    const total = Number(rows[0]?.total ?? rows.length);
    return {
      data: {
        ok: true,
        owner,
        since,
        until,
        ...summarizeActivityMix(rows, total),
      },
    };
  },
});
