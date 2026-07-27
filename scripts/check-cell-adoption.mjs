#!/usr/bin/env node
/**
 * check-cell-adoption.mjs — the ADOPTION GATE for the agent state plane.
 * Plan `unified-agent-state-plane-2026-07-27` (P-005), enforcing D-010.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS AT ALL, AND WHY IT SHIPS *WITH* THE REGISTRY
 *
 * D-010 makes this gate a PRECONDITION of the cell registry (P-003), not a
 * follow-up. The reason is measured, not hypothetical: `predicate_watches` is
 * shipped, correct in principle, and has NEVER been adopted — 0 rows across all
 * tenants, active and inactive, verified 2026-07-27. A registry nobody registers
 * into is not neutral; it is surface #29 and strictly WORSE than today, because
 * it adds a place to look without removing one.
 *
 * So the registry's value does not come from existing. It comes from being the
 * cheapest path when an author reaches for a new state read. This gate is what
 * puts the registry on that path: the moment someone mints a NEW state-read tool,
 * they must say — in the file, mechanically checked — whether it is a lens on a
 * cell or why it is not one.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * THE POSTURE (modelled on `lint:no-raw-setinterval`, P-007/P-008)
 *
 * Same three-part shape, deliberately:
 *   1. a PURE, unit-tested predicate (so "it fails on a NEW violation" is a
 *      verified property, not merely green-on-a-clean-tree);
 *   2. a GATING failure on anything new (exit 1, in CI);
 *   3. a SHRINK-ONLY BASELINE grandfathering what already exists.
 *
 * ⚠ ONE DELIBERATE ASYMMETRY vs the setInterval guard. That guard's BASELINE is
 * EMPTY today because P-008 migrated all 74 sites first. This one CANNOT be empty
 * yet: retiring the existing bespoke state reads is P-020 (D-018 A.3), which is
 * blocked-by P-007 and has not run. Seeding a non-empty baseline is therefore the
 * honest state, not a weakening — the ratchet property (a NEW violation fails the
 * build) holds from day one either way. P-020 empties it.
 *
 * The baseline is keyed by TOOL NAME, not by file, and that is load-bearing in
 * both directions: a file-keyed baseline would let a NEW state-read tool slip in
 * beside a grandfathered one in the same file, and P-020 retires TOOLS, so a
 * name-keyed baseline is the surface it can actually shrink one entry at a time.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * WHY THE DECLARATION IS A COMMENT MARKER AND NOT A `defineTool` FIELD
 *
 * The obvious design — a typed `cell:` field on defineTool — is wrong here, for a
 * reason worth recording so it is not re-proposed. `defineTool` lives in
 * `libs/generic/tooldef`, a domain-free borrowable lib that must not depend on
 * operator-core. A "cell" is a papercusp-domain concept from this plan's D-038;
 * putting it in the generic lib's input type inverts that layering. (It would also
 * trip TS excess-property checking on 700 existing call sites' object literals.)
 *
 * So the declaration is a structured marker inside the `defineTool({ ... })`
 * literal — unambiguous, greppable, and costing the generic lib nothing:
 *
 *     // @cell-lens git.pipelinePosition
 *          → this tool PROJECTS a registered cell. D-038 axis 5 (one derivation,
 *            many lenses): a surface may project or subset a cell, never re-derive
 *            it. This is the intended path.
 *
 *     // @not-a-cell <reason, >= 24 chars>
 *          → an explicit, reasoned exemption.
 *
 * The exemption is what stops this gate from blocking legitimate non-cell reads
 * that trip the signature. It is also the thing most likely to rot into a rubber
 * stamp — which is the measured failure of `check-generic-first.mjs` (advisory,
 * ALLOW set, nobody looks). Two mechanical defences: a reason SHORTER than
 * MIN_EXEMPTION_REASON is refused outright, and every exemption is COUNTED and
 * printed on success, so growth is visible rather than silent.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * LIMITS OF THE SIGNATURE — stated, because a gate that oversells itself is worse
 * than one that does not exist.
 *
 * `isStateReadCandidate` is a SYNTACTIC signature over the tool's name and
 * capability. It cannot know semantically whether "a cell would serve". It was
 * calibrated against the real corpus (700 defineTool call sites, 2026-07-27) and
 * selects 35 — ~11% of the 294 read-capability tools — closely matching the ~28
 * bespoke state reads this plan counted independently. That agreement is the
 * evidence the signature is aimed at the right population; it is NOT proof of
 * completeness. It WILL miss a state read with an unremarkable name
 * (`dev:pg_active_queries` is one). Those are P-007/P-020's job to find
 * semantically. This gate's guarantee is narrower and precise: the state reads it
 * DOES name cannot grow silently.
 *
 * Nor does it verify that a `@cell-lens` id is actually REGISTERED — cells
 * register at runtime, in their owners' modules, so a static scanner cannot see
 * the map. It checks the id is well-formed only.
 *
 * And it scans `git ls-files`, so a brand-new tool file is invisible until it is
 * TRACKED: an author who runs this locally seconds after creating the file gets a
 * false green. That is inherited from the setInterval guard and is acceptable for
 * the gating path it protects — git-sync commits this tree continuously and CI
 * runs on committed code, so the window closes on its own — but it does mean a
 * local green is not proof, and CI's verdict is the one that counts.
 *
 *   node scripts/check-cell-adoption.mjs
 */
import { execSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const ROOT = new URL('..', import.meta.url).pathname;

/** Where agent tools are declared. */
export const SCAN_DIRS = ['packages/operator-core/lib/agent-tools', 'packages/agent-mcp/src/tools'];

/**
 * Nouns that mark a "what is the CURRENT STATE of X?" question rather than a
 * "give me the record for X" question. Derived from the corpus, not invented:
 * these are the tokens the existing bespoke state reads actually use.
 */
export const STATE_NOUNS = [
  'status',
  'health',
  'state',
  'position',
  'presence',
  'inventory',
  'ports',
  'processes',
  'running',
  'capacity',
  'usage',
  'uptime',
];

export const STATE_NOUN_RE = new RegExp(`(^|[:_-])(${STATE_NOUNS.join('|')})([:_-]|$)`);

/**
 * Verb prefixes that mark a MUTATION. Needed because the state nouns above appear
 * in write verbs too — `work_items:set_state` and `processes:kill` both match the
 * noun signature and neither is a state read.
 */
export const MUTATING_VERBS = [
  'set', 'kill', 'create', 'delete', 'remove', 'update', 'start', 'stop',
  'pause', 'resume', 'arm', 'disarm', 'emit', 'send', 'write', 'clear',
  'reset', 'restart', 'promote', 'retract', 'cancel', 'apply', 'install',
  'uninstall', 'publish', 'revoke', 'grant', 'ack', 'assign', 'claim',
];

/** Does the verb half of `group:verb` begin with a mutating verb? */
export function isMutatingVerb(verb) {
  return MUTATING_VERBS.some((v) => verb === v || verb.startsWith(`${v}_`) || verb.startsWith(`${v}-`));
}

/**
 * THE PREDICATE. Pure ({ name, capability } -> boolean) so the "flags a NEW state
 * read / does not flag a mutation or a record read" property is unit-testable
 * without executing a tree scan.
 *
 * Note the capability test is "NOT a write" rather than "IS a read": `coord:presence`
 * — the canonical presence cell, and the very surface D-038 axis 5 cites as its
 * model — declares NO capability field at all, so an is-a-read conjunction misses
 * exactly the tool this plane is built around.
 */
export function isStateReadCandidate({ name, capability }) {
  if (!name || !name.includes(':')) return false;
  const verb = name.slice(name.indexOf(':') + 1);
  if (isMutatingVerb(verb)) return false;
  if (capability && /:write$/.test(capability)) return false;
  return STATE_NOUN_RE.test(name);
}

/** `@cell-lens <dotted.cell.id>` — the intended path. */
export const CELL_LENS_RE = /@cell-lens\s+(\S+)/;
/** A well-formed cell id: dotted, lowerCamel segments (matches CellSpec.cell). */
export const CELL_ID_RE = /^[a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*)+$/;
/** `@not-a-cell <reason>` — the reasoned exemption. */
export const NOT_A_CELL_RE = /@not-a-cell\s+([^\n]+)/;
/** A reason shorter than this is a rubber stamp, not a reason. */
export const MIN_EXEMPTION_REASON = 24;

/** How far into a `defineTool({` literal to look. Clamped to the next call site. */
const HEAD_WINDOW = 6000;

/**
 * Parse a source file into its tool declarations. Pure (text -> rows).
 *
 * The attributed region for each tool starts AT its `defineTool({` and ends at
 * whichever comes first: HEAD_WINDOW chars, or the next `defineTool` in the file.
 * That makes marker ownership unambiguous in multi-tool files — the marker belongs
 * to the literal that contains it — which is why the marker must be written INSIDE
 * the object literal rather than in the doc comment above it.
 */
export function parseToolDefs(text) {
  const out = [];
  const re = /defineTool\s*\(\s*\{/g;
  let m;
  while ((m = re.exec(text))) {
    const next = text.indexOf('defineTool', m.index + 1);
    const end = next === -1 ? Math.min(text.length, m.index + HEAD_WINDOW) : Math.min(next, m.index + HEAD_WINDOW);
    const region = text.slice(m.index, end);
    const name = region.match(/\bname:\s*['"]([^'"]+)['"]/)?.[1] ?? null;
    if (!name) continue;
    const capability = region.match(/\bcapability:\s*['"]([^'"]+)['"]/)?.[1] ?? null;
    out.push({
      name,
      capability,
      lens: region.match(CELL_LENS_RE)?.[1] ?? null,
      exemption: region.match(NOT_A_CELL_RE)?.[1]?.trim() ?? null,
    });
  }
  return out;
}

/**
 * Judge one parsed tool. Pure (row -> null | { rule, detail }). Split out from the
 * scan so every branch is unit-testable.
 */
export function judgeToolDef(row) {
  if (!isStateReadCandidate(row)) return null;
  if (row.lens !== null) {
    return CELL_ID_RE.test(row.lens)
      ? null
      : { rule: 'cell-lens-malformed', detail: `@cell-lens "${row.lens}" is not a well-formed cell id (expected dotted lowerCamel, e.g. git.pipelinePosition).` };
  }
  if (row.exemption !== null) {
    return row.exemption.length >= MIN_EXEMPTION_REASON
      ? null
      : { rule: 'exemption-unreasoned', detail: `@not-a-cell needs a real reason (>= ${MIN_EXEMPTION_REASON} chars); got ${row.exemption.length}: "${row.exemption}".` };
  }
  return {
    rule: 'undeclared-state-read',
    detail: 'a NEW state-read tool must declare its relationship to the cell registry.',
  };
}

/**
 * BASELINE — grandfathered bespoke state reads, keyed by TOOL NAME. SHRINK-ONLY.
 *
 * Seeded 2026-07-27 from the signature applied to the tree at seed time, so it is
 * self-consistent by construction and did NOT need P-007's semantic inventory to
 * exist first (P-007 is not done; P-020, which retires these, is blocked on it).
 *
 * ⚠ Do NOT add entries. A NEW state-read tool is a hard failure — declare
 * `@cell-lens` or a reasoned `@not-a-cell` instead. P-020 removes entries from
 * here as it retires each tool onto a cell; the goal state is empty.
 */
export const BASELINE = new Set([
  'accounts:link-status',
  'accounts:status',
  'autoloop:status',
  'autonomy:graduation_status',
  'coord:presence',
  'curation:state-of-pot',
  'deploy:status',
  'dev:build_status',
  'dev:dogfood_substrate_status',
  'dev:listening_ports',
  'dev:pg_health',
  'dev:pipeline_position',
  'dev:processes',
  'dev:rate_governor_status',
  'dev:service_health',
  'dev:stall_waker_status',
  'dev:state_counter',
  'egress:health',
  'events:status',
  'fleet:capacity',
  'fleet:status',
  'gateway:status',
  'harness:health',
  'harness:status',
  'improvements:watchdog-status',
  'operator:credentials_status',
  'operator:trigger_state',
  'plan_items:status',
  'plugins:runtime_status',
  'pot:status',
  'schedule:inventory',
  'scheduler:running',
  'setup:status',
  'storage:usage',
  'ui:get_state',
  'voice:status',
  'watchdog:status',
  'work_items:redundancy_status',
]);

export const isExcluded = (f) =>
  f.includes('/_retired/') ||
  f.includes('/node_modules/') ||
  f.includes('/dist/') ||
  /\.(test|spec)\.[cm]?tsx?$/.test(f) ||
  !/\.ts$/.test(f);

/** Scan the tracked tree. Returns offenders + the visibility counters. */
export function findOffenders() {
  const tracked = execSync(`git ls-files ${SCAN_DIRS.join(' ')}`, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  })
    .split('\n')
    .filter(Boolean);

  const offenders = [];
  const exemptions = [];
  const lenses = [];
  const seen = new Set();

  for (const f of tracked) {
    if (isExcluded(f)) continue;
    let text;
    try {
      text = readFileSync(new URL(f, `file://${ROOT}`), 'utf8');
    } catch {
      continue;
    }
    for (const row of parseToolDefs(text)) {
      if (!isStateReadCandidate(row)) continue;
      seen.add(row.name);
      if (row.lens) lenses.push({ file: f, name: row.name, cell: row.lens });
      if (row.exemption) exemptions.push({ file: f, name: row.name, reason: row.exemption });
      const verdict = judgeToolDef(row);
      if (!verdict) continue;
      // A grandfathered tool is exempt ONLY from the undeclared case. A malformed
      // declaration is always an error: the baseline forgives an absent decision,
      // never a broken one.
      if (verdict.rule === 'undeclared-state-read' && BASELINE.has(row.name)) continue;
      offenders.push({ file: f, name: row.name, ...verdict });
    }
  }

  // Non-fatal hygiene: baseline entries whose tool no longer trips the signature
  // (retired by P-020, renamed, or now declared). Reported so the shrink-only set
  // cannot quietly accumulate dead weight; NOT a failure, because a stale entry
  // cannot cause a wrong answer and a red gate blocks the whole fleet.
  const stale = [...BASELINE].filter((n) => !seen.has(n));
  const redundant = lenses.concat(exemptions).filter((r) => BASELINE.has(r.name)).map((r) => r.name);

  return { offenders, exemptions, lenses, stale, redundant, scanned: seen.size };
}

function main() {
  const { offenders, exemptions, lenses, stale, redundant, scanned } = findOffenders();

  if (offenders.length > 0) {
    console.error('✗ cell-adoption gate (unified-agent-state-plane-2026-07-27 P-005 / D-010):\n');
    for (const o of offenders) {
      console.error(`    ${o.name}  [${o.rule}]`);
      console.error(`      ${o.file}`);
      console.error(`      ${o.detail}`);
    }
    console.error('\n  A new state-read tool must declare, INSIDE its defineTool({ ... }) literal, one of:');
    console.error('\n    // @cell-lens <cell.id>');
    console.error('        This tool PROJECTS a registered cell (D-038 axis 5: one derivation, many');
    console.error('        lenses). Register the cell with registerCell() from');
    console.error('        packages/operator-core/lib/cell-registry.ts — one object literal — then');
    console.error('        point at it. This is the intended path and the cheaper one.');
    console.error('\n    // @not-a-cell <reason, at least ' + MIN_EXEMPTION_REASON + ' chars>');
    console.error('        This read is genuinely not live system state (a record read, a catalog,');
    console.error('        a report). State WHY; the count of exemptions is printed on every run.');
    console.error(`\n  ${offenders.length} offender(s). Do NOT add to BASELINE — it is shrink-only (P-020 empties it).`);
    process.exit(1);
  }

  const parts = [
    `${scanned} state-read tool(s) in scope`,
    `${BASELINE.size} grandfathered (shrink-only, P-020)`,
    `${lenses.length} cell lens(es)`,
    `${exemptions.length} reasoned exemption(s)`,
  ];
  console.log(`✓ no UNDECLARED state-read tool — ${parts.join(' · ')}.`);
  if (exemptions.length > 0) {
    console.log('  exemptions (visible on purpose — growth here means the gate is being routed around):');
    for (const e of exemptions) console.log(`    ${e.name} — ${e.reason}`);
  }
  if (redundant.length > 0) {
    console.log(`  note: ${redundant.length} BASELINE entr(ies) now declare a marker and can be removed: ${redundant.join(', ')}`);
  }
  if (stale.length > 0) {
    console.log(`  note: ${stale.length} BASELINE entr(ies) no longer match any tool (retired/renamed) — delete them: ${stale.join(', ')}`);
  }
  process.exit(0);
}

// CLI-only: importing the module (for the unit test) must not exec git or exit.
// Symlink-robust (WI-1443), same guard as check-no-raw-setinterval.mjs.
const isMain = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  if (import.meta.url === pathToFileURL(argv1).href) return true;
  try {
    return import.meta.url === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return false;
  }
})();
if (isMain) {
  main();
}
