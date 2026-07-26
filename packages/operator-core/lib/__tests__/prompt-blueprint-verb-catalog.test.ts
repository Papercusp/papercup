/**
 * Lint: a prompt or blueprint that NAMES a verb absent from the live tool
 * catalog fails the build (agent-trap-guards-2026-07-26 P-007).
 *
 * Sibling to `lint:no-retired` (which only catches `_retired/` IMPORTS and is
 * blind to a prompt STRING) and blueprint-deps-catalog.test.ts (which checks a
 * blueprint's declared `dependencies.tools`, not free prose). This test scans
 * backtick-quoted `group:verb` / `group.verb` tokens across
 * apps/operator/prompts/**\/*.md and
 * libs/papercusp/packages/harness/blueprints/**\/*.{yaml,md} (the same
 * surfaces P-004's retiring-a-surface sweep names) and asserts each one
 * resolves against the static tool catalog (../static-tool-catalog.ts —
 * SHARED with blueprint-deps-catalog.test.ts, so this is not a second
 * catalog-building scanner).
 *
 * Converts today's silent mid-procedure failure ("step 6: call
 * `messages:send`") into a build-time red.
 *
 * SURFACE-PRECISE, not word-level (P-005's lesson): a bare token-match over
 * free prose is its own false-positive generator — arg:value pairs
 * (`confirm:true`), `ctx.*` method access, DB schema.table refs, deliberate
 * "there is no X" / "don't call X" cautions that NAME a dead or non-tool
 * identifier, model:effort specs, event-key examples, etc. all share the
 * `` `word:word` ``/`` `word.word` `` shape without being a tool reference.
 * Each exclusion below is EMPIRICALLY justified (verified against the real
 * corpus, P-007, 2026-07-26) — a NEW false positive is a real category to add
 * here with a reason, exactly like scan-retirement-surface.mjs's allowlist
 * convention (P-005, this same plan); a genuinely new unresolved token is a
 * real dead/typo'd verb reference to fix.
 *
 * (This test found + P-007 fixed one real live regression while landing:
 * `apps/operator/prompts/papercusp-compaction.protocol.md` instructed calling
 * `session:request_compaction` — underscore — when the real tool is
 * `session:request-compaction` — hyphen.)
 */
import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { buildFullToolNameCatalog } from '../static-tool-catalog';

const __dirname = dirname(new URL(import.meta.url).pathname);
const REPO = join(__dirname, '../../../../');

const SCAN_ROOTS = ['apps/operator/prompts', 'libs/papercusp/packages/harness/blueprints'];

