/**
 * `graph:query` — the curated GitNexus call-graph facade, exposed as a tool.
 *
 * Plan `code-intelligence-routing-lsp-gitnexus-2026-08-20`, P-006 / WI-40206,
 * decision D-057.
 *
 * WHY THIS FILE EXISTS. `gitnexusFacade` (the GitNexus half of the read-only
 * code-intelligence plane) was built in P-012 and then reached by NOTHING: it
 * had zero non-test callers, and `configureGitnexusDispatch` was never called
 * outside tests. That is not a cosmetic gap. `code:run` exposes only
 * `tools.ns.verb(args)` — "no require/process/import" (see `code/run.ts`) — so
 * a facade with no tool of its own is unreachable from every agent surface,
 * and the curated plane silently degraded to "use the raw `gitnexus.*` plugin
 * tools", which is exactly what D-021 warns against: they answer with unranked,
 * unbudgeted results and no freshness contract, so a wrong answer is
 * indistinguishable from a confident one.
 *
 * NAMING. Deliberately NOT `gitnexus:query`. The bridge plugin already
 * registers a bare `query` handler, surfaced as `gitnexus.query`; a colon-form
 * `gitnexus:query` would collide with it in the `code:run` tool namespace
 * (`tools.gitnexus.query`) — the curated and uncurated planes would answer to
 * one name. `graph:` is a free namespace, and it names the plane rather than
 * the vendor, matching its sibling `lsp:query`.
 *
 * ONE tool with an op enum rather than five, because D-007 makes prompt weight
 * an acceptance criterion for this plan.
 */

import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';

import {
  GITNEXUS_FACADE_OPS,
  GITNEXUS_NOT_ROUTABLE,
  MAX_SITES_PER_ANSWER,
  gitnexusFacade,
  gitnexusRefusal,
  type GitnexusFacadeOp,
} from '../../code-intelligence/gitnexus-facade';
import { unmeasuredSourceEvidence, type CodeIntelAnswer, type CodeIntelIntent } from '../../code-intelligence/contracts';
import { FIRST_PARTY_CALLERS_DEFAULT_LIMIT } from '../../code-intelligence/first-party-callers';
import { firstPartyCallersOffthread } from '../../code-intelligence/first-party-callers-offthread';
import { LSP_VENDOR_DIR } from '../../code-intelligence/lsp-adapter';
import { resolveAgentWorkspaceRoot } from '../capability/base-dir';

/**
 * WI-10006543 (plan gitnexus-deterministic-integration-2026-10-05, D-026, D-018):
 * `callers` is answered by the first-party backend, the vendored TypeScript's call
 * hierarchy over the agent's workspace root, built from disk per question in a
 * forked worker. It never refuses a shared name (it unions every declaration, as
 * grep does), every site has a line, and there is no index to go stale. The
 * GitNexus selectors (kind, file_path, uid, repo) do not apply to it.
 */
async function firstPartyCallersAnswer(
  args: { op?: string; name?: string; kind?: string; file_path?: string; line1?: number; uid?: string; repo?: string; limit?: number; paths?: string[] },
  ctx: { projectDir?: string },
): Promise<CodeIntelAnswer> {
  const limit = Math.min(Math.max(1, args.limit ?? MAX_SITES_PER_ANSWER), FIRST_PARTY_CALLERS_DEFAULT_LIMIT);
  const nativeOp = args.op === 'symbol' || args.op === 'callees' || args.op === 'context' ? args.op : 'callers';
  if (nativeOp !== 'callers' && (args.uid || args.repo)) return {
    backend: 'typescript-service', intent: nativeOp === 'callees' ? 'callees' : 'definition', query: args.name ?? '', sites: [],
    truncation: { truncated: false, totalAvailable: null, continuation: null },
    freshness: { health: 'unknown', indexedAt: null, indexedCommit: null, staleVsDisk: null }, latencyMs: 0,
    error: 'Native symbol queries use the current workspace and file_path/line1/kind; GitNexus uid/repo selectors are unsupported.',
  };
  const answer = await firstPartyCallersOffthread({
    vendorDir: LSP_VENDOR_DIR,
    root: resolveAgentWorkspaceRoot(ctx),
    name: args.name ?? '',
    ...(nativeOp !== 'callers' ? { op: nativeOp, filePath: args.file_path, line1: args.line1, kind: args.kind } : {}),
    limit,
    ...(args.paths && args.paths.length > 0 ? { paths: args.paths } : {}),
  });
  if (nativeOp !== 'callers') return answer;
  const ignored = (['kind', 'file_path', 'uid', 'repo'] as const).filter((k) => args[k] !== undefined);
  if (ignored.length === 0) return answer;
  const coverage = answer.coverage ?? {
    basis: 'compiler-project' as const,
    sourceCompleteness: 'unverified' as const,
    limitations: [],
  };
  return {
    ...answer,
    coverage: {
      ...coverage,
      limitations: [
        ...coverage.limitations,
        `callers ignores ${ignored.join(', ')}: it answers for every symbol with this name in the workspace.`,
      ],
    },
  };
}

