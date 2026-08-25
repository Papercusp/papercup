#!/usr/bin/env node
/**
 * P-005 — project `harness_shared.harness_doc_parts` into the per-client files.
 *
 * DIRECTION OF TRUTH. Migration 781 makes this explicit as a COLUMN, not a convention
 * (D-010): when `harness_docs.content_mode='composed'`, the PARTS are canonical and
 * `harness_docs.content` is merely this projector's cached output. So this script is
 * the only thing that may author CLAUDE.md / AGENTS.md, and a hand-edit to either is
 * lost at the next projection — which is what P-006's PreToolUse guard enforces.
 *
 * WHY A FILE EXISTS AT ALL (D-004). Canonical is always PG; a filesystem projection
 * exists IFF there is a reader we do not control. Claude Code and Codex read a file
 * off disk at launch and cannot be taught to query Postgres, so they get one — and
 * each gets its OWN file rather than the AGENTS.md -> CLAUDE.md symlink, which made
 * per-client scoping unrepresentable.
 *
 * THE BUDGET IS ENFORCED HERE, NOT HOPED FOR (D-008). Claude Code warns when a memory
 * file is oversized, and its threshold is COMPUTED, not constant. The formula and its
 * constants are transcribed from the 2.1.226 bundle in `memoryWarningThreshold()`
 * below. D-008 chose a conservative ~42% trim on the explicit understanding that the
 * trim alone is NOT self-sufficient — it is safe only while sessions run at a large
 * context window — and that this projector's rank-and-cap is the actual mitigation.
 * Hence: the output physically cannot exceed the budget. It degrades by dropping the
 * lowest-priority parts and leaving a POINTER to them, and it reports what it cut.
 */
import { readFileSync, writeFileSync, existsSync, lstatSync, unlinkSync, readlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectScriptPg } from './lib/pg-url.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const WORKSPACE_ID = process.env.PAPERCUSP_WORKSPACE_ID ?? 'papercusp-workspace';
export const HARNESS_SLUG = process.env.PAPERCUSP_HARNESS_SLUG ?? 'papercusp';

const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

/**
 * The pseudo-section `extractParts()` assigns to blocks above the first `## ` heading.
 * It is a POSITION, not a heading, so the projector must not emit it as one.
 */
export const PREAMBLE = '(preamble)';

/** The heading the spill block is emitted under when the budget forces a cut. */
export const SPILL_SECTION = 'Trimmed to fit this client’s budget';

/**
 * The suffix `load-claude-md-doc-parts.mjs` gives the evidence half of a split block.
 * Declared here rather than imported so composing does not drag the loader (and its
 * manifest/rule-evidence reads) into every consumer of this module; the two are checked
 * against each other by `doc-corpus.test.ts`, so they cannot drift silently.
 */
export const EVIDENCE_SUFFIX = '#evidence';

/**
 * Where the composed corpus is written. This is the DB-free subject the doc-claims
 * guards read, and it exists for exactly one reason: those guards are UNIT tests, and
 * the green gate runs `npm run test:affected` with no `--integration`, so a guard that
 * needed Postgres would quietly stop gating the fleet. That is the "migration that
 * greens by weakening a guard" P-004 forbids, so the corpus is projected to a file
 * instead — the same D-004 test the client files pass ("a reader we do not control
 * requires a file on disk"), where the reader is the unit tier.
 */
export const CORPUS_FILE = 'packages/operator-core/lib/doc-projection/claude-md-corpus.generated.md';

/**
 * Compare the DB-composed corpus with the committed DB-free subject.
 *
 * The provenance banner's source sha only identifies the CLAUDE.md snapshot from which
 * the rows were initially loaded. A direct edit to a canonical row leaves that sha
 * unchanged, so the live projector must also compare the composed bytes with the file.
 * Keep this pure so the recurrence is testable without Postgres or the working tree.
 */
export function corpusDriftVerdict({ onDisk, composed }) {
  if (onDisk === null) return { ok: false, reason: 'absent' };
  if (onDisk === composed) return { ok: true, reason: 'already-current' };
  return {
    ok: false,
    reason: 'drifted',
    live: sha256(onDisk),
    expected: sha256(composed),
  };
}

/**
 * Deliberately inert: no fenced block, no `npm run`, no grep recipe, no path that the
 * retired-surfaces guard would read as a claim. The banner is part of the text those
 * guards judge, so anything executable-looking here would become a claim the corpus
 * appears to make. Verified: the three guards report identical counters with and
 * without it.
 */
export function corpusBanner({ parts, blocks, sourceSha } = {}) {
  return [
    '<!--',
    '  GENERATED FILE — DO NOT EDIT, and do not treat it as documentation to read.',
    '',
    '  It is the full CLAUDE.md corpus (every part, projected and unprojected alike)',
    '  composed from harness_shared.harness_doc_parts, which is canonical. It exists so',
    '  the doc-claims guards can judge the WHOLE corpus without a database: the client',
    '  files carry only the projected minority, so pointing those guards at CLAUDE.md',
    '  after the cutover would leave them judging a fraction of what they judge today.',
    '',
    '  Written by scripts/project-doc-parts.mjs. Edit the rows, never this file.',
    '',
    '  PROVENANCE — machine-read by doc-corpus.test.ts, which fails if the source sha',
    '  here disagrees with the part manifest. That is the drift alarm: this file, the',
    '  manifest and the rows are three artifacts derived from one CLAUDE.md snapshot,',
    '  and regenerating any one of them alone silently desynchronises the set.',
    `  corpus-parts: ${parts ?? 'unknown'}`,
    `  corpus-blocks: ${blocks ?? 'unknown'}`,
    `  source-sha256: ${sourceSha ?? 'unknown'}`,
    '-->',
  ].join('\n');
}

