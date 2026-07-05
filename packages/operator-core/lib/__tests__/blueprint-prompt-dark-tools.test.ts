/**
 * blueprint-prompt-dark-tools.test.ts — NO "dark tool" may hide in a role prompt.
 *
 * The durable-fix follow for hybrid-bee-scheduler-work-stealing-2026-06-22 P-003: every
 * tool a role PROMPT instructs the agent to call must be DECLARED in that blueprint's
 * `dependencies.tools`. The exact bug this locks out is the one that BLOCKED P-003 — the
 * bee/queen prompts told the agent to call `scheduler:get_next` / `scheduler:set_claim_spec`
 * while the blueprint never listed them in its deps, so the verb was unregistered at spawn
 * ("a prompt-referenced but undeclared 'dark tool'"). The spawn loader builds an agent's tool
 * surface from `dependencies.tools`; a prompt that names a tool absent from that set ships an
 * instruction the agent cannot follow.
 *
 * The invariant (a SUBSET check): for each (blueprint, role),
 *
 *     { catalog-confirmed tools referenced in the role's composed prompt }  ⊆  blueprint.dependencies.tools
 *
 * "catalog-confirmed" = the backtick token is the name of a REAL registered tool (a `defineTool`
 * or plugin-manifest entry) — so prose like `localhost:3055`, `group:verb`, or `path:line` that
 * merely looks like `group:verb` is not mistaken for a tool. A small ALLOWLIST carries the
 * known references that are a tool NAMED IN PROSE for THIS role to recognize, not to CALL (a
 * peer's action — `coord:escalate` as a wake EVENT; a tool the role describes but routes
 * elsewhere). A NEW dark tool — prompt-referenced, real, not in deps, not allowlisted — FAILS
 * the build, so the P-003 class cannot recur silently.
 *
 * Pure-static — reads blueprint.yaml + prompt .md + the defineTool catalog off disk; no PG, no
 * spawn. Mirrors tools-md-sync.test.ts (the sibling prompt↔surface guard).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '../../../../');
const BP_DIR = join(REPO, 'libs/papercusp/packages/harness/blueprints');

// ─── 1. The REAL tool catalog (every registered tool name) ──────────────────
// Built the SAME way tools-md-sync builds it: scan defineTool() sources + plugin manifests.

function listTsFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (e.endsWith('.ts') && !e.endsWith('.test.ts') && e !== 'index.ts') out.push(p);
    }
  };
  walk(dir);
  return out;
}

function buildToolCatalog(): Set<string> {
  const catalog = new Set<string>();
  const toolFiles = [
    ...listTsFiles(join(REPO, 'packages/agent-mcp/src/tools')),
    ...listTsFiles(join(REPO, 'packages/operator-core/lib/agent-tools')),
  ];
  for (const f of toolFiles) {
    const src = readFileSync(f, 'utf8');
    if (!src.includes('defineTool(')) continue;
    // The tool's own `name:` field — require a `:` or `.` separator (skip inline `name: 'project'`).
    const m = src.match(/name:\s*['"]([a-zA-Z0-9_]+[:.][a-zA-Z0-9_:.\-]+)['"]/);
    if (m) catalog.add(m[1]);
  }
  // Plugin manifests (papercusp.json) contribute exposed tool names too.
  try {
    const manifests = execFileSync(
      'find',
      [join(REPO, 'libs/papercusp/plugins'), '-name', 'papercusp.json'],
      { encoding: 'utf8' },
    )
      .trim()
      .split('\n')
      .filter(Boolean);
    for (const f of manifests) {
      const json = JSON.parse(readFileSync(f, 'utf8'));
      if (Array.isArray(json.tools)) {
        for (const t of json.tools) {
          const name = t.expose?.mcp?.name ?? `${String(json.name ?? '').replace(/^@papercupai\//, '')}.${t.name}`;
          if (name) catalog.add(name);
        }
      }
    }
  } catch {
    /* no plugins dir / find unavailable → catalog without plugin verbs (still covers scheduler:*) */
  }
  return catalog;
}

const CATALOG = buildToolCatalog();

// ─── 2. Tool-mention extraction (same regex as tools-md-sync.parseToolMentions) ──