// Keep the closed operation set, but also accept intents that the facade
// deliberately refuses. That lets an agent receive the typed `useInstead`
// guidance rather than a schema error with no redirect.
const OP_VALUES = [
  'context',
  ...GITNEXUS_FACADE_OPS,
  ...Object.keys(GITNEXUS_NOT_ROUTABLE),
] as [string, ...string[]];

export default defineTool({
  name: 'graph:query',
  description:
    'Code topology: symbol | context | callers | callees | impact | health. Symbol/context/callees use current JS/TS compiler snapshots with defining-file disambiguation. Context joins outgoing calls, used imports, declared inheritance/implements, members, overrides and typed field reads/writes with source versions. Structural implementations use lsp:query. Callers retains labelled unresolved calls. Index edges without measured repository/content versions are refused. Other languages and selectors receive explicit unsupported results.',
  guidance: {
    when: 'You need call-graph topology: who calls a symbol, what it calls, or the blast radius of changing it.',
    notWhen:
      'Use lsp:query for references, implementations, diagnostics and rename previews; scoped rg for literals. Native symbol/context/callees currently admit JS/TS compiler inputs. Runtime diagnosis needs state/log tools.',
    chaining:
    'op:"symbol" to locate the symbol → op:"callers"/"callees" for its edges → op:"impact" for the change radius. If results look stale, op:"health" reports structured list_repos freshness. If you need references, diagnostics, text search, or another refused intent, pass that intent as `op` to receive its concrete useInstead redirect.',
  },
  capability: 'intel:read',
  requirePrincipal: false,
  // The bridge keeps a resident child per workspace, but a COLD first call pays
  // graph load on a multi-GiB index. Declared so the dispatch stack's budget
  // matches the backend's real worst case instead of timing out mid-load.
  timeoutSec: 90,
  agentRoles: [...AGENT_ROLES],
  args: z.object({
    op: z.enum(OP_VALUES).describe('Which read-only operation to run.'),
    name: z
      .string()
      .min(1)
      .optional()
      .describe('Symbol name. Required for every op except `health`.'),
    kind: z
      .string()
      .min(1)
      .optional()
      .describe(
        "GitNexus symbol kind ('Function', 'Class', ...). Optional; narrows an ambiguous name.",
      ),
    file_path: z
      .string()
      .min(1)
      .optional()
      .describe('symbol/context/callees: defining file; picks one of several same-name symbols.'),
    line1: z.number().int().min(1).optional().describe('Native symbol/context/callees: defining line to distinguish same-name declarations in one file.'),
    uid: z
      .string()
      .min(1)
      .optional()
      .describe('GitNexus index uid; unsupported by native symbol/context/callees. Use file_path/line1 for native disambiguation.'),
    direction: z
      .enum(['upstream', 'downstream', 'both'])
      .optional()
      .describe(
        '`impact` only: which way to walk the graph. Defaults to downstream (what this change breaks).',
      ),
    repo: z
      .string()
      .min(1)
      .optional()
      .describe('Repository name in the GitNexus index. Defaults to the papercusp index.'),
    limit: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('Cap on returned sites. Default 100; callers allows up to 500.'),
    paths: z
      .array(z.string().min(1))
      .max(50)
      .optional()
      .describe('Native symbol/context/callers/callees: repo-relative search files/dirs. Default: whole repo.'),
  }),
  async handler(args, ctx) {
    const op = args.op as string;
    const native = ['callers', 'symbol', 'callees', 'context'].includes(op);
    const scoped = (answer: CodeIntelAnswer): CodeIntelAnswer => {
      const measured = answer.evidence ? answer : { ...answer,
      evidence: unmeasuredSourceEvidence(answer, { repositoryId: null, identityKind: 'unknown',
        paths: native ? args.paths ?? (args.file_path ? [args.file_path] : ['.']) : [],
        basis: native ? 'compiler-project' : 'indexed-code' }, [
        'The producer supplied no measured repository/content snapshot. Resolve source versions before treating these sites as source-backed relationships.',
        'A repository selector and current disk contents do not identify the indexed source snapshot.',
      ]) };
      const evidence = measured.evidence!;
      const sourceByPath = new Map(evidence.sourceScope.supportingFiles.map(source => [source.path, source]));
      const hash = (value: string | null | undefined) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
      const sourceBacked = measured.sites.length === 0 || (Boolean(evidence.sourceScope.repositoryId) &&
        hash(evidence.sourceScope.sourceFingerprint) && measured.sites.every((site, index) => {
          const identity = evidence.siteIdentities.find(row => row.siteIndex === index);
          return identity?.sourcePath === site.path && hash(identity.contentHash) && Boolean(identity.versionedSymbolId) &&
            identity.contentHash === sourceByPath.get(site.path)?.contentHash;
        }) && evidence.relationships.every(relation => !relation.target || (
          hash(relation.target.contentHash) && Boolean(relation.target.versionedSymbolId) &&
          relation.target.contentHash === sourceByPath.get(relation.target.site.path)?.contentHash)));
      if (sourceBacked) return measured;
      const reason = 'Graph source versions are unavailable: refusing sites whose repository/content snapshot cannot be determined. Re-query through an admitted current compiler route.';
      return { ...measured, sites: [], error: [measured.error, reason].filter(Boolean).join(' '),
        freshness: { ...measured.freshness, health: 'unknown' },
        truncation: { truncated: false, totalAvailable: null, continuation: null },
        evidence: { ...evidence, siteIdentities: [], relationships: [],
          graphScope: { ...evidence.graphScope, limitations: [...evidence.graphScope.limitations, reason] } } };
    };
    if (!GITNEXUS_FACADE_OPS.includes(op as GitnexusFacadeOp)) {
      // OP_VALUES admits these intentionally so the refusal map is reachable
      // through the actual agent-facing tool, not just through unit imports.
      const refusal = gitnexusRefusal(op as CodeIntelIntent, args.name ?? '');
      if (refusal) return { data: scoped(refusal) };
    }

    if (native) return { data: scoped(await firstPartyCallersAnswer(args, ctx)) };

    // The dispatcher is passed PER CALL rather than installed into the module
    // global by this handler. It closes over `ctx` — which carries the calling
    // principal and workspace — so publishing it to a process-wide global would
    // hand this request's context to every concurrent caller. The facade
    // prefers an explicitly-passed dispatcher for exactly this reason.
    //
    // The bridge's handlers are registered under bare names (`context`,
    // `impact`, ...); namespacing to the plugin's tool id is this seam's job,
    // which is why the facade dispatches bare names.
    //
    // `dispatchTool` is OPTIONAL on the context — "present only on transports
    // with a server-side dispatcher (MCP)". On a transport without one we pass
    // NO dispatcher rather than crashing, which lands on the facade's wiring-
    // fault refusal. That refusal is the correct answer here: it says the plane
    // is unreachable in this process, where a thrown error would be reported as
    // a failed query and an empty result would be read as "no matches" — the
    // exact confusion this facade exists to prevent.
    const dispatchTool = ctx.dispatchTool;
    const dispatch = dispatchTool
      ? (tool: string, toolArgs: Record<string, unknown>) =>
          dispatchTool(`gitnexus.${tool}`, toolArgs)
      : undefined;

    const answer = await gitnexusFacade(
      op as GitnexusFacadeOp,
      {
        name: args.name,
        kind: args.kind,
        file_path: args.file_path,
        uid: args.uid,
        direction: args.direction,
        repo: args.repo,
        limit: args.limit,
      },
      dispatch,
    );
    return { data: scoped(answer) };
  },
});
