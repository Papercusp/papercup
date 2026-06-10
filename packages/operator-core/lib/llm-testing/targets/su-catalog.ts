/**
 * Curated `papercusp-su` tool catalog for the in-process `su` target.
 *
 * The real SU surface is the full ~226-tool superuser catalog
 * (`listMcpProjections()` over the populated projection registry). We do
 * NOT enumerate it live here, on purpose:
 *
 *   - **Hermetic.** `listMcpProjections()` reads a registry that is only
 *     populated by the 283 side-effect imports in
 *     `@papercusp/operator-core/lib/agent-tools` (+ the agent-mcp read-side
 *     barrel). Booting that from a test target pulls the whole operator
 *     tool chain (operator-converse, PG-touching creators, …) at import —
 *     heavy and fragile. The `su` suite is a behavioral probe of the
 *     *playbook*, not an integration test of the dispatcher, so it should
 *     not require the operator runtime to be booted.
 *   - **Bounded cost.** 226 tool schemas is ~40-80k input tokens *per model
 *     call*; a curated ~40-tool surface keeps each scenario's matrix run
 *     cheap while still letting the model pick the right tool.
 *   - **Faithful where it counts.** The tool *names* + the load-bearing
 *     args (the `harness` scope arg on `docs:*`/`plans:*`, the
 *     `design-phase:*` group, the absence of any `features:update` write)
 *     mirror the real surface — which is exactly what the scenario asserts
 *     measure (tool *selection*, not tool *results*).
 *
 * If the suite later wants to track the live surface, swap `SU_CATALOG`
 * for a filtered `listMcpProjections()` behind a flag — the rest of the
 * target is catalog-shape-agnostic.
 */

/** One catalog entry: the canonical colon-form MCP name + a concise
 *  description + a minimal JSON-Schema for the args the model can pass. */
export interface SuCatalogEntry {
  /** Canonical projected name, colon form (e.g. `docs:get`). */
  name: string;
  description: string;
  /** JSON-Schema `object` describing the tool's args. */
  input: Record<string, unknown>;
}

/** A `harness`-scope arg shared by the context-only readers (`docs:*`,
 *  `plans:*`). The playbook's hard rule: at operator scope you NAME the
 *  harness (`'all'` for Papercusp's own docs/plans, else a slug) — never
 *  stall on `harness_required`. */
const HARNESS_ARG = {
  harness: {
    type: 'string',
    description:
      "Harness slug to scope to. Pass 'all' for Papercusp's own (operator-level) docs/plans, or a managed harness slug. Required at operator scope.",
  },
} as const;

