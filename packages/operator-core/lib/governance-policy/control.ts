/**
 * Governance policy CONTROL operations (plan papercusp-enterprise-readiness-roadmap-2026-10-09
 * P-005, admin-UX half WI-6554700010011434; backend WI-10007900).
 *
 * ONE implementation of get / explain / simulate / set / add-exception, shared by every door:
 *  - the MCP tool `governance:policy` (agent-tools/governance/policy.ts),
 *  - the admin pane's write doors POST /api/governance-policy/* (endpoint-route/routes/governance-policy),
 *  - the admin pane's read, the `governancePolicy.state` sync query.
 * A pane click and a tool call therefore take the same path and record the same version row.
 * This mirrors work-scope-control.ts.
 *
 * EXPLAIN IS ENFORCEMENT. `explainFromLoad` maps a chain load to a verdict exactly as
 * enforce.ts#enforceInheritedPolicy does: `none` is not governed, `malformed` refuses, and
 * `ok` is `evaluateInheritedPolicy`. control.test.ts pins that parity, so the pane cannot
 * explain a decision the kernel would not make.
 *
 * NO WIDENING FROM THE UI. Writes go through store.ts#upsertLayer, and the evaluator is a
 * fail-closed intersection. A workspace layer that "allows" what an organization layer denies
 * is stored, but it does not change the verdict. `simulate` reports that case with
 * `decidedByAncestor`, so the pane can say so before the admin saves.
 */
import { z } from 'zod';
import {
  describeRefusal,
  evaluateInheritedPolicy,
  GOVERNED_CATEGORIES,
  POLICY_LEVELS,
  type CategoryRule,
  type GovernedCategory,
  type GovernedRequest,
  type InheritedPolicyCode,
  type PolicyException,
  type PolicyLayer,
  type PolicyLevel,
  type PolicyTraceStep,
} from './inherited-policy';
import {
  GovernancePolicyWriteError,
  listLayers,
  listVersions,
  loadChainForWorkspace,
  loadLayer,
  MAX_CHAIN_DEPTH,
  upsertLayer,
  validateLayerInput,
  type ChainLoad,
  type PolicyLayerVersion,
  type StoredPolicyLayer,
  type UpsertLayerInput,
} from './store';

/** The admin pane's sync query. Every successful write invalidates it. */
export const GOVERNANCE_POLICY_SYNC_QUERY = 'governancePolicy.state';
/** Version history is read for at most this many layers per state read (bounded fan-out). */
export const MAX_LAYERS_WITH_HISTORY = 50;
export const DEFAULT_VERSION_LIMIT = 20;

// ── wire schemas (shared by the MCP tool and the HTTP routes) ──────────────────────────────

const ruleSchema = z.object({
  allow: z.array(z.string()).optional(),
  deny: z.array(z.string()).optional(),
});
const exceptionSchema = z.object({
  category: z.string(),
  pattern: z.string(),
  reason: z.string(),
  approvedBy: z.string().optional(),
  expiresAt: z.string(),
});
/** Category keys are validated by validateLayerInput, which names the governed set in its error. */
const rulesSchema = z.record(z.string(), ruleSchema);
const requestSchema = z.record(z.string(), z.array(z.string()));

const layerShape = {
  layerId: z.string().min(1),
  level: z.enum(POLICY_LEVELS),
  scopeRef: z.string().min(1),
  parentLayerId: z.string().min(1).nullable(),
  rules: rulesSchema,
  exceptions: z.array(exceptionSchema).optional(),
};

export const governancePolicyGetSchema = z.object({
  workspaceId: z.string().min(1).optional(),
  versionLimit: z.number().int().min(1).max(100).optional(),
});
export const governancePolicyExplainSchema = z.object({
  workspaceId: z.string().min(1).optional(),
  request: requestSchema,
});
export const governancePolicySimulateSchema = z.object({
  workspaceId: z.string().min(1).optional(),
  proposed: z.object(layerShape),
  requests: z.array(requestSchema).min(1).max(50),
});
export const governancePolicySetSchema = z.object({
  ...layerShape,
  reason: z.string().min(1),
  expectedVersion: z.number().int().min(0).optional(),
});
export const governancePolicyAddExceptionSchema = z.object({
  layerId: z.string().min(1),
  exception: exceptionSchema,
  reason: z.string().min(1),
  expectedVersion: z.number().int().min(1).optional(),
});

