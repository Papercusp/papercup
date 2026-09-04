/**
 * addressed-project-guide.ts — the LAUNCH side of a blueprint-addressable Project guide
 * (identities-v1-2026-08-30 P-022).
 *
 * The projector (`scripts/project-doc-parts.mjs`) writes the DEFAULT guide — CLAUDE.md /
 * AGENTS.md composed from the UNADDRESSED parts — and every existing reader keeps getting
 * exactly that. A part with a non-empty `stack_scope` never lands in those files; it is
 * delivered HERE, at launch, to a wearer whose expanded stack (`guideAddressesForWearer`)
 * intersects its tokens:
 *
 *   role-launch-spec  ─ wearer = role su + static layers + suSessionBinding(fleetRole, modes)
 *        │               tokens = guideAddressesForWearer(wearer)
 *        ▼
 *   readAddressedGuideParts   SELECT … WHERE stack_scope && tokens AND client_scope && {client,all}
 *        │
 *        ▼
 *   composeProjectGuideForWearer   default text + addressed sections → projectGuideAtBudget
 *        │
 *        ▼
 *   renderSuPlaybook({ composeProjectGuide })   splices the result at PROJECT_GUIDE_MARKER
 *
 * `projectGuideAtBudget` stays the ONE budget seam (the item's explicit constraint): the
 * cap is the projector's own enforced budget, so a wearer's guide can never exceed what
 * the projector promised any reader — and a default guide, which the projector already
 * holds under that budget, passes through untouched (byte-identical).
 *
 * Section rendering mirrors the projector's `assemble` (heading emitted when
 * `target_section` changes; `(preamble)` emits none) and is PINNED to it in
 * addressed-project-guide.test.ts, so the addressed tail reads like the file it follows.
 */

import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { projectGuideAtBudget } from '../prompt-assembly';
import { guideAddressesForWearer, type GuideWearer } from './guide-address';

/**
 * The projector's enforced budget (`PROJECTION_BUDGET_CHARS` in project-doc-parts.mjs),
 * restated here as the cap on a WEARER's composed guide and pinned equal in the test —
 * the TS side cannot import the .mjs at runtime without dragging the script's pg client
 * into the operator bundle.
 */
export const ADDRESSED_GUIDE_MAX_CHARS = 160_000;

/** The projector's pseudo-section for parts above the first heading. */
export const GUIDE_PREAMBLE_SECTION = '(preamble)';

export interface AddressedGuidePart {
  part_key: string;
  body: string;
  ordinal: number;
  target_section: string | null;
  stack_scope: string[];
}

export interface ReadAddressedGuidePartsInput {
  workspaceId: string;
  harnessSlug: string;
  /** The composed doc the default guide was projected from (default `claude-md`). */
  docId?: string;
  /** The reader's client file axis — `claude` / `codex` — matched like the projector does. */
  client: string;
  /** The wearer's expanded tokens (`guideAddressesForWearer`). Empty ⇒ no read, no rows. */
  tokens: readonly string[];
  sql?: Sql;
}

/**
 * The live, projecting parts addressed to any of `tokens` for this client, in the
 * projector's read order (ordinal, then part_key). The predicate is exactly
 * `partTargetsClient && partReachesAudience` from the projector, expressed in SQL so the
 * partial GIN index on `stack_scope` (migration 1104) serves it.
 */
export async function readAddressedGuideParts(input: ReadAddressedGuidePartsInput): Promise<AddressedGuidePart[]> {
  if (input.tokens.length === 0) return [];
  const s = input.sql ?? getOrgPg();
  const rows = (await s.unsafe(
    `SELECT part_key, body, ordinal, target_section, stack_scope
       FROM harness_shared.harness_doc_parts
      WHERE workspace_id = $1 AND harness_slug = $2 AND doc_id = $3
        AND tombstone = false
        AND cardinality(stack_scope) > 0
        AND stack_scope && $4::text[]
        AND client_scope && $5::text[]
      ORDER BY ordinal, part_key`,
    [input.workspaceId, input.harnessSlug, input.docId ?? 'claude-md', [...input.tokens], [input.client, 'all']],
  )) as unknown as AddressedGuidePart[];
  return rows;
}

/**
 * Render the addressed parts as the projector would — one `## heading` per change of
 * `target_section`, bodies joined by blank lines — under a lede that tells the reader
 * WHY these sections are here and are absent from the file on disk. Pure.
 */
