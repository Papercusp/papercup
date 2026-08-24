/**
 * docs:author — CREATE a manual / agent-insights doc the right way, in one call.
 *
 * Closes the EI-5260 capability gap: before this tool the docs surface was
 * read-only (docs:get/search/outline) + post-write provenance
 * (harness_docs:record/anchor — both "call AFTER writing the file"). There was NO
 * tool that WROTE a new doc, so every agent re-derived three things by hand and
 * repeatedly got them wrong:
 *   1. the canonical docs ROOT (agents wrote to a projection dir, e.g.
 *      apps/operator/public/internal/docs/..., not the authored
 *      apps/operator-docs/src/content/docs/... that docs:search / the doc-steward
 *      index);
 *   2. the FRONTMATTER convention (missing discovered/tags/status/documents);
 *   3. the must-ANCHOR step (left untracked → silently rots).
 *
 * docs:author does all three: it resolves the write root the SAME way the read +
 * anchor systems resolve it (resolveHarnessDocPaths → the harness's docsRoot, which
 * for papercusp is apps/operator-docs/src/content/docs via .papercusp/docs.json), it
 * stamps the full frontmatter, and it AUTO-anchors + verifies the doc so it ships
 * drift-tracked. Writing to that exact root is also why the anchor reads the file
 * correctly (the EI-4889 silent-no-op was a wrong-dir read).
 */