// ── deps (injectable so the operations are unit-testable without Postgres) ─────────────────

export interface GovernancePolicyControlDeps {
  loadChain: (workspaceId: string) => Promise<ChainLoad>;
  listLayers: () => Promise<StoredPolicyLayer[]>;
  listVersions: (layerId: string, limit: number) => Promise<PolicyLayerVersion[]>;
  loadLayer: (layerId: string) => Promise<StoredPolicyLayer | null>;
  upsertLayer: (input: UpsertLayerInput) => Promise<StoredPolicyLayer>;
  /** Drop the enforcement seat's cached chains (undefined = every workspace). */
  invalidateCache: (workspaceId?: string) => void;
  /** Tell open panes to re-read. Best-effort: a failed notify never fails a committed write. */
  notify: (queryName: string) => Promise<void>;
  now: () => Date;
}

const defaultDeps: GovernancePolicyControlDeps = {
  loadChain: (workspaceId) => loadChainForWorkspace(workspaceId),
  listLayers: () => listLayers(),
  listVersions: (layerId, limit) => listVersions(layerId, limit),
  loadLayer: (layerId) => loadLayer(layerId),
  upsertLayer: (input) => upsertLayer(input),
  invalidateCache: (workspaceId) => {
    void import('./enforce').then((m) => m.invalidateGovernancePolicyCache(workspaceId));
  },
  notify: async (queryName) => {
    const { notifySyncInvalidate } = await import('../sync-sse');
    await notifySyncInvalidate(queryName);
  },
  now: () => new Date(),
};

function resolveDeps(deps?: Partial<GovernancePolicyControlDeps>): GovernancePolicyControlDeps {
  return { ...defaultDeps, ...deps };
}

// ── get ─────────────────────────────────────────────────────────────────────────────────────

export interface GovernancePolicyState {
  workspaceId: string;
  /** `none`: the workspace has no workspace layer, so no inherited policy governs it. */
  load: 'none' | 'ok' | 'malformed';
  reason: string | null;
  /** Root first: organization → department… → workspace. Empty when `load` is `none`. */
  chain: StoredPolicyLayer[];
  /** `layerId@vN>…`, the same revision string the enforcement seat stamps on a refusal. */
  revision: string | null;
  /** Every stored layer, so an admin can manage layers outside this workspace's chain. */
  layers: StoredPolicyLayer[];
  /** Newest first, per layer. Read for chain layers first, then others, up to MAX_LAYERS_WITH_HISTORY. */
  versions: Record<string, PolicyLayerVersion[]>;
  historyTruncated: boolean;
  categories: readonly GovernedCategory[];
  levels: readonly PolicyLevel[];
  generatedAt: string;
}

export function chainRevision(chain: readonly Pick<PolicyLayer, 'layerId' | 'version'>[]): string | null {
  return chain.length ? chain.map((l) => `${l.layerId}@v${l.version}`).join('>') : null;
}

export async function getGovernancePolicyState(
  workspaceId: string,
  opts: { versionLimit?: number } = {},
  deps?: Partial<GovernancePolicyControlDeps>,
): Promise<GovernancePolicyState> {
  const d = resolveDeps(deps);
  const [load, layers] = await Promise.all([d.loadChain(workspaceId), d.listLayers()]);
  const chain = load.status === 'none' ? [] : load.chain;
  const chainIds = new Set(chain.map((l) => l.layerId));
  const ordered = [...chain, ...layers.filter((l) => !chainIds.has(l.layerId))];
  const withHistory = ordered.slice(0, MAX_LAYERS_WITH_HISTORY);
  const limit = opts.versionLimit ?? DEFAULT_VERSION_LIMIT;
  const histories = await Promise.all(withHistory.map((l) => d.listVersions(l.layerId, limit)));
  const versions: Record<string, PolicyLayerVersion[]> = {};
  withHistory.forEach((l, i) => {
    versions[l.layerId] = histories[i] ?? [];
  });
  return {
    workspaceId,
    load: load.status,
    reason: load.status === 'malformed' ? load.reason : null,
    chain,
    revision: chainRevision(chain),
    layers,
    versions,
    historyTruncated: ordered.length > withHistory.length,
    categories: GOVERNED_CATEGORIES,
    levels: POLICY_LEVELS,
    generatedAt: d.now().toISOString(),
  };
}