/** Parse the provenance a corpus file carries. Returns nulls rather than throwing. */
export function readCorpusProvenance(text) {
  const num = (k) => {
    const m = text.match(new RegExp(`^\\s*${k}:\\s*(\\d+)\\s*$`, 'm'));
    return m ? Number(m[1]) : null;
  };
  const sha = text.match(/^\s*source-sha256:\s*([0-9a-f]{64})\s*$/m);
  return { parts: num('corpus-parts'), blocks: num('corpus-blocks'), sourceSha: sha ? sha[1] : null };
}

/**
 * How many cut parts the spill pointer ENUMERATES before it stops naming them.
 *
 * The cap is load-bearing, not cosmetic. An unbounded list grows with every part cut,
 * so a tighter budget makes the pointer bigger at exactly the moment there is less
 * room for it — and past some point the banner plus the pointer alone exceed the
 * budget and the projector can only refuse. That is a worse degradation than naming
 * fewer parts: a file that fails to generate helps nobody, and the complete cut set
 * stays recoverable from PG either way (it is every projected part whose key does not
 * appear in the file). Bounding it makes the spill block's size O(1), so the refusal
 * below is reserved for a budget too small to hold the banner at all.
 */
export const MAX_SPILL_ENTRIES = 12;

/**
 * Which client file each scope projects into. A part carrying `all` goes to every
 * client; a part carrying a single client is that client's alone. Nothing today
 * diverges — every projected part is `{all}` — which is precisely why the two files
 * must still be generated SEPARATELY: the mechanism has to be exercised before a
 * divergent part exists, or its first use would be its first test.
 */
export const CLIENTS = [
  { client: 'claude', file: 'CLAUDE.md', reader: 'Claude Code' },
  { client: 'codex', file: 'AGENTS.md', reader: 'Codex / OpenAI agents' },
];

/**
 * Parse an explicit, compare-and-swap acknowledgement for a generated client file
 * whose useful hand edit has already been moved into the canonical parts.
 *
 * The full live SHA is mandatory: a peer edit after the review changes the bytes and
 * makes the later overwrite refuse again. Client qualification matters too — accepting
 * CLAUDE.md drift must never weaken AGENTS.md's independent guard.
 */
export function parseAcceptedCanonicalizedDrift(argv) {
  const knownClients = new Set(CLIENTS.map((entry) => entry.client));
  const accepted = new Map();
  for (const arg of argv) {
    if (!arg.startsWith("--accept-canonicalized-drift=")) continue;
    const value = arg.slice("--accept-canonicalized-drift=".length);
    const separator = value.indexOf(":");
    const client = separator === -1 ? "" : value.slice(0, separator);
    const sha =
      separator === -1 ? "" : value.slice(separator + 1).toLowerCase();
    if (!knownClients.has(client)) {
      throw new Error(
        `--accept-canonicalized-drift requires a known client (${[...knownClients].join(", ")}); got ${JSON.stringify(client)}`,
      );
    }
    if (!/^[0-9a-f]{64}$/.test(sha)) {
      throw new Error(
        `--accept-canonicalized-drift=${client}:… requires the full 64-character SHA-256 of the reviewed on-disk file`,
      );
    }
    if (accepted.has(client)) {
      throw new Error(
        `--accept-canonicalized-drift was supplied more than once for ${client}`,
      );
    }
    accepted.set(client, sha);
  }
  return accepted;
}

// ---------------------------------------------------------------------------
// The budget
// ---------------------------------------------------------------------------

/**
 * Claude Code's own oversized-memory-file threshold, transcribed from the shipped
 * bundle so this cannot drift into folklore. Verified against version 2.1.226:
 *
 *   function $dn(e = ls()) {
 *     let t = hT(e, u0());
 *     let r = Number.isFinite(t) && t > 0 ? t : nbr;      // nbr = 200000
 *     return Math.max(si_, Math.round(r * ii_ * pk(e)));  // si_ = 40000, ii_ = 0.05
 *   }
 *   function pk(e) { ...; return Bby.has(model) ? 4 : 3 }
 *
 * `pk` is chars-per-token and returns 4 for every model id in the bundle's known set
 * (claude-opus-4-5/4-6, claude-sonnet-4-5/4-6, claude-haiku-4-5, the 3.x family, ...)
 * and 3 for anything it does not recognise. So 3 is the UNRECOGNISED-ID fallback, not
 * a smaller-model case, and every model actually in use here yields 4.
 *
 * Consequences worth stating, because they are the whole reason P-005 exists:
 *   400_000 context, 4 chars/token -> 80_000
 *   200_000 context, 4 chars/token -> 40_000  (the floor, si_)
 *   any context, unrecognised id   -> max(40_000, ctx * 0.05 * 3)
 * The floor means NO configuration ever permits more than the budget without also
 * permitting 40_000, so 40_000 is the smallest threshold this formula can produce.
 */
export const MEMORY_WARN_FLOOR_CHARS = 40_000; // si_
export const MEMORY_WARN_CONTEXT_FRACTION = 0.05; // ii_
export const MEMORY_WARN_DEFAULT_CONTEXT_TOKENS = 200_000; // nbr
export const CHARS_PER_TOKEN_KNOWN_MODEL = 4; // pk() for a recognised model id
export const CHARS_PER_TOKEN_UNKNOWN_MODEL = 3; // pk() fallback

export function memoryWarningThreshold({
  contextTokens = MEMORY_WARN_DEFAULT_CONTEXT_TOKENS,
  charsPerToken = CHARS_PER_TOKEN_KNOWN_MODEL,
} = {}) {
  const ctx = Number.isFinite(contextTokens) && contextTokens > 0
    ? contextTokens
    : MEMORY_WARN_DEFAULT_CONTEXT_TOKENS;
  return Math.max(
    MEMORY_WARN_FLOOR_CHARS,
    Math.round(ctx * MEMORY_WARN_CONTEXT_FRACTION * charsPerToken),
  );
}