const FILE_SUFFIX = /\.(md|ts|tsx|js|jsx|mjs|cjs|json|sh|py|css|html|toml|yaml|yml)$/i;
function parseToolMentions(md: string): Set<string> {
  const mentions = new Set<string>();
  for (const m of md.matchAll(/`([a-zA-Z0-9_]+[:.][a-zA-Z0-9_:.\-\/]+)`/g)) {
    const candidate = m[1];
    if (FILE_SUFFIX.test(candidate) || candidate.includes('/')) continue;
    // Tool names are exactly `group:verb` (one colon). Drop dotted (`metadata.covers`) + multi-part.
    if (candidate.split(':').length !== 2) continue;
    mentions.add(candidate);
  }
  return mentions;
}

// ─── 3. Blueprint resolution (effective deps + role prompt files) ───────────
// Mirrors libs/papercusp/packages/orchestrator/src/{loader,prompt-resolve}.ts at the
// granularity this static guard needs (no PG / zod parse) — extends chain + array-replace
// merge for deps, base-prefix + leaf-first concrete for prompts.

function readYaml(p: string): Record<string, unknown> | null {
  if (!existsSync(p)) return null;
  return parseYaml(readFileSync(p, 'utf8')) as Record<string, unknown>;
}

function extendsChain(id: string): string[] {
  const chain: string[] = [];
  const seen = new Set<string>();
  const walk = (x: string) => {
    if (seen.has(x)) return;
    seen.add(x);
    chain.push(x);
    const y = readYaml(join(BP_DIR, x, 'blueprint.yaml'));
    const ext = (y?.extends ?? null) as unknown;
    if (ext == null) return;
    for (const e of Array.isArray(ext) ? ext : [ext]) walk(String(e));
  };
  walk(id);
  if (!chain.includes('base')) chain.push('base');
  return chain;
}

/** Effective deps.tools — the leaf-most blueprint in the chain that declares a non-empty
 *  tools array wins (arrays replace wholesale child-over-parent, per the loader's mergeRaw). */
function effectiveDeps(id: string): Set<string> {
  for (const bid of extendsChain(id)) {
    const y = readYaml(join(BP_DIR, bid, 'blueprint.yaml'));
    const tools = (y?.dependencies as { tools?: unknown } | undefined)?.tools;
    if (Array.isArray(tools) && tools.length) return new Set(tools.map(String));
  }
  return new Set();
}

/** The roles a blueprint declares (roles[].id + spine.decider + deciderAlternatives). */
function rolesOf(id: string): string[] {
  const y = readYaml(join(BP_DIR, id, 'blueprint.yaml'));
  const roles: string[] = [];
  for (const r of (y?.roles as Array<{ id?: string }> | undefined) ?? []) {
    if (r?.id) roles.push(r.id);
  }
  const spine = y?.spine as { decider?: string; deciderAlternatives?: string[] } | undefined;
  if (spine?.decider) roles.push(spine.decider);
  if (Array.isArray(spine?.deciderAlternatives)) roles.push(...spine.deciderAlternatives);
  return [...new Set(roles)];
}

/** The prompt files composing a role's prompt: base `<role>.base.md` prefix (if distinct) then
 *  the leaf-first concrete `<role>.md` across the extends chain, else base `<role>.md`. */
function resolvePromptFiles(id: string, role: string): string[] {
  const chain = extendsChain(id);
  const prefix = join(BP_DIR, 'base', 'prompts', `${role}.base.md`);
  let main: string | null = null;
  for (const bid of chain) {
    if (bid === 'base') continue;
    const c = join(BP_DIR, bid, 'prompts', `${role}.md`);
    if (existsSync(c)) {
      main = c;
      break;
    }
  }
  if (!main) {
    const c = join(BP_DIR, 'base', 'prompts', `${role}.md`);
    if (existsSync(c)) main = c;
  }
  const files: string[] = [];
  if (existsSync(prefix) && prefix !== main) files.push(prefix);
  if (main) files.push(main);
  return files;
}