function listScannedFiles(): string[] {
  const out: string[] = [];
  for (const root of SCAN_ROOTS) {
    if (!existsSync(join(REPO, root))) continue;
    const files = execSync(`git ls-files -- ${JSON.stringify(root)}`, {
      cwd: REPO,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
      .split('\n')
      .filter(Boolean)
      .filter((f) => /\.(md|ya?ml)$/i.test(f));
    out.push(...files);
  }
  return out;
}

// backtick-delimited `group:verb` / `group.verb` — the convention every
// papercusp doc/prompt/contract uses to name a tool (repo CLAUDE.md: "Every
// papercusp doc/prompt/contract writes tool names in colon form").
const TOKEN_RE = /`([a-zA-Z][a-zA-Z0-9_-]*)([:.])([a-zA-Z][a-zA-Z0-9_:.\-]*)`/g;

// Whole-token match ends in a known file extension → a filename, not a verb
// (`features.json`, `CLAUDE.md`, `answer.txt`, ...).
const FILE_EXT_RE =
  /\.(md|mdx|json|txt|ts|tsx|js|mjs|jsx|yaml|yml|py|sh|sql|css|html|lock|log|toml|cfg|ini|env|xml|csv|pdf)$/i;

// arg:value literal (`confirm:true`, `dryRun:true`, ...) — not a verb call.
const ARG_VALUE_RE = /:(?:true|false)$/;

// Exact tokens verified (P-007, 2026-07-26) to be real, deliberate non-tool
// references rather than an instruction to call them — each has a concrete
// reason so a future re-run doesn't re-litigate it by hand.
const KNOWN_NON_TOOL_TOKENS: Record<string, string> = {
  'PreToolUse:Edit': 'a Claude Code hook event name, not an MCP tool',
  'coord:orient.codexLocks':
    "a dot-path reference into coord:orient's own response field `codexLocks`, not a second tool",
  'ctx.askUser': 'defineTool ctx-object method access (endpoint-route ctx API), not an MCP tool',
  'ctx.emit': 'defineTool ctx-object method access (endpoint-route ctx API), not an MCP tool',
  'ctx.harnessSlug': 'defineTool ctx-object property access, not an MCP tool',
  'ctx.progress': 'defineTool ctx-object method access (endpoint-route ctx API), not an MCP tool',
  'ctx.publishState': 'defineTool ctx-object method access (endpoint-route ctx API), not an MCP tool',
  'features:update':
    'deliberately named as a NON-EXISTENT verb — the prose reads "there is no `features:update`" (a documented caution, not an instruction to call it)',
  'harness_shared.memory_canonical': 'a Postgres schema.table reference, not a tool',
  'harness_shared.spawned_agents': 'a Postgres schema.table reference, not a tool',
  'metadata.covers': 'a JS field-access example in prose, not a tool call',
  'observation.ratings': 'a JS field-access example in prose (observation shape), not a tool call',
  'observation.rubricRef': 'a JS field-access example in prose (observation shape), not a tool call',
  'orchestrator.spawn':
    'an internal (non-agent-callable) function named as a "don\'t call this directly" caution, not a catalog verb',
  'promote:plan':
    'a structured chat-output DIRECTIVE BLOCK keyword the assistant emits for the UI to parse, not an agent-tool catalog verb',
  'promptOverride.su': 'a hive_settings config KEY reference, not a tool',
  'release:green': 'an EVENT key example (events:await/emit), not a tool-catalog verb',
  'select:mcp__papercusp-su__tools_find': 'a literal ToolSearch QUERY STRING example, not a tool name itself',
  'server:verb': 'a literal placeholder illustrating the `server:verb` naming CONVENTION, not a real tool',
  'sonnet:high': 'a model:effort spec example, not a tool',
  'work-item:claimable': 'an EVENT key (events:await payload_filter target), not a tool-catalog verb',
};

interface Hit {
  token: string;
  file: string;
  line: number;
}

function scanForVerbTokens(files: string[]): Hit[] {
  const hits: Hit[] = [];
  for (const f of files) {
    const full = join(REPO, f);
    if (!existsSync(full)) continue;
    let text: string;
    try {
      text = readFileSync(full, 'utf8');
    } catch {
      continue;
    }
    for (const m of text.matchAll(TOKEN_RE)) {
      const token = m[1] + m[2] + m[3];
      if (FILE_EXT_RE.test(token)) continue;
      if (ARG_VALUE_RE.test(token)) continue;
      const before = text.slice(0, m.index ?? 0);
      const line = before.split('\n').length;
      hits.push({ token, file: f, line });
    }
  }
  return hits;
}

describe('prompt/blueprint verb references vs the live tool catalog', () => {
  const catalog = buildFullToolNameCatalog(REPO);
  const files = listScannedFiles();
  const hits = scanForVerbTokens(files);

  it('scan sanity — found real files and real candidate tokens', () => {
    expect(files.length).toBeGreaterThan(20);
    expect(hits.length).toBeGreaterThan(50);
    expect(catalog.size).toBeGreaterThan(100);
  });

  it('every KNOWN_NON_TOOL_TOKENS entry still occurs in the corpus (prune stale allowlist entries)', () => {
    const seen = new Set(hits.map((h) => h.token));
    const stale = Object.keys(KNOWN_NON_TOOL_TOKENS).filter((tok) => !seen.has(tok));
    expect(
      stale,
      `these allowlist entries no longer occur anywhere in the scanned corpus — remove them: ${stale.join(', ')}`,
    ).toEqual([]);
  });

  it('every prompt/blueprint verb reference resolves against the live tool catalog', () => {
    const unresolved = hits.filter((h) => !catalog.has(h.token) && !(h.token in KNOWN_NON_TOOL_TOKENS));
    const message =
      `${unresolved.length} prompt/blueprint reference(s) name a verb absent from the live tool catalog ` +
      `(a retired/renamed/typo'd tool — the exact WI-6097-style silent mid-procedure failure this lint exists to catch):\n` +
      unresolved.map((h) => `  ${h.file}:${h.line}  \`${h.token}\``).join('\n') +
      `\n\nEach is either a genuine dead reference to fix, or a NEW non-tool false positive to add to ` +
      `KNOWN_NON_TOOL_TOKENS above with a reason (surface-precise convention, P-005).`;
    expect(unresolved, message).toEqual([]);
  });
});