/**
 * The configurations a projected file could be read under. Reported on every run so
 * the headroom is VISIBLE rather than implied by one number — D-008's failure mode is
 * a file that is comfortably under the threshold of the session that generated it and
 * over the threshold of the session that reads it.
 */
export function budgetMatrix() {
  const rows = [];
  for (const contextTokens of [200_000, 400_000, 1_000_000]) {
    for (const charsPerToken of [CHARS_PER_TOKEN_KNOWN_MODEL, CHARS_PER_TOKEN_UNKNOWN_MODEL]) {
      rows.push({
        contextTokens,
        charsPerToken,
        threshold: memoryWarningThreshold({ contextTokens, charsPerToken }),
      });
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Composition (pure — no fs, no db, no clock)
// ---------------------------------------------------------------------------

/** Does this part project into `client`? */
export function partTargetsClient(part, client) {
  const scope = part.client_scope ?? [];
  return scope.includes('all') || scope.includes(client);
}

/**
 * Deterministic read order. `ordinal` is the document position and is the only order
 * that matters; `part_key` breaks a tie so two parts sharing an ordinal (a rule and a
 * later-inserted sibling) can never swap between runs. P-012 asserts byte-identical
 * output for unchanged rows, and a nondeterministic sort is the obvious way to fail it.
 */
export function readOrder(a, b) {
  if (a.ordinal !== b.ordinal) return a.ordinal - b.ordinal;
  return a.part_key < b.part_key ? -1 : a.part_key > b.part_key ? 1 : 0;
}

/**
 * Cut order — the FIRST part in this order is the first to be dropped when the budget
 * bites. Three keys, each deliberate:
 *   1. project_rank DESC — the declared budget axis (D-008). Rank is assigned when a
 *      part is classified; re-deciding it here would silently override that decision.
 *   2. body length DESC — within one rank, dropping the largest part first retains the
 *      greatest NUMBER of rules per char surrendered.
 *   3. ordinal DESC — a final deterministic tiebreak, cutting from the document tail.
 */
export function cutOrder(a, b) {
  if (a.project_rank !== b.project_rank) return b.project_rank - a.project_rank;
  if (a.body.length !== b.body.length) return b.body.length - a.body.length;
  return b.ordinal - a.ordinal;
}

/**
 * Rank makes invariants the LAST content cut, but "last" is not "never". P-007's
 * accepted 80k budget relied on every invariant surviving; corpus growth eventually
 * crossed that boundary while the projector still exited green (EI-21429056183505097).
 * Keep the detector pure so the refusal has a positive control without a live database.
 */
export function invariantCutKeys(dropped) {
  return dropped.filter((part) => part.kind === 'invariant').map((part) => part.part_key);
}

/** The banner every projected file opens with. */
/**
 * The phrase that identifies a file as OUR OUTPUT rather than anyone's source.
 *
 * Exported because the LOADER imports it to refuse re-ingesting a projection (P-013).
 * Sharing the constant is what keeps the two sides from drifting: an edit to the banner
 * wording cannot silently blind that guard, because there is only one string.
 */
export const PROJECTION_MARKER = 'Projected from Postgres: harness_shared.harness_doc_parts';

export function projectionBanner({ client, file, reader, docId }) {
  return [
    `<!-- GENERATED FILE — DO NOT EDIT BY HAND. -->`,
    `<!-- ${PROJECTION_MARKER} (doc_id=${docId}, client=${client}). -->`,
    ``,
    `> ⚠ **${file} is GENERATED — editing it here does nothing durable.** ${reader} reads this file`,
    `> off disk, which is the only reason it exists (the canonical content is in Postgres:`,
    `> \`harness_shared.harness_doc_parts\`, with \`harness_docs.content_mode='composed'\`). A hand-edit`,
    `> is overwritten by the next projection and is invisible to every other client.`,
    `>`,
    // Both halves name a RUNNABLE command on purpose (WI-39623). This said "edit its
    // PART" for months while no agent-facing write path existed — `dev:pg_query` is
    // read-only and no docs:*/harness_docs:* tool addresses a part — so the instruction
    // named an operation nobody could perform, and the actual practice became hand-rolled
    // UPDATEs outside every guard (which left `author` null, losing who changed a rule).
    `> **To change a rule:** edit its PART, then re-project — both halves are commands:`,
    `> \`npm run set-doc-part -- --part-key <key> --body-file <path> --write\``,
    `> (\`--list <prefix>\` to find the key; dry-run without \`--write\`), then`,
    `> \`node scripts/project-doc-parts.mjs --write\`.`,
    `>`,
    `> Supporting evidence for these rules is deliberately NOT here — it lives in the corpus`,
    `> (\`kind='prose'\` rows, searchable) so a rule reaches the agent without its case history.`,
  ].join('\n');
}

/**
 * Render the spill pointer for parts the budget cut. This is itself a pointer part in
 * the sense D-004 means: the content is not gone, it is one query away, and the file
 * says where. Emitting nothing here would make a budget cut SILENT, which is the one
 * outcome worse than a trimmed file.
 */
export function spillBlock(dropped, { budget, docId, client }) {
  if (!dropped.length) return null;
  const chars = dropped.reduce((a, p) => a + p.body.length, 0);
  const lines = [
    `## ${SPILL_SECTION}`,
    ``,
    `> ⚠ **${dropped.length} part(s) (${chars.toLocaleString('en-US')} chars) did not fit this client's`,
    `> ${budget.toLocaleString('en-US')}-char budget and were cut from this file.** They are NOT deleted and NOT`,
    `> deprecated — they are canonical rows in Postgres, and this list is how you find them:`,
    `>`,
    `> \`\`\`sql`,
    `> SELECT part_key, target_section, body FROM harness_shared.harness_doc_parts`,
    `>  WHERE doc_id = '${docId}' AND tombstone = false AND part_key = ANY(...);`,
    `> \`\`\``,
    `>`,
    `> A rule appearing here means the budget, not a decision, removed it. If one of these`,
    `> matters more than something still above, change its \`project_rank\` — do not re-add it`,
    `> by hand, which the next projection would undo.`,
    ``,
  ];
  for (const p of dropped.slice(0, MAX_SPILL_ENTRIES)) {
    const head = (p.body.split('\n').find((l) => l.trim()) ?? '').replace(/\s+/g, ' ').trim();
    const section = p.target_section === PREAMBLE ? '(preamble)' : p.target_section;
    lines.push(`- \`${p.part_key}\` — *${section}* — ${head.slice(0, 110)}${head.length > 110 ? '…' : ''}`);
  }
  if (dropped.length > MAX_SPILL_ENTRIES) {
    lines.push(
      `- …and ${dropped.length - MAX_SPILL_ENTRIES} more. The list is capped so the pointer cannot itself` +
        ` consume the budget; the COMPLETE cut set is every projected part whose \`part_key\` does not` +
        ` appear above in this file, which the query above returns.`,
    );
  }
  return lines.join('\n');
}

/**
 * Assemble the file body from parts already filtered to one client.
 *
 * Headings are emitted HERE and are not parts — `gen-claude-md-manifest.mjs` skips
 * `## ` lines when extracting precisely so that the section structure is derived from
 * `target_section` rather than stored twice and allowed to disagree. A section whose
 * every part was cut therefore loses its heading automatically, because the heading
 * only exists while a surviving part claims it.
 */
export function assemble(parts, { banner = null, spill = null } = {}) {
  const blocks = [];
  if (banner) blocks.push(banner);
  let section = null;
  for (const p of parts) {
    if (p.target_section !== section) {
      section = p.target_section;
      if (section && section !== PREAMBLE) blocks.push(`## ${section}`);
    }
    blocks.push(p.body);
  }
  if (spill) blocks.push(spill);
  return `${blocks.join('\n\n')}\n`;
}

/**
 * Project one client's file, enforcing the budget.
 *
 * The cut loop recomposes after every drop rather than subtracting lengths, because
 * the spill block GROWS with each cut part: a subtractive estimate would undershoot
 * and could still emit an over-budget file, which is the exact outcome D-008 forbids.
 * 116 parts of ~57k chars makes this trivially cheap.
 */
export function projectClient(allParts, { client, docId, file, reader, budget, banner = true }) {
  const mine = allParts.filter((p) => partTargetsClient(p, client)).sort(readOrder);
  const head = banner ? projectionBanner({ client, file, reader, docId }) : null;

  let text = assemble(mine, { banner: head });
  if (text.length <= budget) {
    return { text, kept: mine, dropped: [], warnings: danglingProjectionWarnings(mine), budget, overBudget: false };
  }

  const candidates = [...mine].sort(cutOrder);
  const dropped = [];
  for (const victim of candidates) {
    dropped.push(victim);
    const droppedKeys = new Set(dropped.map((d) => d.part_key));
    const kept = mine.filter((p) => !droppedKeys.has(p.part_key));
    const spill = spillBlock([...dropped].sort(readOrder), { budget, docId, client });
    text = assemble(kept, { banner: head, spill });
    if (text.length <= budget) {
      const keptInOrder = kept.sort(readOrder);
      return {
        text,
        kept: keptInOrder,
        dropped: [...dropped].sort(readOrder),
        warnings: danglingProjectionWarnings(keptInOrder),
        budget,
        overBudget: false,
      };
    }
  }

  // Every part dropped and still over budget: the banner plus the spill list alone
  // exceed it. Refusing is correct — an over-budget file is the failure this exists
  // to prevent, and silently emitting one would hide it behind a passing run.
  throw new Error(
    `projector cannot fit ${file} within ${budget} chars even with every part dropped ` +
      `(${text.length} chars of banner + spill pointer). The budget is too small to be honoured.`,
  );
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/**
 * Every kept part's body must appear VERBATIM in the output. This is the composition
 * self-check: it catches a join/heading bug that would corrupt or truncate a rule
 * while still producing a plausible-looking file of roughly the right size.
 */
export function verifyBodiesPresent(text, kept) {
  const missing = [];
  for (const p of kept) if (!text.includes(p.body)) missing.push(p.part_key);
  return missing;
}

/**
 * Warn when projection leaves an imperative-looking part dangling at the end of its section.
 *
 * A colon-terminated part is commonly a promise that its next part supplies the payload (for
 * example, a table or a recipe). If the next emitted row changes section — or does not exist —
 * the reader sees the promise and none of the promised content. This is deliberately a warning,
 * not a failed projection: a short section can end in a colon for a legitimate reason, but the
 * shape must be visible at build time instead of silently disappearing.
 */
export function danglingProjectionWarnings(parts) {
  const ordered = [...parts].sort(readOrder);
  const warnings = [];
  for (let i = 0; i < ordered.length; i++) {
    const current = ordered[i];
    if (!current.body.trimEnd().endsWith(':')) continue;
    const next = ordered[i + 1];
    if (next && next.target_section === current.target_section) continue;
    warnings.push(
      `${current.part_key}: emitted part ends with ':' with no following emitted part in section ` +
        `${JSON.stringify(current.target_section)}`,
    );
  }
  return warnings;
}

/**
 * May we overwrite what is on disk?
 *
 * The projector reads PG, never the file, so on its own it cannot notice that a peer
 * edited CLAUDE.md after the parts were loaded — those edits would simply be erased.
 * The file is only safe to overwrite when its current bytes are one of the two things
 * we already know about, and the two cases correspond to the two phases of this plan:
 *
 *   • BEFORE cutover the file is hand-authored, and the parts were loaded from exactly
 *     that text — so it must hash to `generated_from_sha`.
 *   • AFTER cutover the file is our own output — so it must hash to `content_hash`,
 *     the cached projection.
 *
 * Anything else means the bytes on disk are neither the source we read nor the output
 * we wrote, i.e. somebody changed them, and overwriting would destroy that change. On
 * this tree CLAUDE.md is edited several times an hour, so this is the expected case,
 * not a hypothetical one. `absent` is safe: there is nothing to lose.
 *
 * ⚠ "OUR OWN OUTPUT" IS PER CLIENT (EI-20055472930397669). One doc row projects into N
 * files, so a single stored hash cannot answer this question for more than one of them.
 * The first version compared EVERY client's file against `content_hash` — the PRIMARY
 * client's cached composition — so AGENTS.md, whose bytes legitimately differ from
 * CLAUDE.md's, could never match and was refused on every subsequent run. The per-client
 * record in `harness_docs.projected_clients` is the answer, and it is why
 * `lastProjectionSha` is the FIRST hash consulted; `contentHash` survives only as the
 * pre-column fallback for the primary client.
 *
 * `nextText` (the bytes we are about to write) is accepted outright when it matches: a
 * write that changes nothing cannot destroy anything, whoever produced the bytes. That
 * is what lets an un-recorded file re-join the steady state instead of needing a
 * backfill — but it is NOT sufficient on its own, and reading it as the fix would be a
 * mistake: the moment a part changes, the next output differs from disk and only the
 * per-client record can distinguish "our last projection" from "a peer's edit".
 */
export function overwriteVerdict({
  onDisk,
  generatedFromSha,
  contentHash,
  lastProjectionSha = null,
  nextText = null,
  acceptedCanonicalizedDriftSha = null,
}) {
  if (onDisk === null) return { ok: true, reason: "absent" };
  const live = sha256(onDisk);
  if (nextText !== null && live === sha256(nextText))
    return { ok: true, reason: "already-current", live };
  if (lastProjectionSha && live === lastProjectionSha)
    return { ok: true, reason: "matches-last-projection", live };
  if (generatedFromSha && live === generatedFromSha)
    return { ok: true, reason: "matches-loaded-source", live };
  if (contentHash && live === contentHash)
    return { ok: true, reason: "matches-cached-composition", live };
  if (
    typeof acceptedCanonicalizedDriftSha === "string" &&
    /^[0-9a-f]{64}$/i.test(acceptedCanonicalizedDriftSha) &&
    live === acceptedCanonicalizedDriftSha.toLowerCase()
  ) {
    return { ok: true, reason: "accepted-canonicalized-drift", live };
  }
  return { ok: false, reason: "drifted", live };
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

async function connect() {
  return connectScriptPg();
}

export async function readProjectedParts(client, docId) {
  const { rows } = await client.query(
    `SELECT part_key, kind, body, ordinal, client_scope, target_section, project_rank
       FROM harness_shared.harness_doc_parts
      WHERE workspace_id = $1 AND harness_slug = $2 AND doc_id = $3
        AND tombstone = false AND cardinality(client_scope) > 0
      ORDER BY ordinal, part_key`,
    [WORKSPACE_ID, HARNESS_SLUG, docId],
  );
  return rows;
}

/**
 * Every live part, projected or not — the corpus. Same query as `readProjectedParts`
 * minus the `cardinality(client_scope) > 0` filter, and ordered identically so a rule
 * always precedes its `#evidence` half ('foo' sorts before 'foo#evidence').
 */
export async function readAllParts(client, docId) {
  const { rows } = await client.query(
    `SELECT part_key, kind, body, ordinal, client_scope, target_section, project_rank
       FROM harness_shared.harness_doc_parts
      WHERE workspace_id = $1 AND harness_slug = $2 AND doc_id = $3
        AND tombstone = false
      ORDER BY ordinal, part_key`,
    [WORKSPACE_ID, HARNESS_SLUG, docId],
  );
  return rows;
}

/**
 * Compose the whole corpus, closing the (rule, evidence) seam the loader cut.
 *
 * The halves are rejoined with NO separator, because `ruleAndEvidence` guarantees
 * `rule + evidence === raw` by arithmetic for its exact modes — joining them the way
 * `assemble` joins blocks would fabricate a blank line that was never in the source
 * and split one paragraph into two.
 *
 * ⚠ The result is deliberately NOT byte-identical to the hand-authored CLAUDE.md, and
 * no test should assert that it is: P-015 re-authored 55 of the 253 blocks into
 * (rule, evidence) pairs, so 55 blocks carry text that never appeared in the file.
 * P-017 is what verified that separation dropped no rule; identity was given up there,
 * on purpose. What IS asserted is the property that matters here — that the corpus
 * yields at least as many judged claims as the file it replaced (see doc-corpus.test.ts).
 */
export function composeCorpus(allParts, { banner = true, sourceSha = null } = {}) {
  const byKey = new Map(allParts.map((p) => [p.part_key, p]));
  const blocks = [];
  for (const p of allParts) {
    if (p.part_key.endsWith(EVIDENCE_SUFFIX)) continue;
    const evidence = byKey.get(`${p.part_key}${EVIDENCE_SUFFIX}`);
    blocks.push({
      body: p.body + (evidence ? evidence.body : ''),
      target_section: p.target_section,
    });
  }
  const body = assemble(blocks);
  const head = banner ? corpusBanner({ parts: allParts.length, blocks: blocks.length, sourceSha }) : null;
  return { text: head ? `${head}\n\n${body}` : body, blocks: blocks.length, parts: allParts.length };
}

export async function readDocRow(client, docId) {
  const { rows } = await client.query(
    `SELECT content_mode, content, content_hash, generated_from_sha, projected_clients
       FROM harness_shared.harness_docs
      WHERE workspace_id = $1 AND harness_slug = $2 AND doc_id = $3`,
    [WORKSPACE_ID, HARNESS_SLUG, docId],
  );
  return rows[0] ?? null;
}

/**
 * Cache the composed output back onto the parent doc row.
 *
 * `content_hash` is the hash of the CACHED CONTENT (its documented meaning), and the
 * sha of the source the parts were loaded from goes in `generated_from_sha`, the
 * column that already means exactly that. P-003's loader wrote the source sha into
 * `content_hash` because `content` was empty at the time; keeping that would leave the
 * two columns meaning different things on different rows.
 */
export async function writeCache(client, docId, text, generatedFromSha) {
  await client.query(
    `UPDATE harness_shared.harness_docs
        SET content = $4, content_hash = $5, generated_from_sha = COALESCE($6, generated_from_sha),
            updated_at = now()
      WHERE workspace_id = $1 AND harness_slug = $2 AND doc_id = $3`,
    [WORKSPACE_ID, HARNESS_SLUG, docId, text, sha256(text), generatedFromSha ?? null],
  );
}

/**
 * Record what we just wrote to each client's file (migration 783).
 *
 * `||` shallow-merges, so a client whose write was REFUSED keeps its previous record
 * instead of being erased by a run that only succeeded for its sibling. That coupling is
 * the compounding half of EI-20055472930397669: the original code gated the single cache
 * write on a GLOBAL `failed` flag, so one client's refusal also threw away the other
 * client's fresh record, and every subsequent run started further behind.
 *
 * Called only after a successful write — a dry run records nothing, because nothing on
 * disk changed.
 */
export function projectionRecord({ file, text }) {
  return { file, sha: sha256(text), chars: text.length, written_at: new Date().toISOString() };
}

export async function writeProjectionRecords(client, docId, records) {
  if (!records || Object.keys(records).length === 0) return;
  await client.query(
    `UPDATE harness_shared.harness_docs
        SET projected_clients = COALESCE(projected_clients, '{}'::jsonb) || $4::jsonb,
            updated_at = now()
      WHERE workspace_id = $1 AND harness_slug = $2 AND doc_id = $3`,
    [WORKSPACE_ID, HARNESS_SLUG, docId, JSON.stringify(records)],
  );
}

/** The sha this client's file carried at its last successful projection, or null. */
export function lastProjectionShaFor(doc, client) {
  const rec = doc?.projected_clients?.[client];
  return typeof rec?.sha === 'string' && rec.sha.length === 64 ? rec.sha : null;
}

/**
 * What to pass `writeCache` as `generatedFromSha` — the sha of the SOURCE the parts were
 * loaded from.
 *
 * P-003's loader parked that sha in `content_hash` (there was no `content` yet), so a
 * legacy row needs it moved across exactly once. This is a ONE-TIME migration and must
 * be conditional on the column still being empty: after the first projection
 * `content_hash` holds our OUTPUT, and seeding from it unconditionally would overwrite
 * the real provenance with the previous projection's hash on the very next run — a
 * quiet corruption of the field `overwriteVerdict` trusts to recognise pre-cutover
 * files.
 */
export function sourceShaSeed(doc) {
  if (doc?.generated_from_sha) return null; // already recorded — never re-seed
  return doc?.content_hash || null;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function fmt(n) {
  return n.toLocaleString('en-US');
}

export const HELP_TEXT = `Usage:
  node scripts/project-doc-parts.mjs [options]

Project the canonical harness_shared.harness_doc_parts rows into CLAUDE.md and
AGENTS.md. With no write flag, the command only checks and reports the projection.

Options:
  --write                                      write client projections and cache
  --write-corpus                               write the DB-free corpus projection
  --doc-id=<id>                                document id (default: claude-md)
  --context-tokens=<count>                     context window used for the budget
  --chars-per-token=<count>                    budget chars/token (default: 4)
  --accept-canonicalized-drift=<client>:<sha>  acknowledge reviewed file drift
  -h, --help                                   show this help and exit

Examples:
  node scripts/project-doc-parts.mjs
  node scripts/project-doc-parts.mjs --write
  node scripts/project-doc-parts.mjs --write-corpus`;

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(HELP_TEXT);
    process.exit(0);
  }
  const write = argv.includes('--write');
  const writeCorpus = argv.includes('--write-corpus');
  let acceptedCanonicalizedDrift;
  try {
    acceptedCanonicalizedDrift = parseAcceptedCanonicalizedDrift(argv);
  } catch (err) {
    console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
  if (acceptedCanonicalizedDrift.size > 0 && !write) {
    console.error(
      "✗ --accept-canonicalized-drift is meaningful only with --write.",
    );
    process.exit(2);
  }
  const docId = (argv.find((a) => a.startsWith('--doc-id='))?.split('=')[1]) ?? 'claude-md';
  const contextTokens = Number(argv.find((a) => a.startsWith('--context-tokens='))?.split('=')[1] ?? 400_000);
  const charsPerToken = Number(
    argv.find((a) => a.startsWith('--chars-per-token='))?.split('=')[1] ?? CHARS_PER_TOKEN_KNOWN_MODEL,
  );
  const budget = memoryWarningThreshold({ contextTokens, charsPerToken });

  // ── no-DB degrade, CHECK PATH ONLY ───────────────────────────────────────
  // `gen:client-docs:check` is this file with no flags, and until EI-20272515693397454
  // it ran on NO blocking path: the only thing that would notice a hand-edit to the
  // generated CLAUDE.md/AGENTS.md was an agent happening to run the projector, which is
  // how one jam sat undetected for four days. Wiring it as a repo-wide guard is what
  // closes that, and this branch is the precondition — `connect()` sat OUTSIDE the try,
  // so an unreachable Postgres exited non-zero with a stack trace, and registering it
  // would have failed EVERY off-box run and taught the fleet to ignore the leg. Same
  // reasoning, and same shape, as the sibling `project-authored-docs.ts --check`.
  //
  // ⚠ DELIBERATELY NOT extended to --write / --write-corpus. Those MUTATE the tree, and
  // a write that silently no-ops because its database was unreachable is worse than a
  // loud failure: the caller believes the files were projected when nothing was. A
  // skipped CHECK under-reports drift for one run; a skipped WRITE corrupts the premise
  // every later run is judged against.
  let client;
  try {
    client = await connect();
  } catch (err) {
    if (!write && !writeCorpus) {
      console.log(
        `project-doc-parts: SKIPPED — Postgres unreachable, so projection drift cannot be measured here.\n` +
          `  This is NOT a pass: nothing was checked. Re-run where the operator DB is reachable.\n` +
          `  reason: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(0);
    }
    throw err;
  }
  let failed = false;
  try {
    const doc = await readDocRow(client, docId);
    if (!doc) {
      console.error(`✗ no harness_docs row for ${WORKSPACE_ID}/${HARNESS_SLUG}/${docId} — run the loader first.`);
      process.exit(1);
    }
    if (doc.content_mode !== 'composed') {
      console.error(
        `✗ ${docId} is content_mode='${doc.content_mode}', so its CONTENT is canonical and the parts are` +
          ` derived. Projecting would overwrite the authored source with a composition of derived rows.`,
      );
      process.exit(1);
    }

    const parts = await readProjectedParts(client, docId);
    console.log(`project-doc-parts: ${WORKSPACE_ID}/${HARNESS_SLUG}/${docId}`);
    console.log(`  parts          ${parts.length} projected (${fmt(parts.reduce((a, p) => a + p.body.length, 0))} chars of bodies)`);

    // ── the corpus ───────────────────────────────────────────────────────────
    // Written independently of --write, and that separation is deliberate: D-014
    // gates overwriting the CLIENT files (which would erase 108k of prose every
    // agent reads) behind P-004. This file is NEW and nothing reads it yet, so
    // writing it destroys nothing — and P-004 cannot land without it, since it is
    // the location the doc-claims guards are being re-pointed at.
    const allParts = await readAllParts(client, docId);
    const corpus = composeCorpus(allParts, { sourceSha: doc.generated_from_sha ?? doc.content_hash ?? null });
    const corpusPath = resolve(ROOT, CORPUS_FILE);
    const corpusOnDisk = existsSync(corpusPath) ? readFileSync(corpusPath, 'utf8') : null;
    const corpusVerdict = corpusDriftVerdict({ onDisk: corpusOnDisk, composed: corpus.text });
    console.log(`\n  ${CORPUS_FILE}`);
    console.log(
      `    composed     ${fmt(corpus.text.length)} chars — ${corpus.blocks} block(s) from ${allParts.length} part(s)` +
        ` (${allParts.filter((p) => !p.client_scope.length).length} unprojected)`,
    );
    if (corpusOnDisk === null) console.log('    on disk      absent');
    else console.log(`    on disk      ${fmt(corpusOnDisk.length)} chars — ${corpusVerdict.ok ? 'IDENTICAL ✓' : 'DIFFERS'}`);
    if (!write && !writeCorpus && !corpusVerdict.ok) {
      failed = true;
      if (corpusVerdict.reason === 'absent') {
        console.error(`    ✗ CHECK: ${CORPUS_FILE} is absent; the canonical rows were not measured against a committed subject.`);
      } else {
        console.error(
          `    ✗ CHECK: ${CORPUS_FILE} differs from the canonical row composition ` +
          `(live ${corpusVerdict.live.slice(0, 16)}, expected ${corpusVerdict.expected.slice(0, 16)}).`,
        );
      }
      console.error(
        `      The source sha identifies the original CLAUDE.md load only; this byte comparison catches direct row edits too. ` +
        `Re-run with --write-corpus after reviewing the canonical rows.`,
      );
    }
    if (write || writeCorpus) {
      writeFileSync(corpusPath, corpus.text, 'utf8');
      console.log(`    ✓ wrote ${CORPUS_FILE}`);
    }

    console.log(`  budget         ${fmt(budget)} chars  (context ${fmt(contextTokens)} × ${MEMORY_WARN_CONTEXT_FRACTION} × ${charsPerToken} chars/token, floor ${fmt(MEMORY_WARN_FLOOR_CHARS)})`);

    /** Per-client projection records for this run — see writeProjectionRecords. */
    const records = {};
    let primaryText = null;

    for (const spec of CLIENTS) {
      const out = projectClient(parts, { ...spec, docId, budget });
      const invariantCuts = invariantCutKeys(out.dropped);
      const path = resolve(ROOT, spec.file);
      const missing = verifyBodiesPresent(out.text, out.kept);
      const onDisk = existsSync(path) && !lstatSync(path).isSymbolicLink() ? readFileSync(path, 'utf8') : null;
      const isSymlink = existsSync(path) && lstatSync(path).isSymbolicLink();

      console.log(`\n  ${spec.file}  (client=${spec.client})`);
      console.log(`    composed     ${fmt(out.text.length)} chars — ${out.kept.length} part(s) kept, ${out.dropped.length} cut by budget`);
      console.log(`    headroom     ${fmt(budget - out.text.length)} chars under the ${fmt(budget)}-char budget`);
      if (isSymlink) console.log(`    on disk      SYMLINK -> ${readlinkSync(path)} (retired by --write)`);
      else if (onDisk === null) console.log('    on disk      absent');
      else console.log(`    on disk      ${fmt(onDisk.length)} chars — ${onDisk === out.text ? 'IDENTICAL ✓' : 'DIFFERS'}`);

      if (missing.length) {
        failed = true;
        console.error(`    ✗ ${missing.length} kept part(s) missing from the composed output: ${missing.slice(0, 5).join(', ')}`);
      }
      if (out.dropped.length) {
        console.log(`    ⚠ cut: ${out.dropped.map((d) => d.part_key).slice(0, 8).join(', ')}${out.dropped.length > 8 ? ` (+${out.dropped.length - 8})` : ''}`);
      }
      if (invariantCuts.length) {
        failed = true;
        console.error(
          `    ✗ SAFETY REFUSAL: the budget would cut ${invariantCuts.length} invariant(s): ` +
            `${invariantCuts.join(', ')}. Split evidence out of those canonical rows or ` +
            `reduce other invariant prose; never green a projection that silently omits a safety rail.`,
        );
      }
      for (const warning of out.warnings) console.warn(`    ⚠ projection warning: ${warning}`);

      // A symlink has no content of its own to protect — retiring it destroys nothing,
      // because its target is the OTHER client's file, which is written separately.
      //
      // `contentHash` is offered ONLY to the primary client, because that is the only
      // client it describes (it is the hash of the cached `content`, which is the
      // primary's composition). Offering it to every client is precisely
      // EI-20055472930397669 — it can never match a second client's bytes, so that
      // client was refused forever.
      const isPrimary = spec.client === CLIENTS[0].client;
      const verdict = isSymlink
        ? { ok: true, reason: "symlink" }
        : overwriteVerdict({
            onDisk,
            generatedFromSha: doc.generated_from_sha,
            contentHash: isPrimary ? doc.content_hash : null,
            lastProjectionSha: lastProjectionShaFor(doc, spec.client),
            nextText: out.text,
            acceptedCanonicalizedDriftSha:
              acceptedCanonicalizedDrift.get(spec.client) ?? null,
          });
      if (!verdict.ok) {
        const expected = [
          lastProjectionShaFor(doc, spec.client) && `last ${spec.client} projection ${lastProjectionShaFor(doc, spec.client).slice(0, 16)}`,
          doc.generated_from_sha && `loaded-from ${String(doc.generated_from_sha).slice(0, 16)}`,
          isPrimary && doc.content_hash && `cached composition ${String(doc.content_hash).slice(0, 16)}`,
        ].filter(Boolean).join(', ') || 'nothing on record';
        console.error(
          `    ✗ REFUSING to overwrite ${spec.file}: on-disk bytes are neither the source the parts were\n` +
            `      loaded from nor a projection we wrote — somebody edited it (live ${verdict.live.slice(0, 16)};\n` +
            `      on record: ${expected}).\n` +
            `      Writing would erase that edit, so this refusal is correct — RESOLVE IT BY HAND:\n` +
            `      diff the file against the parts, move anything worth keeping INTO the parts\n` +
            `      (harness_shared.harness_doc_parts), then re-run this projector.\n` +
            `      If canonicalization changes the projected budget/cut set, explicitly bind the\n` +
            `      reviewed bytes with --accept-canonicalized-drift=${spec.client}:${verdict.live}\n` +
            `      on the --write retry. The full SHA is a compare-and-swap guard: any later peer edit\n` +
            `      changes it and makes the overwrite refuse again.\n` +
            `      ⛔ Do NOT "fix" this by re-running the loader over the file. Post-cutover this\n` +
            `         file is our OUTPUT and carries only the projected subset, so re-ingesting it\n` +
            `         TOMBSTONES every unprojected prose part — the whole corpus. The loader now\n` +
            `         refuses that (P-013), and the refusal is the guard, not an obstacle.`,
        );
        failed = true;
      } else if (missing.length) {
        // The composition self-check failed above. Writing anyway would put a file on
        // disk that is missing a rule the rows carry — exactly what verifyBodiesPresent
        // exists to catch — and a non-zero exit does not un-write a file.
        console.error(`    ✗ NOT writing ${spec.file}: the composition self-check above failed.`);
      } else if (invariantCuts.length) {
        console.error(`    ✗ NOT writing ${spec.file}: the invariant-cut safety check above failed.`);
      } else if (write) {
        // The symlink is retired here, not by hand, so each client genuinely owns its
        // file. Unlinking first matters: writeFileSync THROUGH a symlink would write
        // the other client's file instead.
        if (isSymlink) unlinkSync(path);
        writeFileSync(path, out.text, 'utf8');
        records[spec.client] = projectionRecord({ file: spec.file, text: out.text });
        if (isPrimary) primaryText = out.text;
        console.log(`    ✓ wrote ${spec.file}  (${verdict.reason})`);
      } else {
        // Reported on a dry run too, and deliberately: the verdict is the interesting
        // half of `--check`. Without it a dry run cannot distinguish "this file would be
        // updated" from "this file would be REFUSED", which is exactly the state
        // EI-20055472930397669 sat in undetected — and it makes the guard falsifiable
        // against the live database with no write.
        console.log(`    overwrite    allowed (${verdict.reason}) — dry run, not written`);
      }
    }

    if (write) {
      // Per client, and merged — so a client that was refused keeps its old record
      // rather than having it dropped by its sibling's successful run. Gating this on a
      // GLOBAL failure flag is what made the original drift COMPOUND: one refusal threw
      // away the other file's fresh record too, so the next run started further behind.
      await writeProjectionRecords(client, docId, records);
      if (Object.keys(records).length) {
        console.log(`\n  ✓ recorded ${Object.keys(records).length} client projection(s) on harness_docs.projected_clients`);
      }
      // Only the primary client's composition is cached in `content`; AGENTS.md is a
      // second projection of the same parts, not a second document.
      if (primaryText !== null) {
        await writeCache(client, docId, primaryText, sourceShaSeed(doc));
        console.log(`  ✓ cached the ${CLIENTS[0].file} composition on harness_docs.content`);
      }
    }

    if (!write) {
      console.log('\n  budget matrix (a file must fit the SMALLEST threshold it may be read under):');
      for (const r of budgetMatrix()) {
        console.log(`    ${fmt(r.contextTokens).padStart(9)} ctx × ${r.charsPerToken} chars/token -> ${fmt(r.threshold).padStart(7)}`);
      }
      console.log('\n  ✓ dry run — nothing written. Re-run with --write to project.');
    }
  } finally {
    await client.end();
  }
  process.exit(failed ? 1 : 0);
}