// ─── 4. The allowlist — tools NAMED in a prompt for the role to RECOGNIZE, not to CALL ──
//
// Each entry is a tool a generic/base prompt mentions in PROSE (a peer's action, a wake EVENT,
// a tool the role DESCRIBES but does not itself invoke) for a specific (blueprint/role). Keyed
// `<blueprint>/<role>/<tool>` so an entry can't silently excuse a DIFFERENT role's dark tool.
// Adding here is a deliberate "this is a mention, not a call" decision — the default is to
// DECLARE the tool in deps. (The scheduler tools are intentionally NOT here: they ARE called.)
const MENTION_NOT_CALL_ALLOWLIST = new Set<string>([
  // base/queen.base.md — the shared Queen method prose names a broad surface. These are
  // described/peer-routed actions in the generic base persona, not the coding-Queen's own
  // declared call set (her deps wire her concrete tools); left undeclared by design.
  'coding/queen/db:next-migration',
  'coding/queen/pot:survey',
  'coding/queen/plans:promote',
  'coding/queen/plans:set-plan-status',
  // The Scout-routed draft review section names the rubric-ratify verb in the shared
  // persona prose (a rubric proposal is ratified by filling templateData + promoting);
  // like the plan-lifecycle verbs above it is a generic-persona mention, not in the
  // coding-Queen's concrete deps.
  'coding/queen/rubrics:ratify',
  // coding/operator.md — operator decision-tree prose naming routed/peer actions + a wake event.
  'coding/operator/coord:escalate',
  'coding/operator/db:next-migration',
  'coding/operator/events:await',
  'coding/operator/events:emit',
  // base/documenter.md — names the doc-record verb in prose for the documenter pipeline role.
  'coding-factory/documenter/harness_docs:record',
  // base/bee.base.md — tools the bee RECEIVES / a surface it's described against, never calls:
  //   turn:interrupt — "the Queen or operator ISSUED a turn:interrupt" (the bee is the target).
  //   pot:status    — "invisible to Pause/pot:status" (describing the Queen's visibility surface).
  'bee/bee/turn:interrupt',
  'bee/bee/pot:status',
  // base/bee.base.md + base/queen.base.md — fleet:leave is NAMED, not called: the bee is
  // "told to drop the work" and the Queen tells a PEER to `fleet:leave` (a routed action).
  // Neither role calls it itself; their concrete fleet-membership tools are in deps.
  // (gate-greening 2026-06-30)
  'bee/bee/fleet:leave',
  'coding/queen/fleet:leave',
]);

// ─── 5. The blueprints under guard ──────────────────────────────────────────
// Every blueprint that ships its own prompts/ dir (a role prompt that could carry a dark tool),
// PLUS `bee` (its bee-role prompt lives in base/prompts/bee.base.md — the P-003 regression site).

function blueprintsWithPrompts(): string[] {
  const ids = readdirSync(BP_DIR).filter((d) => {
    const p = join(BP_DIR, d);
    return statSync(p).isDirectory() && existsSync(join(p, 'blueprint.yaml')) && existsSync(join(p, 'prompts'));
  });
  if (!ids.includes('cup')) ids.push('cup'); // bee's prompt is in base, but it's the P-003 site
  return ids.sort();
}