// ── explain ─────────────────────────────────────────────────────────────────────────────────

export type ExplainedVerdict =
  | { allow: true; trace: PolicyTraceStep[] }
  | {
      allow: false;
      code: InheritedPolicyCode;
      reason: string;
      /** The step that refused. Null only for a malformed CHAIN, which refuses before any step. */
      decidedBy: PolicyTraceStep | null;
      trace: PolicyTraceStep[];
    };

export interface GovernancePolicyExplanation {
  workspaceId: string;
  governed: boolean;
  verdict: ExplainedVerdict;
  /** One sentence for the admin: why this was allowed or refused. */
  explanation: string;
  revision: string | null;
}

/** Normalize an untyped request: governed categories only, trimmed non-empty strings. */
export function parseGovernedRequest(
  raw: unknown,
): { ok: true; request: GovernedRequest } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: `request must map ${GOVERNED_CATEGORIES.join('/')} to string arrays` };
  }
  const out: Partial<Record<GovernedCategory, string[]>> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!GOVERNED_CATEGORIES.includes(key as GovernedCategory)) {
      return { ok: false, error: `unknown category '${key}' (expected one of ${GOVERNED_CATEGORIES.join(', ')})` };
    }
    if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
      return { ok: false, error: `${key} must be an array of strings` };
    }
    const values = value.map((v) => v.trim()).filter(Boolean);
    if (values.length) out[key as GovernedCategory] = values;
  }
  if (!Object.keys(out).length) return { ok: false, error: 'the request names no value to judge' };
  return { ok: true, request: out };
}

/**
 * The verdict the enforcement seat would reach for this load and request. Pure. Kept in
 * lock-step with enforce.ts#enforceInheritedPolicy (parity pinned in control.test.ts).
 */
export function explainFromLoad(
  workspaceId: string,
  load: ChainLoad,
  request: GovernedRequest,
  now: Date,
): GovernancePolicyExplanation {
  if (load.status === 'none') {
    return {
      workspaceId,
      governed: false,
      verdict: { allow: true, trace: [] },
      explanation: `No inherited policy governs workspace ${workspaceId} (it has no workspace layer), so policy refuses nothing.`,
      revision: null,
    };
  }
  const revision = chainRevision(load.chain);
  if (load.status === 'malformed') {
    const reason = `the governing policy chain for workspace ${workspaceId} is malformed (${load.reason})`;
    return {
      workspaceId,
      governed: true,
      verdict: { allow: false, code: 'org_policy:malformed', reason, decidedBy: null, trace: [] },
      explanation: `Refused: ${reason}. A chain that cannot be read cannot be proven to permit anything.`,
      revision,
    };
  }
  const verdict = evaluateInheritedPolicy(load.chain, request, now);
  if (verdict.allow) {
    return {
      workspaceId,
      governed: true,
      verdict,
      explanation: `Allowed: every layer of ${revision} permits each requested value.`,
      revision,
    };
  }
  return {
    workspaceId,
    governed: true,
    verdict: { allow: false, code: verdict.code, reason: verdict.reason, decidedBy: verdict.decidedBy, trace: verdict.trace },
    explanation: `Refused: ${describeRefusal(verdict.decidedBy)}.`,
    revision,
  };
}

export async function explainGovernancePolicy(
  workspaceId: string,
  request: GovernedRequest,
  deps?: Partial<GovernancePolicyControlDeps>,
): Promise<GovernancePolicyExplanation> {
  const d = resolveDeps(deps);
  return explainFromLoad(workspaceId, await d.loadChain(workspaceId), request, d.now());
}