export function renderAddressedGuideSections(parts: readonly AddressedGuidePart[], tokens: readonly string[]): string {
  if (parts.length === 0) return '';
  const blocks: string[] = [];
  blocks.push(
    '## Addressed guidance — for this session’s stack\n\n' +
      `> The sections below are projected only to a launch whose stack matches ` +
      `${tokens.map((t) => `\`${t}\``).join(', ')}. They are NOT in the repo's \`CLAUDE.md\` — ` +
      'they live as addressed doc parts (`harness_doc_parts.stack_scope`); edit them with ' +
      '`npm run set-doc-part -- --part-key <key> --stack-scope <tokens> …`.',
  );
  let section: string | null = null;
  for (const p of parts) {
    if (p.target_section !== section) {
      section = p.target_section;
      if (section && section !== GUIDE_PREAMBLE_SECTION) blocks.push(`## ${section}`);
    }
    blocks.push(p.body);
  }
  return `${blocks.join('\n\n')}\n`;
}

export interface ComposeProjectGuideForWearerInput {
  /** The default guide as resolved by renderSuPlaybook (the projected file's text). */
  defaultText: string;
  /** Its path — quoted by the budget seam's truncation pointer. */
  source: string;
  /** The addressed rows `readAddressedGuideParts` returned for this wearer. */
  parts: readonly AddressedGuidePart[];
  /** The wearer's tokens, for the lede and the launch record. */
  tokens: readonly string[];
  maxChars?: number;
}

export interface ComposedProjectGuideForWearer {
  text: string;
  truncated: boolean;
  addressed: { tokens: string[]; partKeys: string[]; addedChars: number } | null;
}

/**
 * The wearer's guide: the default text, then the addressed sections, held to the budget
 * by `projectGuideAtBudget`. With no addressed parts the default passes through the seam
 * unchanged — the projector already holds it under the same cap — so an unaddressed
 * launch renders byte-identically to a pre-P-022 one.
 */
export function composeProjectGuideForWearer(input: ComposeProjectGuideForWearerInput): ComposedProjectGuideForWearer {
  const maxChars = input.maxChars ?? ADDRESSED_GUIDE_MAX_CHARS;
  if (input.parts.length === 0) {
    const passthrough = projectGuideAtBudget(input.defaultText, input.source, maxChars);
    return { text: passthrough.text, truncated: passthrough.truncated, addressed: null };
  }
  const tail = renderAddressedGuideSections(input.parts, input.tokens);
  const combined = `${input.defaultText.replace(/\n+$/, '')}\n\n${tail}`;
  const budgeted = projectGuideAtBudget(combined, input.source, maxChars);
  return {
    text: budgeted.text,
    truncated: budgeted.truncated,
    addressed: {
      tokens: [...input.tokens],
      partKeys: input.parts.map((p) => p.part_key),
      addedChars: combined.length - input.defaultText.length,
    },
  };
}

/**
 * The seam role-launch-spec hands to `renderSuPlaybook({ composeProjectGuide })`: expand
 * the wearer, read the addressed rows, compose. A read failure (no DB, no column yet on
 * an older schema) degrades to the DEFAULT guide and is reported through `onError` —
 * the guide every reader got before P-022 is never withheld because addressing failed.
 */
export function projectGuideComposerForWearer(opts: {
  wearer: GuideWearer;
  workspaceId: string;
  harnessSlug: string;
  client: string;
  docId?: string;
  sql?: Sql;
  maxChars?: number;
  onError?: (err: unknown) => void;
}): (resolved: { text: string; source: string }) => Promise<ComposedProjectGuideForWearer> {
  const tokens = guideAddressesForWearer(opts.wearer);
  return async (resolved) => {
    let parts: AddressedGuidePart[] = [];
    try {
      parts = await readAddressedGuideParts({
        workspaceId: opts.workspaceId,
        harnessSlug: opts.harnessSlug,
        docId: opts.docId,
        client: opts.client,
        tokens,
        sql: opts.sql,
      });
    } catch (err) {
      opts.onError?.(err);
      parts = [];
    }
    return composeProjectGuideForWearer({
      defaultText: resolved.text,
      source: resolved.source,
      parts,
      tokens,
      maxChars: opts.maxChars,
    });
  };
}
