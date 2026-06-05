/**
 * gen-doc-role-registry.ts — project the agent role + persona registry into a
 * Starlight reference page (starlight-projection-generators-2026-06-05 P-002).
 *
 * Two sources, joined:
 *   - `AGENT_ROLES` (packages/agent-mcp/src/role-config.ts) — the built-in role ids
 *     that appear in tool `roles:` allowlists / `byRole` guidance / quotas.
 *   - the persona files `libs/papercusp/packages/harness/prompts/<role>.md` — the
 *     spawn prompt for each role (not every role has one: operator/oracle are chat
 *     surfaces; and many personas are blueprint deciders/helpers not in AGENT_ROLES).
 *
 * Emits reference/role-registry.md. Deterministic fs/code read of a low-churn
 * source → CI-gated (D-002).
 *
 *   npx tsx scripts/gen-doc-role-registry.ts          # write
 *   npx tsx scripts/gen-doc-role-registry.ts --check  # fail if drifted
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT_ROLES } from '../packages/agent-mcp/src/role-config';
import { REPO_ROOT, emitOrCheck, generatedBanner, frontmatter, cell } from './lib/doc-projection';

const PROMPTS_DIR = join(REPO_ROOT, 'libs', 'papercusp', 'packages', 'harness', 'prompts');
const SUMMARY_MAX = 200;

/** The persona role ids = top-level *.md (minus README), basename without extension. */
function personaRoleIds(): string[] {
  return readdirSync(PROMPTS_DIR)
    .filter((f) => f.endsWith('.md') && f.toLowerCase() !== 'readme.md')
    .map((f) => f.replace(/\.md$/, ''))
    .sort();
}

function personaPath(role: string): string {
  return join(PROMPTS_DIR, `${role}.md`);
}

/**
 * Pull a one-line summary out of a persona file: skip frontmatter, leading
 * blockquotes (migration notes), and code fences; take the first `# H1` text if
 * present, else the first real prose paragraph. Collapsed to one line, truncated.
 */
function personaSummary(role: string): string | null {
  const p = personaPath(role);
  if (!existsSync(p)) return null;
  let md = readFileSync(p, 'utf8');
  // Strip a leading YAML frontmatter block.
  md = md.replace(/^---\n[\s\S]*?\n---\n/, '');
  const lines = md.split('\n');

  let firstHeading: string | null = null;
  let inFence = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (!line) continue;
    if (line.startsWith('>')) continue; // blockquote (migration notes etc.)
    const h1 = line.match(/^#\s+(.*)$/);
    if (h1) {
      firstHeading = h1[1].trim();
      continue;
    }
    if (line.startsWith('#')) continue; // deeper heading — keep scanning for prose
    if (/^[-*]\s/.test(line)) continue; // list item — keep scanning for a prose lead
    // First real prose line.
    const summary = line.replace(/^\*\*[^*]+\*\*:?\s*/, ''); // drop a leading bold label
    return truncate(firstHeading ? `${firstHeading} — ${summary}` : summary);
  }
  // No prose found — fall back to the heading alone.
  return firstHeading ? truncate(firstHeading) : null;
}

function truncate(s: string): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > SUMMARY_MAX ? one.slice(0, SUMMARY_MAX - 1).trimEnd() + '…' : one;
}

function build(): string {
  const builtin = [...AGENT_ROLES];
  const builtinSet = new Set<string>(builtin);
  const personas = personaRoleIds();
  const personaSet = new Set(personas);
  const personaOnly = personas.filter((r) => !builtinSet.has(r));
  const builtinNoPersona = builtin.filter((r) => !personaSet.has(r));

  const lines: string[] = [];
  lines.push(
    frontmatter({
      title: 'Role & persona registry',
      description:
        'The built-in agent roles (AGENT_ROLES) joined with their spawn personas. Generated from role-config.ts + the harness persona files.',
      sidebarOrder: 2,
    }),
  );
  lines.push('');
  lines.push(generatedBanner('gen:doc-role-registry'));
  lines.push('');
  lines.push('# Role & persona registry');
  lines.push('');
  lines.push(
    'A **role** is what kind of agent a spawn is. `AGENT_ROLES` is the runtime source of truth for the built-in role ids (tool `roles:` allowlists, `byRole` guidance, quotas); a role\'s **persona** is its spawn prompt at `libs/papercusp/packages/harness/prompts/<role>.md`. Not every role has a persona (operator/oracle are chat surfaces), and many personas are blueprint deciders/helpers that are not themselves `AGENT_ROLES` entries.',
  );
  lines.push('');
  lines.push(
    `Sources: \`packages/agent-mcp/src/role-config.ts\` (${builtin.length} built-in roles) + \`libs/papercusp/packages/harness/prompts/*.md\` (${personas.length} personas).`,
  );
  lines.push('');

  // Built-in roles.
  lines.push('## Built-in roles (`AGENT_ROLES`)');
  lines.push('');
  lines.push('These ids appear in tool `roles:` allowlists, `rolesQuota` keys, and `byRole` guidance overrides. The set is open — plugins contribute `<plugin>:<role>` ids at runtime.');
  lines.push('');
  lines.push('| Role | Persona | Summary |');
  lines.push('|---|---|---|');
  for (const role of builtin) {
    const hasPersona = personaSet.has(role);
    const summary = hasPersona ? personaSummary(role) : null;
    lines.push(`| \`${cell(role)}\` | ${hasPersona ? '✓' : '—'} | ${cell(summary ?? (hasPersona ? '' : 'chat/runtime surface — no spawn persona'))} |`);
  }
  lines.push('');
  if (builtinNoPersona.length > 0) {
    lines.push(`Built-in roles with no persona file (chat/runtime surfaces): ${builtinNoPersona.map((r) => `\`${cell(r)}\``).join(', ')}.`);
    lines.push('');
  }

  // Persona-only roles.
  lines.push('## Persona-only roles (blueprint deciders & helpers)');
  lines.push('');
  lines.push('These have a spawn persona but are not `AGENT_ROLES` entries — blueprint deciders (`director`, `*-director`, `scanner`) and the reactive helpers blueprints dispatch (`searcher`, `finding-verifier`, `transformer`, …).');
  lines.push('');
  lines.push('| Role | Summary |');
  lines.push('|---|---|');
  for (const role of personaOnly) {
    lines.push(`| \`${cell(role)}\` | ${cell(personaSummary(role) ?? '')} |`);
  }
  lines.push('');

  return lines.join('\n');
}

emitOrCheck('role-registry.md', build(), { advisory: false });
