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
import { resolveHarnessDocPaths } from '../../harness/docs/harness-repo';
import { safeJoinUnderRoot } from '../../harness/docs/doc-fs';
import { anchorManualDoc } from '../../harness/docs/manual-anchor';
import { resolveHarnessScope } from '../_harness-scope';

// ── Pure helpers (exported for unit tests — these encode the footgun-prevention) ──

/** Normalize/validate a doc slug → "<slug>" (no extension, kebab, single segment). */
export function normalizeSlug(raw: string): { ok: true; slug: string } | { ok: false; error: string } {
  let s = raw.trim().toLowerCase();
  s = s.replace(/\.mdx?$/, ''); // tolerate a trailing .md/.mdx
  if (!s) return { ok: false, error: 'slug_required' };
  if (s.includes('/') || s.includes('\\')) {
    return { ok: false, error: 'slug_must_be_a_single_segment — put a subdir in `section`, not the slug' };
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
}

/** YAML double-quoted scalar — JSON.stringify is a valid YAML flow scalar. */
function yamlStr(s: string): string {
  return JSON.stringify(s);
}

/** Build the full frontmatter block (including the wrapping --- lines). */
export function buildFrontmatter(fm: FrontmatterInput): string {
  const lines: string[] = ['---'];
  lines.push(`title: ${yamlStr(fm.title)}`);
  lines.push(`description: ${yamlStr(fm.description)}`);
  lines.push(`discovered: ${fm.discovered}`);
  if (fm.tags.length) lines.push(`tags: [${fm.tags.map(yamlStr).join(', ')}]`);
  lines.push(`status: ${fm.status}`);
  if (fm.documents.length) {
    lines.push('documents:');
    for (const d of fm.documents) lines.push(`  - ${yamlStr(d)}`);
  }
  if (fm.plans.length) {
    lines.push('plans:');
    for (const p of fm.plans) lines.push(`  - ${yamlStr(p)}`);
  }
  if (typeof fm.sidebarOrder === 'number' && Number.isFinite(fm.sidebarOrder)) {
    lines.push('sidebar:');
    lines.push(`  order: ${Math.trunc(fm.sidebarOrder)}`);
  }
  lines.push('---');
  return lines.join('\n');
}

/** Today's date as YYYY-MM-DD (server-side handler — Date is available here). */
export function todayIso(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
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
    .describe('Kebab-case file slug (no extension, no slashes), e.g. "named-fleet-vs-ephemeral-swarm". Becomes <section>/<slug>.mdx.'),
  title: z.string().min(1).max(200).describe('Human title (frontmatter `title`).'),
  description: z
    .string()
    .min(1)
    .max(500)
    .describe('One-line summary (frontmatter `description`) — this is the index hook docs:search / the outline shows.'),
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
  tags: z.union([z.string(), z.array(z.string())]).optional().describe('Topic tags (frontmatter `tags`).'),
  plans: z.union([z.string(), z.array(z.string())]).optional().describe('Related plan slugs (frontmatter `plans`).'),
  section: z
    .string()
    .optional()
    .describe('Docs-root-relative section dir. Default "agent-insights" (the runbook/insight section).'),
  status: z.enum(['active', 'superseded', 'draft']).optional().describe('Frontmatter `status`. Default "active".'),
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
      "Harness whose docs to write into. Pass 'all' (or omit in a papercusp-su session) for the Papercusp engineering reference (apps/operator-docs/...). Omit only when the session is already scoped to a harness.",
    ),
});