import { promises as fs, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { parseFrontmatterBlock } from '@papercusp/docs-engine';
import { stringify as stringifyYaml } from 'yaml';
import { resolveHarnessDocPaths } from '../../harness/docs/harness-repo';
import { safeJoinUnderRoot } from '../../harness/docs/doc-fs';
import { anchorManualDoc } from '../../harness/docs/manual-anchor';
import { applyProjectionBanner } from '../../harness/docs/authored-doc-projection';
import { getAuthoredDocContent } from '../../harness/docs/doc-record';
import { resolveHarnessScope, isEngineeringDocsSentinel } from '../_harness-scope';
import { engineeringAdapter, invalidateEngineeringAdapter } from './_engineering-adapter';
import { refreshDocPageSections } from '../../search/doc-embed-sync';
import { findMdxCompileError } from '../../content-lint/mdx';

// ── Pure helpers (exported for unit tests — these encode the footgun-prevention) ──

/**
 * Normalize/validate a doc slug or canonical doc path.
 *
 * Read surfaces return page ids as `<section>/<slug>` (for example,
 * `agent-insights/my-runbook`), and agents naturally hand that value to the
 * write surface when updating the page. Keep the final segment as the slug
 * and route the preceding path to `section`; a backslash is still rejected so
 * this does not become a platform-specific filesystem path parser.
 */
export function normalizeSlug(
  raw: string,
): { ok: true; slug: string; section?: string } | { ok: false; error: string } {
  let s = raw.trim().toLowerCase();
  s = s.replace(/\.mdx?$/, ''); // tolerate a trailing .md/.mdx
  if (!s) return { ok: false, error: 'slug_required' };
  if (s.includes('\\')) {
    return { ok: false, error: 'slug_must_use_forward_slashes — use `<section>/<slug>` for a canonical doc path' };
  }
  if (s.includes('/')) {
    const parts = s.split('/');
    const leaf = parts.pop() ?? '';
    if (!leaf) return { ok: false, error: 'slug_required' };
    const sectionRes = normalizeSection(parts.join('/'));
    if (!sectionRes.ok) return sectionRes;
    s = leaf;
    if (!/^[a-z0-9][a-z0-9-]*$/.test(s)) {
      return { ok: false, error: 'slug_must_be_kebab_case — lowercase letters, digits, and dashes only (e.g. my-new-insight)' };
    }
    return { ok: true, slug: s, section: sectionRes.section };
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(s)) {
    return { ok: false, error: 'slug_must_be_kebab_case — lowercase letters, digits, and dashes only (e.g. my-new-insight)' };
  }
  return { ok: true, slug: s };
}

/** Normalize/validate a section dir under the docs root. Default agent-insights. */
export function normalizeSection(raw: string | undefined): { ok: true; section: string } | { ok: false; error: string } {
  const s = (raw ?? 'agent-insights').trim().replace(/^\/+|\/+$/g, '');
  if (!s) return { ok: true, section: 'agent-insights' };
  if (s.split('/').some((seg) => seg === '..' || seg === '.' || seg === '')) {
    return { ok: false, error: 'section_path_invalid — no "." / ".." segments' };
  }
  if (!/^[a-z0-9][a-z0-9/-]*$/.test(s)) {
    return { ok: false, error: 'section_must_be_kebab_path — lowercase letters, digits, dashes, slashes only' };
  }
  return { ok: true, section: s };
}

/**
 * The curated insights index (reference/agent-insights-index.md) is a GENERATED projection —
 * authoring a doc does not refresh it, so the new page is absent from the index until someone
 * runs the generator. We nudge rather than regenerate on write: the index is deliberately
 * non-gating and tolerated-stale (D-002 — the fleet writes insights continuously), so
 * regenerating here would fight the design intent. `docs:search` finds the doc either way.
 *
 * Scoped to papercusp's agent-insights dir because that is the only thing the generator reads
 * (`scripts/gen-doc-insights-index.ts` hardcodes apps/operator-docs/src/content/docs/agent-insights) —
 * pointing a harness-scoped author at that script would be a nudge to run a no-op. (EI-15927)
 */
export function insightsIndexNudge(section: string, harnessSlug: string): string | null {
  if (section !== 'agent-insights' || harnessSlug !== 'papercusp') return null;
  return 'the curated insights index is generated and was NOT refreshed — run `npm run gen:doc-insights-index` to list this doc in reference/agent-insights-index.md (docs:search finds it either way).';
}

/**
 * Which harness's docs root this write targets.
 *
 * Resolved the SAME way the docs read adapters resolve it — explicit `harness` → ctx
 * harness → (superuser) 'papercusp', the engineering-reference owner — so the write
 * root == the anchor read root == apps/operator-docs/src/content/docs.
 *
 * EI-20100921170504541 — the `'engineering'` branch. FINDING a page and WRITING it are
 * one workflow, so both halves must accept the same argument for the same corpus.
 * `docs:search`'s own schema tells a workspace-scoped caller to pass `'engineering'`
 * (the literal the `_mcp-handler` workspace clamp does not intercept —
 * EI-18894866320087268). Doing the natural thing and passing it back here used to fail
 * `unknown_harness`, because {@link resolveHarnessScope} classifies it as a CONCRETE
 * slug and no such harness is registered — an error naming a registry concept rather
 * than the fix, so it read as "this corpus is unreachable from here", the opposite of
 * true.
 *
 * Handled HERE rather than inside {@link resolveHarnessScope} on purpose: that helper is
 * shared with `plans:*` and `harness_docs:*`, and this sentinel is deliberately invisible
 * to the workspace clamp. Teaching the shared resolver about it would hand every one of
 * those tools a cross-harness escape the clamp cannot see — a tenant-data boundary, not
 * a docs one. {@link isEngineeringDocsSentinel}'s own contract scopes it to doc tools
 * treating it "exactly like HarnessScope's 'all' kind", which is what this does.
 */
export function resolveAuthorHarness(
  argHarness: string | null | undefined,
  ctx: { harnessSlug?: string | null; isSuperuser?: boolean } | null | undefined,
): { ok: true; harnessSlug: string; engineering: boolean } | { ok: false; error: string } {
  // `engineering` distinguishes "the shared engineering reference" from "the papercusp
  // harness named explicitly" — both resolve to the same docs root, but they are
  // different INTENTS and the emitted `surface` metadata reports them apart.
  if (isEngineeringDocsSentinel(argHarness)) return { ok: true, harnessSlug: 'papercusp', engineering: true };
  const scope = resolveHarnessScope(argHarness, ctx);
  if (scope.kind === 'harness') return { ok: true, harnessSlug: scope.slug, engineering: false };
  if (scope.kind === 'all') return { ok: true, harnessSlug: 'papercusp', engineering: true };
  // kind === 'none': no harness in context and not the 'all' sentinel.
  if (ctx?.isSuperuser) return { ok: true, harnessSlug: 'papercusp', engineering: true };
  return {
    ok: false,
    error:
      "harness_required — pass harness (a concrete slug), or omit it / pass 'engineering' for the engineering reference",
  };
}

/** The `description` length we ask for — a search/outline hook reads best short. */
export const DESCRIPTION_RECOMMENDED_MAX = 500;
/** The length we actually REFUSE at. Generous on purpose — see the schema comment. */
export const DESCRIPTION_HARD_MAX = 1200;

/**
 * A warning for an over-long description, or null. Split out from the schema because a
 * REJECTION at this boundary costs a full resend of the body, which is out of all
 * proportion to overshooting a display field (EI-20100921170504541).
 */
export function descriptionLengthWarning(description: string): string | null {
  const n = description.trim().length;
  if (n <= DESCRIPTION_RECOMMENDED_MAX) return null;
  return `description is ${n} chars — over the recommended ${DESCRIPTION_RECOMMENDED_MAX}. Accepted, but it is the index hook docs:search and the outline show, so it reads best tightened to one line.`;
}

/** Strip a leading YAML frontmatter block from a body (we generate our own). */
export function stripLeadingFrontmatter(body: string): { body: string; stripped: boolean } {
  const m = /^﻿?\s*---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/.exec(body);
  if (m && m.index === 0) {
    return { body: body.slice(m[0].length).replace(/^\r?\n/, ''), stripped: true };
  }
  return { body, stripped: false };
}

/** string | string[] (possibly comma-joined) → trimmed, de-duped, non-empty array. */
export function normalizeList(input: unknown): string[] {
  if (input == null) return [];
  const raw = Array.isArray(input) ? input : [input];
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== 'string') continue;
    for (const piece of v.split(',')) {
      const t = piece.trim();
      if (t && !out.includes(t)) out.push(t);
    }
  }
  return out;
}

