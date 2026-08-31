#!/usr/bin/env node
/**
 * check-deps-wiring-parity.mjs — the two-entrypoint seam-drift trap, mechanised
 * (WI-1728261, residue of WI-1664060; third sibling of `lint:optional-seam-strands`
 * and `lint:di-seam-arity-strands`).
 *
 * THE GAP THIS CLOSES. Its two siblings both look at a seam from ONE side:
 *   - `lint:required-field-strands` — adding a REQUIRED member strands construction
 *     sites, LOUDLY, at tsc. Solved; the guard just points at tsc.
 *   - `lint:optional-seam-strands` — adding an OPTIONAL member strands FIXTURES,
 *     which then silently execute the real implementation.
 * Neither can see the failure that has now happened FOUR times in the Scout lane:
 * two PRODUCTION construction sites of the same deps interface, where one wires a
 * seam member and the other does not. Both typecheck (the member is optional), no
 * fixture is involved, and the orchestrator's `if (deps.x)` guard turns the omission
 * into a silent no-op on whichever entry point forgot it.
 *
 * THE MEASURED HISTORY (all four in `ScoutCycleDeps`, one lane, ~5 months):
 *   1. P-051 workspace scout spend ceiling — wired in the routine action, missing
 *      from the blueprint op. Refused nothing for months while blender spend
 *      compounded past the ceiling into the hundreds of dollars.
 *   2. `potGate` (learning-pot-scope-gate D-001) — same shape, caught during review.
 *   3. `resolveConfigDelta` (WI-1664060) — the pot's scout/cadence/budget tuning was
 *      written by the drawer and never read on the path that actually runs Scout.
 *   4. `hiveRunnerGate` (P-019 cross-node single-runner) — wired in the blueprint op
 *      2026-06-19 and NEVER present in the routine action. Found by this guard.
 *
 * Note the DIRECTION of #4: the first three had the routine action carrying the
 * concern and the blueprint op missing it, so the folk remedy that grew up in the
 * comments ("remember to also wire it in the blueprint op") could not have caught it.
 * Only a SYMMETRIC check does — which is the entire reason this is mechanical and not
 * a review convention. Every previous fix was "remember harder"; this is "stop having
 * two places that can disagree without anything noticing".
 *
 * WHAT IT CHECKS. For every exported interface / object-type alias that looks like a
 * dependency seam (≥2 OPTIONAL members whose type is a function type or a `typeof x`
 * query — the two forms an injectable takes in this repo), it finds the PRODUCTION
 * object literals that construct it, and reports any seam member wired at one site
 * and absent at another.
 *
 * WHY PRODUCTION-ONLY. Test files are deliberately excluded: a fixture omitting a seam
 * is the SIBLING guard's subject, and it is usually correct (the hermetic contract in
 * `scout/run.ts` depends on unwired seams meaning "no gate"). Flagging fixtures here
 * would bury the real finding in noise.
 *
 * WHY IT IS A CHEAP HEURISTIC, NOT TYPE RESOLUTION. Same posture as the siblings: a
 * construction site is recognised by object-literal SHAPE (its property names are a
 * subset of the interface's members and cover every REQUIRED member), not by asking
 * the type-checker. This is advisory, so a false positive costs a reader a glance.
 * The `...(x ? { x } : {})` conditional-spread idiom IS understood, because that is
 * how a factory that threads seams through parameters builds its deps object — miss
 * it and the guard would report every such site as wiring nothing.
 *
 * WHY THE MERE ASYMMETRY IS NOT AUTOMATICALLY A BUG. Sometimes one entry point
 * genuinely should not carry a concern. That is what the shrink-only FAIL_BASELINE is
 * for: `--fail` blocks on NEW divergence only, so a deliberate asymmetry is recorded
 * once, with a reason, instead of being re-litigated on every run.
 *
 *   node scripts/check-deps-wiring-parity.mjs             # advisory: name findings
 *   node scripts/check-deps-wiring-parity.mjs --json
 *   node scripts/check-deps-wiring-parity.mjs --fail      # exit 1 on NEW findings
 *   node scripts/check-deps-wiring-parity.mjs --list      # measured population, to re-seed the baseline
 *   node scripts/check-deps-wiring-parity.mjs --include-observers   # widen to on<Event> callbacks too
 *   node scripts/check-deps-wiring-parity.mjs --files=a.ts,b.ts
 *
 * Exit codes:
 *   0 — no divergence, or (default) findings reported only
 *   1 — only with --fail, and only when a NEW divergence was found
 *   2 — EXIT_NOT_CHECKED: zero candidate files examined (a scan that measured nothing
 *       must never read as a clean bill of health)
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const EXIT_NOT_CHECKED = 2;

function git(args) {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/** Tracked .ts/.tsx source files, excluding tests/dist/node_modules/generated output. */
function defaultCandidateFiles() {
  return git(['ls-files', '--', '*.ts', '*.tsx'])
    .split('\n')
    .filter(Boolean)
    .filter((f) => !/\.(test|spec|integration\.test)\.tsx?$/.test(f))
    .filter((f) => !/(^|\/)(dist|build|node_modules|\.papercusp|__tests__|__mocks__)\//.test(f))
    .filter((f) => !f.startsWith('papercup-release/') && !f.startsWith('papercup-checkpoint/'));
}

/**
 * Is this type node an injectable-seam shape? A function type (`(x) => y`) or a type
 * query (`typeof someImplementation`) — the two forms every test-double takes here.
 * A plain optional scalar (`label?: string`) is deliberately NOT a seam.
 *
 * ⚠ KNOWN FALSE-NEGATIVE, stated rather than hidden: a seam typed through a NAMED
 * alias (`buildDeps?: ScoutTickDepsBuilder`) is not recognised, because resolving the
 * alias needs the type-checker this guard deliberately does not run. Widening to every
 * optional TypeReference would drag in ordinary alias-typed scalars. So divergence in
 * an alias-typed seam is NOT covered — the same narrowing `lint:optional-seam-strands`
 * documents for itself.
 */
function isSeamTypeNode(typeNode) {
  if (!typeNode) return false;
  return ts.isFunctionTypeNode(typeNode) || ts.isTypeQueryNode(typeNode);
}

/**
 * An `on<Event>`-named seam is an OBSERVER, not a concern — and the distinction is the
 * difference between signal and noise here.
 *
 * The bug this guard exists for is "a cross-cutting concern that must run on every path
 * silently doesn't". A gate/resolver/loader left unwired means THIS PATH SKIPS THE
 * CONCERN — the failure. An `onProgress` / `onReply` / `onEnrolled` left unwired means
 * "this caller does not care to observe", which is the intended semantics of an optional
 * callback and is correct at the majority of call sites. Measured over the tree at
 * authoring time, observer callbacks were the single largest noise class.
 *
 * They stay MEASURABLE (`--include-observers`) so this narrowing is a stated bound on
 * the population, never a silent one.
 */
function isObserverName(name) {
  return /^on[A-Z]/.test(name);
}

/**
 * Deps-interface descriptors declared in one source file.
 * [{ name, members:Set, required:Set, optionalSeams:Set, file, line }]
 */
export function findDepsInterfacesInSource(sourceText, fileName = 'f.ts', opts = {}) {
  const sf = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const found = [];

  function record(name, members, node) {
    const all = new Set();
    const required = new Set();
    const optionalSeams = new Set();
    for (const m of members) {
      if (!ts.isPropertySignature(m) || !m.name || !ts.isIdentifier(m.name)) continue;
      const key = m.name.text;
      all.add(key);
      if (m.questionToken) {
        if (isSeamTypeNode(m.type) && (opts.includeObservers || !isObserverName(key))) optionalSeams.add(key);
      } else {
        required.add(key);
      }
    }
    // A deps seam needs at least two optional injectables — one is not a pattern,
    // and requiring two keeps ordinary option-bags out of the population.
    if (optionalSeams.size < 2) return;
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    found.push({ name, members: all, required, optionalSeams, file: fileName, line: line + 1 });
  }

  function isExported(node) {
    return (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Export) !== 0;
  }

  function visit(node) {
    if (ts.isInterfaceDeclaration(node) && isExported(node)) {
      record(node.name.text, node.members, node);
    } else if (ts.isTypeAliasDeclaration(node) && isExported(node) && ts.isTypeLiteralNode(node.type)) {
      record(node.name.text, node.type.members, node);
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return found;
}

/**
 * The property names an object literal contributes, INCLUDING the conditional-spread
 * idiom `...(x ? { x } : {})` that a seam-threading factory uses. Returns null when the
 * literal contains a spread this function cannot see through (a spread of an opaque
 * identifier means the real key set is unknown, and guessing it would invent findings).
 */
export function objectLiteralPropertyNames(objLiteral) {
  const names = new Set();
  for (const prop of objLiteral.properties) {
    if (ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop)) {
      if (prop.name && ts.isIdentifier(prop.name)) names.add(prop.name.text);
      else return null; // computed / string key — shape is not statically known
      continue;
    }
    if (ts.isSpreadAssignment(prop)) {
      const inner = collectSpreadNames(prop.expression);
      if (inner === null) return null;
      for (const n of inner) names.add(n);
      continue;
    }
    // A method or accessor declaration on a deps literal is still a wired member.
    if ((ts.isMethodDeclaration(prop) || ts.isGetAccessorDeclaration(prop)) && prop.name && ts.isIdentifier(prop.name)) {
      names.add(prop.name.text);
      continue;
    }
    return null;
  }
  return names;
}

/** Names contributed by a spread expression, or null when it is opaque. */
function collectSpreadNames(expr) {
  let e = expr;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  if (ts.isObjectLiteralExpression(e)) return objectLiteralPropertyNames(e);
  if (ts.isConditionalExpression(e)) {
    const a = collectSpreadNames(e.whenTrue);
    const b = collectSpreadNames(e.whenFalse);
    if (a === null || b === null) return null;
    return new Set([...a, ...b]);
  }
  // `...(x && { x })` / `...(x ?? {})`
  if (ts.isBinaryExpression(e)) {
    const k = e.operatorToken.kind;
    if (
      k === ts.SyntaxKind.AmpersandAmpersandToken ||
      k === ts.SyntaxKind.BarBarToken ||
      k === ts.SyntaxKind.QuestionQuestionToken
    ) {
      const a = collectSpreadNames(e.left);
      const b = collectSpreadNames(e.right);
      // The left of `&&` is a condition, not a shape; treat an unreadable side as empty
      // only when the OTHER side is readable, so `...(x && { x })` yields {x}.
      if (a === null && b === null) return null;
      return new Set([...(a ?? []), ...(b ?? [])]);
    }
    return null;
  }
  return null; // bare identifier spread — opaque
}

/**
 * Construction sites of deps-shaped object literals in one source file.
 * [{ file, line, names:Set }]
 */
export function findDepsLiteralsInSource(sourceText, fileName = 'f.ts') {
  const sf = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const sites = [];
  function visit(node) {
    if (ts.isObjectLiteralExpression(node)) {
      const names = objectLiteralPropertyNames(node);
      if (names && names.size >= 2) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        sites.push({ file: fileName, line: line + 1, names });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return sites;
}

/**
 * Attribute a literal to the deps interface it most plausibly constructs:
 * every property name must be a member, and every REQUIRED member must be present.
 * On a tie the literal is ambiguous and is dropped rather than guessed.
 */
export function attributeLiteral(names, interfaces) {
  const candidates = [];
  for (const iface of interfaces) {
    let subset = true;
    for (const n of names) {
      if (!iface.members.has(n)) {
        subset = false;
        break;
      }
    }
    if (!subset) continue;
    let coversRequired = true;
    for (const r of iface.required) {
      if (!names.has(r)) {
        coversRequired = false;
        break;
      }
    }
    if (!coversRequired) continue;
    candidates.push(iface);
  }
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  let best = candidates[0];
  let bestScore = -1;
  let tied = false;
  for (const c of candidates) {
    let score = 0;
    for (const n of names) if (c.optionalSeams.has(n)) score += 1;
    if (score > bestScore) {
      bestScore = score;
      best = c;
      tied = false;
    } else if (score === bestScore) {
      tied = true;
    }
  }
  return tied ? null : best;
}

/**
 * THE DETECTOR. `sources` is [{ fileName, text }] — every production file to consider.
 * Returns [{ interface, declaredIn, file, line, missing:string[], wiredElsewhereAt }]:
 * one finding per construction site that omits a seam another site wires.
 */
export function findWiringParityGaps(sources, opts = {}) {
  const interfaces = [];
  for (const { fileName, text } of sources) {
    for (const iface of findDepsInterfacesInSource(text, fileName, opts)) interfaces.push(iface);
  }
  if (interfaces.length === 0) return [];

  /** interfaceName -> [{ file, line, names }] */
  const sitesByInterface = new Map();
  for (const { fileName, text } of sources) {
    for (const site of findDepsLiteralsInSource(text, fileName)) {
      const iface = attributeLiteral(site.names, interfaces);
      if (!iface) continue;
      // A literal wiring no optional seam at all is an option-bag, not a deps object.
      let wiresASeam = false;
      for (const n of site.names) if (iface.optionalSeams.has(n)) wiresASeam = true;
      if (!wiresASeam) continue;
      const key = `${iface.file}:${iface.name}`;
      if (!sitesByInterface.has(key)) sitesByInterface.set(key, { iface, sites: [] });
      sitesByInterface.get(key).sites.push(site);
    }
  }

  const findings = [];
  for (const { iface, sites } of sitesByInterface.values()) {
    if (sites.length < 2) continue; // one production site cannot diverge from itself
    const union = new Set();
    for (const s of sites) for (const n of s.names) if (iface.optionalSeams.has(n)) union.add(n);
    for (const s of sites) {
      const missing = [...union].filter((n) => !s.names.has(n)).sort();
      if (missing.length === 0) continue;
      const wiredElsewhereAt = {};
      for (const n of missing) {
        const other = sites.find((o) => o !== s && o.names.has(n));
        if (other) wiredElsewhereAt[n] = `${other.file}:${other.line}`;
      }
      findings.push({
        interface: iface.name,
        declaredIn: `${iface.file}:${iface.line}`,
        file: s.file,
        line: s.line,
        missing,
        wiredElsewhereAt,
      });
    }
  }
  return findings.sort((a, b) => a.interface.localeCompare(b.interface) || a.file.localeCompare(b.file) || a.line - b.line);
}

/**
 * SHRINK-ONLY baseline of divergences that existed when this guard was wired onto a
 * blocking path. `--fail` blocks on NEW findings only; wiring it unbaselined would
 * red-pin the fleet on debt that accrued while the guard ran nowhere.
 *
 * Each row is `<interface>|<file>|<missing,members>` — deliberately LINE-INDEPENDENT,
 * so an unrelated edit above the site does not silently un-baseline it.
 *
 * ⚠ Add a row ONLY for a divergence that is deliberate (one entry point genuinely
 * should not carry the concern) or already filed. State which, and why, on the row.
 */
const FAIL_BASELINE = new Map([
  // Seeded from the measured `--list` run at wiring time; see this file's git history.
]);

/** The line-independent identity a baseline row matches on. */
function findingKey(f) {
  return `${f.interface}|${f.file}|${f.missing.join(',')}`;
}

function parseArgs(argv) {
  const opts = { json: false, fail: false, list: false, includeObservers: false, files: null };
  for (const a of argv) {
    if (a === '--json') opts.json = true;
    else if (a === '--fail') opts.fail = true;
    else if (a === '--list') opts.list = true;
    else if (a === '--include-observers') opts.includeObservers = true;
    else if (a.startsWith('--files=')) opts.files = a.slice('--files='.length).split(',').filter(Boolean);
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const files = opts.files ?? defaultCandidateFiles();

  if (files.length === 0) {
    console.log(
      'check-deps-wiring-parity: ⚠ NOT CHECKED — zero candidate files examined.\n' +
        'This is NOT a clean result; it means the scan measured nothing.',
    );
    process.exit(EXIT_NOT_CHECKED);
  }

  const sources = [];
  for (const f of files) {
    try {
      sources.push({ fileName: f, text: readFileSync(resolve(REPO_ROOT, f), 'utf8') });
    } catch {
      // A path in the index but not on disk (mid-rebase, sparse checkout) is skipped;
      // it cannot contribute a construction site either way.
    }
  }

  const allFindings = findWiringParityGaps(sources, { includeObservers: opts.includeObservers });
  const liveKeys = new Set(allFindings.map(findingKey));
  const newFindings = allFindings.filter((f) => !FAIL_BASELINE.has(findingKey(f)));
  const baselined = allFindings.filter((f) => FAIL_BASELINE.has(findingKey(f)));
  const staleBaseline = [...FAIL_BASELINE.keys()].filter((k) => !liveKeys.has(k));

  if (opts.json) {
    console.log(
      JSON.stringify(
        { ok: true, examined: sources.length, findings: allFindings, newFindings, baselinedCount: baselined.length, staleBaseline },
        null,
        2,
      ),
    );
  } else if (opts.list) {
    // The MEASURED population, in baseline-row form — this is how FAIL_BASELINE is
    // re-seeded. Never hand-write a baseline row from a grep.
    for (const f of allFindings) console.log(`  ['${findingKey(f)}', 'REASON HERE'],`);
    console.log(`\ncheck-deps-wiring-parity: ${allFindings.length} finding(s) over ${sources.length} files.`);
  } else if (allFindings.length === 0) {
    console.log(`check-deps-wiring-parity: ✓ examined ${sources.length} files, every deps seam is wired identically at all production sites.`);
  } else {
    console.log(
      `check-deps-wiring-parity: found ${allFindings.length} production construction site(s) omitting a seam ` +
        `another site wires (examined ${sources.length} files):\n`,
    );
    for (const f of allFindings) {
      const mark = FAIL_BASELINE.has(findingKey(f)) ? '  [baselined — deliberate or already filed]' : '';
      console.log(`  ${f.file}:${f.line}  constructs \`${f.interface}\` (declared ${f.declaredIn})${mark}`);
      for (const m of f.missing) {
        console.log(`    missing seam \`${m}\` — wired at ${f.wiredElsewhereAt[m] ?? '(another site)'}`);
      }
      console.log('');
    }
    console.log(
      'An omitted seam is a silent no-op, not a type error: the orchestrator guards it\n' +
        'with `if (deps.x)`, so the entry point that forgot it just quietly skips the\n' +
        'concern. Check whether the asymmetry is deliberate before baselining it.\n' +
        `--fail blocks on NEW findings only (${newFindings.length} new, ${baselined.length} baselined).`,
    );
  }

  if (staleBaseline.length > 0) {
    console.log(
      `\n⚠ ${staleBaseline.length} STALE baseline row(s) — the divergence no longer exists; prune from FAIL_BASELINE:\n` +
        staleBaseline.map((k) => `    ${k}`).join('\n'),
    );
  }

  if (opts.fail && newFindings.length > 0) process.exit(1);
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