export default defineTool({
  name: 'docs:author',
  description:
    "Create a NEW manual / agent-insights doc the right way, in one call: writes <section>/<slug>.mdx to the canonical docs root (resolved exactly like docs:search — for papercusp that's apps/operator-docs/src/content/docs), stamps the full frontmatter convention (title/description/discovered/tags/status/documents/plans), and AUTO-anchors + verifies it so it ships drift-tracked. Eliminates the wrong-dir / missing-frontmatter / forgot-to-anchor footgun. Returns { ok, path, slug, section, surface, anchored, status, subjectRef, warnings }.",
  guidance: {
    when:
      'You have a durable HOW-IT-WORKS runbook / failure-mode / hard-won gotcha to write down (the CLAUDE.md "write it as an anchored agent-insights MDX" rule). Pass `documents` with the files/symbols the doc covers so it ships drift-tracked.',
    notWhen:
      'For a quick personal fact use memory:remember (not a doc). To EDIT an existing doc use capability:write/edit then harness_docs:verify. To only declare a subject_ref on an already-written doc use harness_docs:anchor.',
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
  agentRoles: ['documenter', 'operator', 'worker', 'architect', 'bee', 'curator'],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    const ctxAny = ctx as { harnessSlug?: string; isSuperuser?: boolean; metadata?: (d: Record<string, unknown>) => void };
    const warnings: string[] = [];

    const slugRes = normalizeSlug(args.slug);
    if (!slugRes.ok) return err(slugRes.error);
    const sectionRes = normalizeSection(args.section);
    if (!sectionRes.ok) return err(sectionRes.error);
    const slug = slugRes.slug;
    const section = sectionRes.section;

    // Resolve the target harness the SAME way the docs read adapters do:
    //   explicit `harness` → ctx harness → (superuser) 'papercusp' (the engineering
    //   reference owner). 'all'/'*'/none under superuser maps to 'papercusp' so the
    //   write root == the anchor read root == apps/operator-docs/src/content/docs.
    const scope = resolveHarnessScope(args.harness, ctxAny);
    let harnessSlug: string;
    if (scope.kind === 'harness') {
      harnessSlug = scope.slug;
    } else if (scope.kind === 'all') {
      harnessSlug = 'papercusp';
    } else {
      // kind === 'none': no harness in context and not the 'all' sentinel.
      if (ctxAny.isSuperuser) harnessSlug = 'papercusp';
      else return err('harness_required — pass harness (or "all" for the engineering reference)');
    }

    const paths = await resolveHarnessDocPaths(harnessSlug);
    if (!paths) return err(`unknown_harness — ${harnessSlug} is not registered (cannot resolve its docs root)`);
    const docId = `${section}/${slug}.mdx`;
    const abs = safeJoinUnderRoot(paths.docsRoot, docId);
    if (!abs) return err('path_traversal — section/slug resolved outside the docs root');

    if (existsSync(abs) && !args.overwrite) {
      return err(`doc_exists — ${docId} already exists; pass overwrite:true to replace it, or edit it with capability:edit`);
    }

    const documents = normalizeList(args.documents);
    if (!documents.length) {
      warnings.push('no `documents` provided — the doc is NOT drift-tracked; pass `documents` (files/symbols it covers) so the drift sweep can flag it when that code changes.');
    }

    const stripCheck = stripLeadingFrontmatter(args.body);
    if (stripCheck.stripped) {
      warnings.push('a leading --- frontmatter block in `body` was stripped — frontmatter is generated from the args; pass body content only.');
    }

    const fm: FrontmatterInput = {
      title: args.title.trim(),
      description: args.description.trim(),
      discovered: todayIso(),
      status: args.status ?? 'active',
      tags: normalizeList(args.tags),
      documents,
      plans: normalizeList(args.plans),
      ...(typeof args.sidebarOrder === 'number' ? { sidebarOrder: args.sidebarOrder } : {}),
    };
    const content = composeDoc(fm, args.body);

    try {
      await fs.mkdir(dirname(abs), { recursive: true });
      await fs.writeFile(abs, content, 'utf8');
    } catch (e) {
      return err(`write_failed — ${(e as Error).message}`);
    }

    // Auto-anchor (+ verify by default): pass documents explicitly so we never hit
    // the inference path — and so the doc ships drift-tracked, not "untracked".
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
      });
      if (res.ok) {
        anchored = res.anchored;
        status = res.record.status;
        subjectRef = res.subjectRef;
        if (!anchored && documents.length) {
          warnings.push('anchor resolved 0 subject refs from the provided `documents` — check the paths/ids exist in the repo.');
        }
      } else {
        warnings.push(`doc written but anchor failed (${res.error}) — run harness_docs:anchor { docId, documents } to drift-track it.`);
      }
    } catch (e) {
      warnings.push(`doc written but anchor threw (${(e as Error).message}) — run harness_docs:anchor manually.`);
    }

    ctxAny.metadata?.({ surface: scope.kind === 'harness' ? `harness:${harnessSlug}` : 'engineering', docId });

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