// ── simulate ────────────────────────────────────────────────────────────────────────────────

export interface ProposedLayer {
  layerId: string;
  level: PolicyLevel;
  scopeRef: string;
  parentLayerId: string | null;
  rules: Partial<Record<GovernedCategory, CategoryRule>>;
  exceptions?: PolicyException[];
}

export interface GovernancePolicySimulationCase {
  request: GovernedRequest;
  before: ExplainedVerdict;
  after: ExplainedVerdict;
  changed: boolean;
  /**
   * After the change the request is still refused, and by a layer OTHER than the proposed one.
   * This is how the pane shows that a lower layer cannot widen an ancestor's refusal.
   */
  decidedByAncestor: boolean;
}

export interface GovernancePolicySimulation {
  workspaceId: string;
  /** validateLayerInput's verdict on the proposal. Non-null means `set` would refuse it. */
  validation: string | null;
  /** False when the proposed layer is not in this workspace's chain, so it cannot change its decisions. */
  affectsWorkspace: boolean;
  note: string | null;
  proposedVersion: number;
  proposedRevision: string | null;
  cases: GovernancePolicySimulationCase[];
  changedCount: number;
}

function verdictOfChain(chain: readonly PolicyLayer[], request: GovernedRequest, now: Date): ExplainedVerdict {
  const v = evaluateInheritedPolicy(chain, request, now);
  return v.allow ? v : { allow: false, code: v.code, reason: v.reason, decidedBy: v.decidedBy, trace: v.trace };
}

/** Walk parent links from `layerId` to the root. Returns root-first, or null on a broken/cyclic chain. */
async function ancestryOf(
  layerId: string | null,
  d: GovernancePolicyControlDeps,
): Promise<StoredPolicyLayer[] | null> {
  const out: StoredPolicyLayer[] = [];
  const seen = new Set<string>();
  let cursor = layerId;
  while (cursor) {
    if (seen.has(cursor) || out.length >= MAX_CHAIN_DEPTH) return null;
    seen.add(cursor);
    const layer = await d.loadLayer(cursor);
    if (!layer) return null;
    out.unshift(layer);
    cursor = layer.parentLayerId;
  }
  return out;
}

/** Judge each request before and after `proposed` is saved. Writes nothing. */
export async function simulateGovernancePolicy(
  workspaceId: string,
  proposed: ProposedLayer,
  requests: readonly GovernedRequest[],
  deps?: Partial<GovernancePolicyControlDeps>,
): Promise<GovernancePolicySimulation> {
  const d = resolveDeps(deps);
  const now = d.now();
  const load = await d.loadChain(workspaceId);
  const current = load.status === 'none' ? [] : load.chain;
  const existing = current.find((l) => l.layerId === proposed.layerId) ?? (await d.loadLayer(proposed.layerId));
  const proposedVersion = (existing?.version ?? 0) + 1;
  const proposedLayer: PolicyLayer = {
    layerId: proposed.layerId,
    level: proposed.level,
    version: proposedVersion,
    rules: proposed.rules,
    exceptions: proposed.exceptions ?? [],
  };
  const validation = validateLayerInput({ ...proposed, actor: 'simulate', reason: 'simulate' });

  let proposedChain: PolicyLayer[] | null = null;
  let note: string | null = null;
  const idx = current.findIndex((l) => l.layerId === proposed.layerId);
  if (idx !== -1) {
    proposedChain = current.map((l, i) => (i === idx ? proposedLayer : l));
  } else if (proposed.level === 'workspace' && proposed.scopeRef === workspaceId && load.status === 'none') {
    const ancestors = await ancestryOf(proposed.parentLayerId, d);
    if (ancestors) proposedChain = [...ancestors, proposedLayer];
    else note = `parent ${proposed.parentLayerId ?? '(none)'} does not resolve to an organization-rooted chain; saving would be refused`;
  } else {
    note = `layer ${proposed.layerId} is not in workspace ${workspaceId}'s chain (${chainRevision(current) ?? 'none'}), so it does not change this workspace's decisions`;
  }

  const cases = requests.map((request) => {
    const before = explainFromLoad(workspaceId, load, request, now).verdict;
    const after = proposedChain ? verdictOfChain(proposedChain, request, now) : before;
    const decidedByAncestor =
      proposedChain !== null && !after.allow && after.decidedBy !== null && after.decidedBy.layerId !== proposed.layerId;
    return { request, before, after, changed: before.allow !== after.allow, decidedByAncestor };
  });
  return {
    workspaceId,
    validation,
    affectsWorkspace: proposedChain !== null,
    note,
    proposedVersion,
    proposedRevision: proposedChain ? chainRevision(proposedChain) : null,
    cases,
    changedCount: cases.filter((c) => c.changed).length,
  };
}