const obj = (
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> => ({
  type: 'object',
  properties,
  ...(required.length ? { required } : {}),
});

/**
 * The curated SU catalog. Names + arg shapes are real; descriptions are
 * one-liners distilled from each tool's playbook guidance. Deliberately
 * representative, not exhaustive — covers the groups the scenarios exercise
 * (docs / plans / design-phase / work_items / coord / messages / search /
 * locks / memory / blueprint / harness) plus a believable SU spread.
 *
 * Deliberately ABSENT: any `features:update` / raw-SQL write verb. The SU
 * agent has no such tool; feature-pipeline state advances through the
 * pipeline roles + `messages:send` (work_item-scoped via `to_feature_id`).
 * SU-S05 asserts the model doesn't invent one.
 */
export const SU_CATALOG: ReadonlyArray<SuCatalogEntry> = [
  // --- docs (context-only readers, harness-scoped) ---
  {
    name: 'docs:outline',
    description:
      'Full table-of-contents of the engineering docs (cached per session). Docs-first entry point for "how does X work".',
    input: obj({ ...HARNESS_ARG }),
  },
  {
    name: 'docs:get',
    description: 'Fetch one or more doc pages by slug; narrow a long page with a heading anchor.',
    input: obj({
      slugs: { type: 'array', items: { type: 'string' } },
      heading: { type: 'string' },
      ...HARNESS_ARG,
    }, ['slugs']),
  },
  {
    name: 'docs:search',
    description: 'Full-text search the docs when you do not know the page slug.',
    input: obj({ query: { type: 'string' }, ...HARNESS_ARG }, ['query']),
  },
  // --- plans (PG-canonical project history, harness-scoped) ---
  {
    name: 'plans:list',
    description: 'List plans (project history). Entry point for "what is the state of X".',
    input: obj({ ...HARNESS_ARG }),
  },
  {
    name: 'plans:get',
    description: 'Fetch one plan by slug: frontmatter, ## Now, items, decisions.',
    input: obj({ slug: { type: 'string' }, ...HARNESS_ARG }, ['slug']),
  },
  {
    name: 'plans:search',
    description: 'Search plans by content.',
    input: obj({ query: { type: 'string' }, ...HARNESS_ARG }, ['query']),
  },
  {
    name: 'plans:set-now',
    description: "Update a plan's ## Now (state + next).",
    input: obj({ slug: { type: 'string' }, state: { type: 'string' }, next: { type: 'string' }, ...HARNESS_ARG }, ['slug']),
  },
  {
    name: 'plans:set-status',
    description:
      "Flip one plan item's status. Flipping to `wip` AUTO-CLAIMS the item for you (rejected with claim_conflict when a live peer holds it); done/dropped releases your claim.",
    input: obj({
      slug: { type: 'string' },
      itemId: { type: 'string', description: 'P-NNN' },
      status: { type: 'string', enum: ['todo', 'wip', 'blocked', 'needs-human', 'done', 'dropped'] },
      note: { type: 'string' },
      ...HARNESS_ARG,
    }, ['slug', 'itemId', 'status']),
  },
  {
    name: 'plan_items:claim',
    description:
      'Take the live, heartbeat-leased grip on a plan item — what you call when you actually START it.',
    input: obj({
      plan: { type: 'string', description: 'plan slug' },
      item: { type: 'string', description: 'plan-item id (P-NNN)' },
      intent: { type: 'string', description: 'one line on what you are doing' },
      harness: { type: 'string' },
    }, ['plan', 'item']),
  },
  // --- work items (the unified work surface) ---
  {
    name: 'work_items:list',
    description: 'List work items (feature/bug/change/task/chunk) by kind/assignee/status.',
    input: obj({ kind: { type: 'string' }, assignedBy: { type: 'string' }, status: { type: 'string' }, slug: { type: 'string' } }),
  },
  {
    name: 'work_items:get',
    description: 'Fetch one work item with its acceptance + lifecycle.',
    input: obj({ id: { type: 'string' } }, ['id']),
  },
  {
    name: 'work_items:complete',
    description: 'Record a work item completion (summary, what-landed, migrations, tests, deferred).',
    input: obj({ id: { type: 'string' }, summary: { type: 'string' } }, ['id']),
  },
  {
    // POSITIONAL write tool (token-efficient-agent-io P-008): advertised as a
    // single `row` string, exactly as the real `advertisedArgsSchema` produces.
    // The column order lives in the `row` description (the prompt-declared
    // schema) — the P-013 gate measures whether the model emits a correct row.
    name: 'work_items:set_state',
    description: 'Set a work-item state. POSITIONAL: call with a single `row` arg = comma-separated VALUES in column order id,state,harness? (e.g. "WI-42,passed").',
    input: obj(
      {
        row: {
          type: 'string',
          description: 'Comma-separated VALUES in column order: id, state, harness?. Omit trailing optional columns.',
        },
      },
      ['row'],
    ),
  },
  // --- harness / status ---
  {
    name: 'harness:status',
    description: 'Feature-status snapshot for one harness.',
    input: obj({ slug: { type: 'string' } }, ['slug']),
  },
  {
    name: 'harness:list',
    description: 'List harnesses in a workspace.',
    input: obj({ workspace: { type: 'string' } }),
  },
  {
    name: 'harness:create',
    description: 'Instantiate a harness from a blueprint.',
    input: obj({ slug: { type: 'string' }, blueprint: { type: 'string' } }, ['slug', 'blueprint']),
  },
  // --- issues / work intake ---
  {
    name: 'issues:create',
    description: 'File a discovered problem that is out of current scope (title, severity, topics).',
    input: obj({ title: { type: 'string' }, severity: { type: 'string' } }, ['title']),
  },
  {
    name: 'issues:list',
    description: 'List issues (bug/change) for a harness.',
    input: obj({ slug: { type: 'string' } }),
  },
  // --- search (workspace-global) ---
  {
    name: 'search:fulltext',
    description: 'Cheap BM25 full-text search across escalations/turns/decisions.',
    input: obj({ query: { type: 'string' }, scope: { type: 'array', items: { type: 'string' } } }, ['query']),
  },
  {
    name: 'search:semantic',
    description: 'Hybrid semantic search when phrasing is paraphrased.',
    input: obj({ query: { type: 'string' }, mode: { type: 'string' } }, ['query']),
  },
  // --- coordination (live working memory) ---
  {
    name: 'coord:declare-intent',
    description:
      'Declare what you are working on right now (intent, files, plan slug) so peers see you. Passing `items` CLAIMS those plan items as your lane (requires current_plan_slug) — an unclaimed lane is invisible to the Queen and peers.',
    input: obj({
      intent: { type: 'string' },
      current_files: { type: 'array', items: { type: 'string' } },
      current_plan_slug: { type: 'string' },
      items: {
        type: 'array',
        items: { type: 'string', pattern: '^P-\\d{3,}$' },
        description:
          'Plan items you are taking (your LANE) — each is auto-claimed; requires current_plan_slug. Pass [] to release the lane.',
      },
      harness: { type: 'string' },
    }, ['intent']),
  },
  {
    name: 'coord:send',
    description: 'Send a free-text coordination message (design calls, novel coordination).',
    input: obj({ to: { type: 'array', items: { type: 'string' } }, body: { type: 'string' } }, ['body']),
  },
  {
    name: 'coord:presence',
    description: 'List active coordination agents and their declared intent.',
    input: obj({ workspace: { type: 'string' } }),
  },
  {
    name: 'coord:inbox',
    description: 'Read your coordination inbox (messages/handoffs/escalations).',
    input: obj({ since_ts: { type: 'string' } }),
  },
  // --- messages (durable inter-agent hand-off) ---
  {
    name: 'messages:send',
    description: 'Durable inter-agent hand-off; work_item-scoped via to_feature_id.',
    input: obj({ to: { type: 'string' }, body: { type: 'string' }, to_feature_id: { type: 'string' } }, ['body']),
  },
  {
    name: 'messages:inbox',
    description: 'Read durable messages addressed to you.',
    input: obj({}),
  },
  // --- locks (file + resource coordination) ---
  {
    name: 'locks:acquire',
    description: 'Acquire a multi-file lock held across several edits + the commit.',
    input: obj({
      paths: { type: 'array', items: { type: 'string' } },
      intent: { type: 'string' },
      ttl_sec: { type: 'number' },
    }, ['paths', 'intent']),
  },
  {
    name: 'locks:queue',
    description: 'See who holds which file locks.',
    input: obj({ owner: { type: 'string' } }),
  },
  // --- design-phase (the UI design loop) ---
  {
    name: 'design-phase:list_tokens',
    description: 'List the DTCG design tokens (brand colors, spacing, type). Check before hand-rolling UI.',
    input: obj({}),
  },
  {
    name: 'design-phase:read_token',
    description: 'Read one design token value.',
    input: obj({ id: { type: 'string' } }, ['id']),
  },
  {
    name: 'design-phase:search_registry',
    description: 'Search the component registry for an existing component before building a new one.',
    input: obj({ query: { type: 'string' } }, ['query']),
  },
  {
    name: 'design-phase:get_registry_component',
    description: 'Get a registry component definition.',
    input: obj({ id: { type: 'string' } }, ['id']),
  },
  {
    name: 'design-phase:record_review',
    description: 'Record a reviewer verdict on a design.',
    input: obj({ verdict: { type: 'string' } }, ['verdict']),
  },
  // --- memory (semantic, durable facts) ---
  {
    name: 'memory:search',
    description: 'Search the user\'s persistent memories by semantic similarity.',
    input: obj({ query: { type: 'string' }, harness_slug: { type: 'string' } }, ['query']),
  },
  {
    name: 'memory:remember',
    description: 'Write a stable curated fact (user pref / convention / decision).',
    input: obj({ body: { type: 'string' }, kind: { type: 'string' } }, ['body']),
  },
  // --- blueprint surface ---
  {
    name: 'blueprint:validate',
    description: 'Validate / inspect a harness blueprint.',
    input: obj({ blueprint: { type: 'string' } }),
  },
  {
    name: 'blueprint:extend',
    description: 'Author a child blueprint by overriding a built-in.',
    input: obj({ base: { type: 'string' }, name: { type: 'string' } }, ['base', 'name']),
  },
  // --- misc high-value SU verbs ---
  {
    name: 'notifications:recent',
    description: "The app's recent toast/error stream — first stop for 'why did the app error?'.",
    input: obj({}),
  },
  {
    // Tier-3 read tool (token-efficient-agent-io P-004): results arrive as
    // HEADERLESS CSV — a `[N]` count line then N rows of VALUES in the column
    // order named here (the prompt-declared schema). The P-013 read gate
    // measures whether the model maps row positions to columns correctly.
    name: 'audit:list',
    description: 'Recent audit events. Returns HEADERLESS CSV: a `[N]` count line then N rows of comma-separated VALUES in column order id,ts,actor,action,subject (no header row — map positions to these columns).',
    input: obj({}),
  },
  {
    name: 'agent_tools:list',
    description: 'The authoritative, self-describing tool catalog for a role.',
    input: obj({ asRole: { type: 'string' } }),
  },
  {
    name: 'repomix:pack',
    description: 'Pack a repo (or subset) into one LLM-friendly document for a holistic view.',
    input: obj({ path: { type: 'string' } }),
  },
];

/**
 * Anthropic tool-name constraint is `^[a-zA-Z0-9_-]{1,64}$` — colons are
 * illegal. Map the canonical colon form to an API-safe `__` form for the
 * request, and keep the reverse map so a model `tool_use` is recorded +
 * dispatched under its canonical name (what the asserts match on).
 */
export function sanitizeToolName(canonical: string): string {
  return canonical.replace(/:/g, '__');
}

export interface BuiltCatalog {
  /** Anthropic `tools` array (sanitized names). */
  tools: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>;
  /** sanitized name → canonical colon name. */
  canonicalBySanitized: Map<string, string>;
}

/** Build the Anthropic `tools` array + the reverse name map from a catalog. */
export function buildCatalog(entries: ReadonlyArray<SuCatalogEntry> = SU_CATALOG): BuiltCatalog {
  const tools: BuiltCatalog['tools'] = [];
  const canonicalBySanitized = new Map<string, string>();
  for (const e of entries) {
    const sanitized = sanitizeToolName(e.name);
    canonicalBySanitized.set(sanitized, e.name);
    // Anthropic requires input_schema.type === 'object'.
    const schema =
      e.input && (e.input as { type?: unknown }).type === 'object'
        ? e.input
        : { type: 'object' as const };
    tools.push({ name: sanitized, description: e.description, input_schema: schema });
  }
  return { tools, canonicalBySanitized };
}