interface Pair {
  blueprint: string;
  role: string;
  files: string[];
  deps: Set<string>;
}
function blueprintRolePairs(): Pair[] {
  const pairs: Pair[] = [];
  for (const id of blueprintsWithPrompts()) {
    const deps = effectiveDeps(id);
    for (const role of rolesOf(id)) {
      const files = resolvePromptFiles(id, role);
      if (files.length) pairs.push({ blueprint: id, role, files, deps });
    }
  }
  return pairs;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('blueprint prompt dark-tools (no prompt may reference a tool absent from deps)', () => {
  it('the tool catalog and the guarded blueprint set are non-empty (sanity: the guard can SEE the world)', () => {
    expect(CATALOG.size).toBeGreaterThan(50);
    expect(CATALOG.has('scheduler:get_next')).toBe(true);
    expect(CATALOG.has('scheduler:set_claim_spec')).toBe(true);
    const pairs = blueprintRolePairs();
    expect(pairs.length).toBeGreaterThan(0);
  });

  it('EVERY catalog-confirmed tool referenced in a role prompt is declared in that blueprint deps (no dark tool)', () => {
    const offenders: string[] = [];
    for (const { blueprint, role, files, deps } of blueprintRolePairs()) {
      const mentions = new Set<string>();
      for (const f of files) for (const t of parseToolMentions(readFileSync(f, 'utf8'))) mentions.add(t);
      for (const tool of mentions) {
        if (!CATALOG.has(tool)) continue; // prose that merely looks like group:verb — not a tool
        if (deps.has(tool)) continue; // declared — good
        if (MENTION_NOT_CALL_ALLOWLIST.has(`${blueprint}/${role}/${tool}`)) continue; // named, not called
        offenders.push(
          `${blueprint}/${role}: prompt references "${tool}" (a real tool) but it is NOT in dependencies.tools ` +
            `(files: ${files.map((f) => f.replace(BP_DIR + '/', '')).join(', ')}). ` +
            `Add it to blueprints/${blueprint}/blueprint.yaml dependencies.tools, or — if the prompt only ` +
            `NAMES it (a peer's action / a wake event / a described-not-called verb) — add ` +
            `"${blueprint}/${role}/${tool}" to MENTION_NOT_CALL_ALLOWLIST with that justification.`,
        );
      }
    }
    expect(offenders, `Dark tool(s) found:\n  ${offenders.join('\n  ')}`).toEqual([]);
  });

  // ── Load-bearing regression locks: the EXACT P-003 wiring. These pin the bug shut even if a
  //    future refactor weakens the general check — a scheduler dark tool fails HERE, by name. ──
  //
  // NOTE on the prompt half: the bee/queen prompts reference the scheduler verb both QUALIFIED
  // (`scheduler:get_next`, the literal MCP name the dark-tool lint above sees) AND, in running
  // prose, by its bare verb (`get_next` / the "claim SPEC" the Queen authors). The lock requires
  // BOTH the deps declaration (the wiring that was MISSING and blocked P-003) AND that the prompt
  // names the tool — accepting either the qualified token or the bare verb, so a stylistic prose
  // mention still counts, while the deps half is the hard guarantee.

  const referencesTool = (text: string, qualified: string, bareVerb: string): boolean =>
    parseToolMentions(text).has(qualified) || new RegExp('`' + bareVerb + '`').test(text);

  it('bee blueprint: the bee prompt CALLS get_next AND the blueprint DECLARES scheduler:get_next (P-003 lock)', () => {
    const deps = effectiveDeps('cup');
    expect(deps.has('scheduler:get_next')).toBe(true); // the wiring that was missing
    const promptText = resolvePromptFiles('cup', 'cup').map((f) => readFileSync(f, 'utf8')).join('\n');
    expect(referencesTool(promptText, 'scheduler:get_next', 'get_next')).toBe(true);
  });

  it('coding blueprint: the queen prompt STEERS via the claim spec AND the blueprint DECLARES scheduler:set_claim_spec (P-003 lock)', () => {
    const deps = effectiveDeps('coding');
    expect(deps.has('scheduler:set_claim_spec')).toBe(true); // the wiring that was missing
    const promptText = resolvePromptFiles('coding', 'mug').map((f) => readFileSync(f, 'utf8')).join('\n');
    // The Queen prompt authors per-bee claim SPECS — accept the qualified verb OR the "claim spec"
    // steering language the P-002 prompt uses for that tool.
    expect(
      referencesTool(promptText, 'scheduler:set_claim_spec', 'set_claim_spec') || /claim\s+spec/i.test(promptText),
    ).toBe(true);
  });

  it('the allowlist contains NO scheduler tool — scheduler verbs are CALLED, never merely named', () => {
    for (const entry of MENTION_NOT_CALL_ALLOWLIST) {
      expect(entry.includes('scheduler:'), `scheduler tool wrongly allowlisted as mention-only: ${entry}`).toBe(false);
    }
  });

  it('every allowlist entry is still a REAL dark reference (no stale excuses linger)', () => {
    // An allowlist entry that no longer corresponds to an actual prompt-references-but-undeclared
    // pairing is dead weight that hides intent — assert each one is still load-bearing.
    const live = new Set<string>();
    for (const { blueprint, role, files, deps } of blueprintRolePairs()) {
      const mentions = new Set<string>();
      for (const f of files) for (const t of parseToolMentions(readFileSync(f, 'utf8'))) mentions.add(t);
      for (const tool of mentions) {
        if (CATALOG.has(tool) && !deps.has(tool)) live.add(`${blueprint}/${role}/${tool}`);
      }
    }
    const stale = [...MENTION_NOT_CALL_ALLOWLIST].filter((e) => !live.has(e));
    expect(stale, `Stale allowlist entries (no longer a dark reference — remove them):\n  ${stale.join('\n  ')}`).toEqual([]);
  });
});