export interface FrontmatterInput {
  title: string;
  description: string;
  discovered: string; // YYYY-MM-DD
  status: string;
  tags: string[];
  documents: string[];
  plans: string[];
  sidebarOrder?: number;
  /** Explicit normative classification. Omitted means no classification on a new doc. */
  normative?: boolean;
  /** Explicit convention surface(s) governed by this doc. */
  governs?: string[];
  /** Existing top-level frontmatter carried through an overwrite. */
  preservedFrontmatter?: Record<string, unknown>;
  /**
   * OKF v0.2's ONE mandatory field (`lint:okf-conformance` fails a doc without it).
   *
   * This tool omitted it until 2026-08-10, so every doc it produced was born
   * OKF-nonconformant — harmless while hand-authoring was the common path and the corpus
   * carried it anyway (measured: 578 Insight / 94 Convention), and a fleet-wide gate red
   * the moment docs:author became the ONLY supported way to author (P-008). Defaulted
   * rather than required: a mandatory arg would break every existing caller to prevent a
   * failure a sensible default already prevents.
   */
  type: string;
}

/** The OKF `type:` for a doc, defaulted by section. */
export const DEFAULT_DOC_TYPE = 'Insight';

/**
 * Read the existing frontmatter mapping before an overwrite.
 *
 * `docs:author` owns only the fields it can intentionally edit. The rest of a document's
 * top-level metadata is still authored data, so replacing the generated block must carry it
 * forward. Use the shared parser rather than a second YAML/frontmatter implementation; the
 * `dates:'string'` option is load-bearing because this mapping is about to be round-tripped.
 */
export function parseExistingFrontmatter(existingContent: string | null | undefined): Record<string, unknown> {
  if (!existingContent) return {};
  const source = existingContent.startsWith('\uFEFF') ? existingContent.slice(1) : existingContent;
  const parsed = parseFrontmatterBlock(source, { dates: 'string' });
  return parsed.ok && parsed.data ? parsed.data : {};
}