// ── set / add-exception ─────────────────────────────────────────────────────────────────────

export type GovernancePolicyWriteCode = 'invalid' | 'conflict' | 'parent' | 'unavailable';

export type GovernancePolicyWriteResult =
  | { ok: true; layer: StoredPolicyLayer; revision: string }
  | { ok: false; code: GovernancePolicyWriteCode; error: string };

export interface SetLayerRequest extends ProposedLayer {
  reason: string;
  /** Optimistic concurrency: the version the admin edited (0 = the layer must not exist yet). */
  expectedVersion?: number;
}

/** Create or replace one layer: validate, write a new version with actor + reason, invalidate. */
export async function setGovernancePolicyLayer(
  req: SetLayerRequest,
  actor: string,
  deps?: Partial<GovernancePolicyControlDeps>,
): Promise<GovernancePolicyWriteResult> {
  const d = resolveDeps(deps);
  const input: UpsertLayerInput = {
    layerId: req.layerId,
    level: req.level,
    scopeRef: req.scopeRef,
    parentLayerId: req.parentLayerId,
    rules: req.rules,
    exceptions: req.exceptions ?? [],
    actor,
    reason: req.reason,
    expectedVersion: req.expectedVersion,
  };
  const invalid = validateLayerInput(input);
  if (invalid) return { ok: false, code: 'invalid', error: invalid };
  let layer: StoredPolicyLayer;
  try {
    layer = await d.upsertLayer(input);
  } catch (err) {
    if (err instanceof GovernancePolicyWriteError) return { ok: false, code: err.code, error: err.message };
    return { ok: false, code: 'unavailable', error: err instanceof Error ? err.message : String(err) };
  }
  // An organization or department layer governs every workspace beneath it: drop every cached chain.
  d.invalidateCache();
  await d.notify(GOVERNANCE_POLICY_SYNC_QUERY).catch(() => undefined);
  return { ok: true, layer, revision: `${layer.layerId}@v${layer.version}` };
}

/** Append one expiring exception to a layer as a new version (expiresAt is required). */
export async function addGovernancePolicyException(
  req: { layerId: string; exception: PolicyException; reason: string; expectedVersion?: number },
  actor: string,
  deps?: Partial<GovernancePolicyControlDeps>,
): Promise<GovernancePolicyWriteResult> {
  const d = resolveDeps(deps);
  let layer: StoredPolicyLayer | null;
  try {
    layer = await d.loadLayer(req.layerId);
  } catch (err) {
    return { ok: false, code: 'unavailable', error: err instanceof Error ? err.message : String(err) };
  }
  if (!layer) return { ok: false, code: 'invalid', error: `no policy layer '${req.layerId}'` };
  if (req.expectedVersion !== undefined && req.expectedVersion !== layer.version) {
    return {
      ok: false,
      code: 'conflict',
      error: `layer ${req.layerId} is at v${layer.version}, not the v${req.expectedVersion} you edited; reload and retry`,
    };
  }
  return setGovernancePolicyLayer(
    {
      layerId: layer.layerId,
      level: layer.level,
      scopeRef: layer.scopeRef,
      parentLayerId: layer.parentLayerId,
      rules: layer.rules,
      exceptions: [...(layer.exceptions ?? []), req.exception],
      reason: req.reason,
      expectedVersion: layer.version,
    },
    actor,
    d,
  );
}