/** YAML double-quoted scalar — JSON.stringify is a valid YAML flow scalar. */
function yamlStr(s: string): string {
  return JSON.stringify(s);
}

/** Build the full frontmatter block (including the wrapping --- lines). */
export function buildFrontmatter(fm: FrontmatterInput): string {
  const lines: string[] = ['---'];
  const emittedKeys = new Set<string>();
  lines.push(`title: ${yamlStr(fm.title)}`);
  emittedKeys.add('title');
  lines.push(`description: ${yamlStr(fm.description)}`);
  emittedKeys.add('description');
  lines.push(`type: ${fm.type}`);
  emittedKeys.add('type');
  lines.push(`discovered: ${fm.discovered}`);
  emittedKeys.add('discovered');
  if (fm.tags.length) lines.push(`tags: [${fm.tags.map(yamlStr).join(', ')}]`);
  emittedKeys.add('tags');
  lines.push(`status: ${fm.status}`);
  emittedKeys.add('status');
  if (fm.documents.length) {
    lines.push('documents:');
    for (const d of fm.documents) lines.push(`  - ${yamlStr(d)}`);
  }
  emittedKeys.add('documents');
  if (fm.plans.length) {
    lines.push('plans:');
    for (const p of fm.plans) lines.push(`  - ${yamlStr(p)}`);
  }
  emittedKeys.add('plans');
  if (typeof fm.sidebarOrder === 'number' && Number.isFinite(fm.sidebarOrder)) {
    lines.push('sidebar:');
    lines.push(`  order: ${Math.trunc(fm.sidebarOrder)}`);
    emittedKeys.add('sidebar');
  }
  if (typeof fm.normative === 'boolean') {
    lines.push(`normative: ${fm.normative}`);
    emittedKeys.add('normative');
  }
  if (fm.governs !== undefined) {
    if (fm.governs.length) {
      lines.push('governs:');
      for (const governed of fm.governs) lines.push(`  - ${yamlStr(governed)}`);
    } else {
      lines.push('governs: []');
    }
    emittedKeys.add('governs');
  }
  // Preserve every top-level key that this writer did not emit. This is intentionally
  // generic: the next metadata field added to the corpus must not require another point fix.
  for (const [key, value] of Object.entries(fm.preservedFrontmatter ?? {})) {
    if (emittedKeys.has(key)) continue;
    const serialized = stringifyYaml({ [key]: value }, { lineWidth: 0 }).trimEnd();
    if (serialized) lines.push(serialized);
  }
  lines.push('---');
  return lines.join('\n');
}

/** Today's date as YYYY-MM-DD (server-side handler — Date is available here). */
export function todayIso(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** Preserve a valid canonical vintage on overwrite; stamp today only for creation/legacy gaps. */
export function discoveredForWrite(existingContent: string | null | undefined, today = todayIso()): string {
  if (!existingContent) return today;
  const yaml = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(existingContent)?.[1];
  const discovered = yaml?.match(/^discovered:\s*["']?(\d{4}-\d{2}-\d{2})["']?\s*$/m)?.[1];
  return discovered ?? today;
}

/** Assemble the full .mdx file content from frontmatter + body. */
export function composeDoc(fm: FrontmatterInput, rawBody: string): string {
  const { body } = stripLeadingFrontmatter(rawBody);
  const trimmed = body.replace(/^\s+/, '').replace(/\s+$/, '');
  return `${buildFrontmatter(fm)}\n\n${trimmed}\n`;
}

// ── Tool ──

const argsSchema = z.object({
  slug: z
    .string()
    .min(1)
    .max(120)
    .describe(
      'Kebab-case file slug or canonical doc path (optional .md/.mdx; e.g. "named-fleet-vs-ephemeral-swarm" or "agent-insights/named-fleet-vs-ephemeral-swarm"). A path routes its subdirectory to section and becomes <section>/<slug>.mdx.',
    ),
  title: z.string().min(1).max(200).describe('Human title (frontmatter `title`).'),
  description: z
    .string()
    .min(1)
    // EI-20100921170504541 (second half): this was a hard .max(500), and a REJECTION here
    // costs the caller a resend of the whole call — body included (~6k tokens, measured) —
    // for overshooting a display field by a few words. The failure cost was wildly out of
    // proportion to the mistake, and validating scalars "first" would not have changed it:
    // the body is already on the wire, and any retry re-sends it regardless. So the bound
    // is now a generous sanity limit and the RECOMMENDED length is enforced as a warning
    // instead. Safe to widen: nothing downstream depends on 500 — it is not checked by
    // lint:okf-conformance, the frontmatter writer, or the projection.
    .max(DESCRIPTION_HARD_MAX)
    .describe(
      `One-line summary (frontmatter \`description\`) — this is the index hook docs:search / the outline shows. Keep it under ~${DESCRIPTION_RECOMMENDED_MAX} chars (longer is accepted up to ${DESCRIPTION_HARD_MAX}, with a warning). On overwrite, omit to preserve the existing description, including legacy values above the current limit. Required for new docs.`,
    )
    .optional(),
  body: z
    .string()
    .min(1)
    .describe('The markdown body (frontmatter is GENERATED — do not include a leading --- block; one is stripped + a warning returned if you do).'),
  documents: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .describe(
      'What this doc documents (its drift anchor): repo file paths (packages/.../foo.ts), globs (src/**), feature ids (F-3), or "path :: symbol". STRONGLY recommended — without it the doc is NOT drift-tracked.',
    ),
  tags: z.union([z.string(), z.array(z.string())]).optional().describe('Topic tags (frontmatter `tags`). A PROCEDURAL ordered-steps doc is the RUNBOOK genre: tag it `runbook`, end the slug `-runbook`, and say "runbook" in title/description so docs:search ranks it (agent-insights/runbooks-convention).'),
  plans: z.union([z.string(), z.array(z.string())]).optional().describe('Related plan slugs (frontmatter `plans`).'),
  normative: z.boolean().optional().describe('Optional OKF normative classification. On overwrite, omitted preserves the existing value.'),
  governs: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .describe('Convention surface(s) this doc governs. On overwrite, omitted preserves the existing value.'),
  section: z
    .string()
    .optional()
    .describe('Docs-root-relative section dir. Default "agent-insights" (the runbook/insight section).'),
  status: z.enum(['active', 'superseded', 'draft']).optional().describe('Frontmatter `status`. Default "active".'),
  type: z.string().optional().describe('OKF `type:` — the genre. "Insight" (default) for a discovery/failure-mode; "Convention" for a rule the repo follows.'),
  sidebarOrder: z.number().int().optional().describe('Optional Starlight sidebar order.'),
  verify: z
    .boolean()
    .optional()
    .describe('Stamp the drift baseline to HEAD now (you assert the doc reflects current code). Default true.'),
  overwrite: z.boolean().optional().describe('Allow replacing an existing file at the target path. Default false (refuse to clobber).'),
  harness: z
    .string()
    .optional()
    .describe(
      "Harness whose docs to write into. For the Papercusp engineering reference (apps/operator-docs/... — where agent-insights live) either OMIT this or pass 'engineering', the same literal docs:search takes for that corpus. Otherwise pass a concrete harness slug (for example, 'papercusp'). 'all' is only valid in an unscoped (--all-workspaces) session. Omit only when the session is already scoped to a harness.",
    ),
});

export default defineTool({
  name: 'docs:author',
  description:
    "Create or replace a manual / agent-insights doc the right way, in one call. THE ONLY supported way to author one: Postgres (harness_docs.content) is canonical and the <section>/<slug>.mdx file is a projection of it, so hand-writing that file does not durably create a doc. Stamps the full frontmatter convention (title/description/discovered/tags/status/documents/plans), writes the canonical row, projects the file, and AUTO-anchors + verifies so it ships drift-tracked. Returns { ok, path, slug, section, surface, anchored, status, subjectRef, warnings }.",
  guidance: {
    when:
      'You have a durable HOW-IT-WORKS runbook / failure-mode / hard-won gotcha to write down (the CLAUDE.md "write it as an anchored agent-insights MDX" rule). Pass `documents` with the files/symbols the doc covers so it ships drift-tracked.',
    notWhen:
      'For a quick personal fact use memory:remember (not a doc). To EDIT an existing doc call this tool again with overwrite:true — do NOT hand-edit the .mdx: Postgres is canonical and the file is a projection, so a hand-edit is refused by the next projection and never lands. To only declare a subject_ref use harness_docs:anchor.',
    chaining:
      'docs:author { slug, title, description, body, documents } → (later, on a drift nudge) harness_docs:verify { docId }.',
    seeAlso: [
      'docs:get (read the current page before rewriting it)',
      'docs:outline (find where the page belongs)',
      'harness_docs:list (per-harness PROJECT docs live in a different surface)',
    ],
  },
  capability: 'docs:write',
  requirePrincipal: false,
  agentRoles: ['documenter', 'doc-steward', 'operator', 'worker', 'architect', 'cup', 'curator'],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    const ctxAny = ctx as { harnessSlug?: string; isSuperuser?: boolean; metadata?: (d: Record<string, unknown>) => void };
    const warnings: string[] = [];

    const slugRes = normalizeSlug(args.slug);
    if (!slugRes.ok) return err(slugRes.error);
    const sectionRes = normalizeSection(args.section ?? slugRes.section);
    if (!sectionRes.ok) return err(sectionRes.error);
    const slug = slugRes.slug;
    const section = sectionRes.section;

    // Resolve the target harness the SAME way the docs read adapters do:
    //   explicit `harness` → ctx harness → (superuser) 'papercusp' (the engineering
    //   reference owner). 'all'/'*'/none under superuser maps to 'papercusp' so the
    //   write root == the anchor read root == apps/operator-docs/src/content/docs.
    const harnessRes = resolveAuthorHarness(args.harness, ctxAny);
    if (!harnessRes.ok) return err(harnessRes.error);
    const harnessSlug = harnessRes.harnessSlug;

    const paths = await resolveHarnessDocPaths(harnessSlug);
    if (!paths)
      return err(
        `unknown_harness — ${harnessSlug} is not registered (cannot resolve its docs root). ` +
          `To write the Papercusp engineering reference (agent-insights/…), OMIT \`harness\` entirely ` +
          `or pass 'engineering' — not a concrete slug.`,
      );
    const docId = `${section}/${slug}.mdx`;
    const abs = safeJoinUnderRoot(paths.docsRoot, docId);
    if (!abs) return err('path_traversal — section/slug resolved outside the docs root');

    if (existsSync(abs) && !args.overwrite) {
      return err(`doc_exists — ${docId} already exists; pass overwrite:true to replace it, or edit it with capability:edit`);
    }

    const stripCheck = stripLeadingFrontmatter(args.body);
    if (stripCheck.stripped) {
      warnings.push('a leading --- frontmatter block in `body` was stripped — frontmatter is generated from the args; pass body content only.');
    }

    const existingContent = args.overwrite
      ? await getAuthoredDocContent(harnessSlug, docId).catch(() => null)
      : null;
    const existingFrontmatter = parseExistingFrontmatter(existingContent);
    const inheritedDescription = (() => {
      const value = existingFrontmatter.description;
      return typeof value === 'string' && value.trim() ? value.trim() : undefined;
    })();
    const description = args.description?.trim() || inheritedDescription;
    if (!description) {
      return err(
        args.overwrite
          ? 'description_required — this overwrite has no usable existing description; pass description explicitly.'
          : 'description_required — new docs require description.',
      );
    }
    const descWarning = descriptionLengthWarning(description);
    if (descWarning) warnings.push(descWarning);
    const documents = args.documents === undefined ? normalizeList(existingFrontmatter.documents) : normalizeList(args.documents);
    if (!documents.length) {
      warnings.push('no `documents` provided — the doc is NOT drift-tracked; pass `documents` (files/symbols it covers) so the drift sweep can flag it when that code changes.');
    }
    const inheritedString = (key: string): string | undefined => {
      const value = existingFrontmatter[key];
      return typeof value === 'string' && value.trim() ? value.trim() : undefined;
    };
    const inheritedSidebarOrder = (() => {
      const sidebar = existingFrontmatter.sidebar;
      if (!sidebar || typeof sidebar !== 'object' || Array.isArray(sidebar)) return undefined;
      const order = (sidebar as Record<string, unknown>).order;
      return typeof order === 'number' && Number.isFinite(order) ? Math.trunc(order) : undefined;
    })();
    const inheritedNormative = typeof existingFrontmatter.normative === 'boolean' ? existingFrontmatter.normative : undefined;
    const inheritedGoverns = Object.prototype.hasOwnProperty.call(existingFrontmatter, 'governs')
      ? normalizeList(existingFrontmatter.governs)
      : undefined;
    const fm: FrontmatterInput = {
      title: args.title.trim(),
      description,
      discovered: discoveredForWrite(existingContent),
      status: args.status ?? inheritedString('status') ?? 'active',
      type: (args.type ?? inheritedString('type') ?? '').trim() || DEFAULT_DOC_TYPE,
      tags: args.tags === undefined ? normalizeList(existingFrontmatter.tags) : normalizeList(args.tags),
      documents,
      plans: args.plans === undefined ? normalizeList(existingFrontmatter.plans) : normalizeList(args.plans),
      ...(typeof args.sidebarOrder === 'number'
        ? { sidebarOrder: args.sidebarOrder }
        : inheritedSidebarOrder !== undefined
          ? { sidebarOrder: inheritedSidebarOrder }
          : {}),
      ...(args.normative !== undefined
        ? { normative: args.normative }
        : inheritedNormative !== undefined
          ? { normative: inheritedNormative }
          : {}),
      ...(args.governs !== undefined
        ? { governs: normalizeList(args.governs) }
        : inheritedGoverns !== undefined
          ? { governs: inheritedGoverns }
          : {}),
      preservedFrontmatter: existingFrontmatter,
    };
    const content = composeDoc(fm, args.body);

    // Validate the complete projected document before the canonical write. The downstream
    // Astro build compiles this exact frontmatter + body with MDX core; accepting malformed
    // JSX here would persist a fleet-wide docs-build blocker before any later content guard
    // can report it (EI-21290152066377291 / EI-5861).
    try {
      const mdxError = await findMdxCompileError(docId, content);
      if (mdxError) {
        const at = mdxError.line != null ? `:${mdxError.line}${mdxError.col != null ? `:${mdxError.col}` : ''}` : '';
        return err(
          `invalid_mdx — ${docId}${at}: ${mdxError.reason}. ` +
            'Fix the MDX syntax before authoring (for example, put literal angle-bracket placeholders in backticks).',
        );
      }
    } catch (e) {
      // The shared detector fails open when its optional compiler cannot load. Keep the
      // authoring path available, but surface that validation was skipped so the caller can
      // run lint:mdx explicitly rather than mistaking a successful write for a checked one.
      warnings.push(`MDX validation could not run — run lint:mdx before relying on this doc (${(e as Error).message})`);
    }

    // ── PG FIRST, FILE SECOND (P-008 / D-025) ──────────────────────────────────────
    // This order is the whole inversion. Postgres is canonical for authored doc prose;
    // the .mdx is a PROJECTION of harness_docs.content, written below by the same module
    // the CLI projector uses. Writing the file first (as this tool did until 2026-08-10)
    // would make the file the source and the row a lagging mirror — and on a partial
    // failure it would leave prose on disk that nothing else knows about, which is
    // precisely the state P-008 exists to end.
    //
    // The anchor call is what writes the row, so it carries the content: one writer
    // (upsertDocRecord), not two competing ones. Documents are passed explicitly so we
    // never hit the inference path — and so the doc ships drift-tracked, not "untracked".
    const verify = args.verify ?? true;
    let anchored = false;
    let status = 'untracked';
    let subjectRef: unknown = [];
    try {
      const res = await anchorManualDoc({
        harnessSlug,
        docId,
        ...(documents.length ? { documents } : {}),
        verify,
        title: args.title.trim(),
        content,
      });
      if (res.ok) {
        anchored = res.anchored;
        status = res.record.status;
        subjectRef = res.subjectRef;
        if (!anchored && documents.length) {
          warnings.push('anchor resolved 0 subject refs from the provided `documents` — check the paths/ids exist in the repo.');
        }
      } else {
        // The canonical write FAILED, so the doc does not exist. Under the old file-first
        // order this was a warning ("doc written but anchor failed") because the prose was
        // already safe on disk; now the row IS the doc, and writing the file anyway would
        // leave an unbacked .mdx that the projector must later refuse as drift.
        return err(`doc_not_saved — the canonical row write failed (${res.error}); nothing was written. Retry, or file the doc with harness_docs:anchor once the cause is fixed.`);
      }
    } catch (e) {
      return err(`doc_not_saved — the canonical row write threw (${(e as Error).message}); nothing was written.`);
    }

    // ── The projection ─────────────────────────────────────────────────────────────
    // Written from the SAME module the CLI projector uses, so a doc authored here and a
    // doc projected by a corpus-wide run are byte-identical. A failure here is genuinely
    // recoverable and must NOT lose the doc: the prose is already canonical in Postgres,
    // so the next projector run writes the file.
    let projected = true;
    try {
      await fs.mkdir(dirname(abs), { recursive: true });
      await fs.writeFile(abs, applyProjectionBanner(content, docId), 'utf8');
    } catch (e) {
      projected = false;
      warnings.push(
        `the doc is saved (Postgres is canonical) but its .mdx projection failed to write (${(e as Error).message}) — ` +
        `run: node --import tsx scripts/project-authored-docs.ts --write`,
      );
    }

    // PG is canonical even when the filesystem projection failed or landed in a
    // different checkout. Invalidate the shared overlay in both cases so the
    // read surfaces see this write immediately.
    if (harnessRes.engineering) invalidateEngineeringAdapter();

    // ── The search index ───────────────────────────────────────────────────────────
    // EI-20459861068197195: docs:search reads harness_shared.doc_sections, which is a
    // DIFFERENT store from the canonical row, the .mdx and the curated index. Its
    // engineering sync is once-per-process, so without this the doc we just corrected
    // keeps being SERVED with its old title/description/body until the operator
    // restarts — the tool having reported success. Repair this one page inline.
    //
    // Ordering matters: this must follow invalidateEngineeringAdapter() above, or the
    // adapter re-indexes the bytes it memoized before the write. Fail-open — the doc
    // is already canonical, so a stale index is a warning, never a failed author.
    if (harnessRes.engineering) {
      const refreshed = await refreshDocPageSections(engineeringAdapter, docId.replace(/\.mdx$/, ''));
      if (!refreshed.ok) {
        warnings.push(
          `the doc is saved and projected, but its docs:search index entry was NOT refreshed (${refreshed.reason}) — ` +
            `docs:search will keep returning this page's PREVIOUS title/description/content until the operator restarts.`,
        );
      }
    }

    const indexNudge = insightsIndexNudge(section, harnessSlug);
    if (indexNudge) warnings.push(indexNudge);

    ctxAny.metadata?.({ surface: harnessRes.engineering ? 'engineering' : `harness:${harnessSlug}`, docId });

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            path: docId,
            slug,
            section,
            harness: harnessSlug,
            absPath: abs,
            anchored,
            status,
            subjectRef,
            ...(warnings.length ? { warnings } : {}),
          }),
        },
      ],
    };
  },
});

function err(message: string) {
  return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: message }) }], isError: true };
}
