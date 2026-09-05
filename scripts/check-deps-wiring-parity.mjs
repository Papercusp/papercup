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

import { isCliEntry } from '@papercusp/operator-core/lib/util/cli-entry';

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
 * Legacy fallback for an optional callback whose consumer cannot be resolved.
 *
 * The authoritative observer/gate classification is consumption-based (see
 * `buildSeamConsumptionIndex`). Keeping this narrow fallback preserves the old
 * `on<Event>` behavior for unresolved consumers without letting a known consumer's
 * name override its actual use.
 */
function isObserverName(name) {
  return /^on[A-Z]/.test(name);
}

/**
 * Deps-interface descriptors declared in one source file.
 * [{ name, members:Set, required:Set, injectableSeams:Set, optionalSeams:Set, file, line }]
 */
export function findDepsInterfacesInSource(sourceText, fileName = 'f.ts', opts = {}) {
  const sf = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const found = [];

  function record(name, members, node) {
    const all = new Set();
    const required = new Set();
    const injectableSeams = new Set();
    const optionalSeams = new Set();
    for (const m of members) {
      if (!ts.isPropertySignature(m) || !m.name || !ts.isIdentifier(m.name)) continue;
      const key = m.name.text;
      all.add(key);
      if (m.questionToken) {
        if (isSeamTypeNode(m.type)) injectableSeams.add(key);
        const usage = opts.seamConsumption?.get(`${name}|${key}`);
        const semanticallyObserver = usage?.observer === true && usage.gate !== true;
        const unresolvedObserver = usage === undefined && isObserverName(key);
        if (isSeamTypeNode(m.type) && (opts.includeObservers || !(semanticallyObserver || unresolvedObserver))) {
          optionalSeams.add(key);
        }
      } else {
        required.add(key);
      }
    }
    // A deps seam needs at least two optional injectables — one is not a pattern,
    // and requiring two keeps ordinary option-bags out of the population.
    if (injectableSeams.size < 2) return;
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    found.push({ name, members: all, required, injectableSeams, optionalSeams, file: fileName, line: line + 1 });
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

/** The simple name a callee expression resolves to (`f`, `obj.f`), else null. */
function calleeName(expr) {
  let e = expr;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.name)) return e.name.text;
  return null;
}

/** The interface name a type node names directly (`Foo`), else null. */
function typeRefName(typeNode) {
  if (!typeNode) return null;
  if (ts.isTypeReferenceNode(typeNode) && ts.isIdentifier(typeNode.typeName)) return typeNode.typeName.text;
  return null;
}

/**
 * WI-1745363: the declared PARAMETER TYPES of every function this file names, keyed by
 * the callee's simple name. This is what lets a literal be attributed to the interface
 * its CONSUMER declares instead of to whatever interface it happens to fit.
 *
 * Returns [{ name, params:(string|null)[] }] — one row per declaration, so a name
 * declared twice with different signatures can be detected and treated as ambiguous
 * rather than resolved to an arbitrary one of them.
 */
export function findCalleeParamTypesInSource(sourceText, fileName = 'f.ts') {
  const sf = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const found = [];
  const record = (name, parameters) => {
    if (!name) return;
    found.push({ name, params: parameters.map((p) => typeRefName(p.type)) });
  };
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name) record(node.name.text, node.parameters);
    else if (
      (ts.isMethodDeclaration(node) || ts.isMethodSignature(node)) &&
      node.name &&
      ts.isIdentifier(node.name)
    )
      record(node.name.text, node.parameters);
    else if (
      ts.isVariableDeclaration(node) &&
      node.name &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    )
      record(node.name.text, node.initializer.parameters);
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return found;
}

/** Return the parameters/body for function-like nodes with a traversable body. */
function functionLikeParts(node) {
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isMethodSignature(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  ) {
    return { parameters: node.parameters, body: node.body };
  }
  return null;
}

/** Bind directly-typed identifier parameters to the interface they name. */
function typedParameterBindings(parameters) {
  const bindings = new Map();
  for (const parameter of parameters) {
    if (!ts.isIdentifier(parameter.name)) continue;
    const typeName = typeRefName(parameter.type);
    if (typeName) bindings.set(parameter.name.text, typeName);
  }
  return bindings;
}

/**
 * A callback is an observer only when its optional call is a discarded expression
 * statement. Any other consumption is conservatively treated as a gate/capability use.
 */
function isDiscardedOptionalCall(memberAccess) {
  const call = memberAccess.parent;
  if (!ts.isCallExpression(call) || call.expression !== memberAccess || !call.questionDotToken) return false;
  let parent = call.parent;
  while (parent && ts.isParenthesizedExpression(parent)) parent = parent.parent;
  return ts.isExpressionStatement(parent);
}

/**
 * Record direct `ctx.member` uses for one typed function parameter.
 * Nested functions inherit outer bindings unless they shadow the parameter name.
 */
function collectSeamConsumption(body, bindings, out) {
  const visit = (node, activeBindings, isRoot = false) => {
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && ts.isIdentifier(node.name)) {
      const interfaceName = activeBindings.get(node.expression.text);
      if (interfaceName) {
        const key = `${interfaceName}|${node.name.text}`;
        const usage = out.get(key) ?? { observer: false, gate: false };
        if (isDiscardedOptionalCall(node)) usage.observer = true;
        else usage.gate = true;
        out.set(key, usage);
      }
    }

    // Do not attribute a shadowing nested parameter to the outer function, but do
    // continue through closures that capture the outer parameter.
    if (!isRoot) {
      const nested = functionLikeParts(node);
      if (nested) {
        if (!nested.body) return;
        const nestedBindings = new Map(activeBindings);
        for (const parameter of nested.parameters) {
          if (ts.isIdentifier(parameter.name)) nestedBindings.delete(parameter.name.text);
        }
        visit(nested.body, nestedBindings, true);
        return;
      }
    }

    ts.forEachChild(node, (child) => visit(child, activeBindings));
  };

  visit(body, bindings, true);
}

/**
 * Index how directly-typed context/deps parameters consume their members across
 * modules. A member is an observer only when every observed use is a discarded
 * optional call; any condition, argument, assignment, return, or awaited use makes
 * it a gate/capability.
 *
 * Returns Map<`${interfaceName}|${memberName}`, { observer:boolean, gate:boolean }>.
 */
export function buildSeamConsumptionIndex(sources) {
  const out = new Map();
  for (const { fileName, text } of sources) {
    const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
    const visit = (node) => {
      const fn = functionLikeParts(node);
      if (fn?.body) {
        const bindings = typedParameterBindings(fn.parameters);
        if (bindings.size > 0) collectSeamConsumption(fn.body, bindings, out);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return out;
}

/**
 * The ANCHOR that ties an object literal to a named consumer, or null when nothing in
 * the syntax says what the literal is. Three forms, in descending directness:
 *
 *   { typeName }          — `satisfies I`, `as I`, or `const x: I = {…}`
 *   { callee, argIndex }  — the literal is passed directly to `f(…)` / `new F(…)`
 *   { varName }           — `const d = {…}` whose later use in this file supplies one
 *
 * `varName` is resolved by {@link findDepsLiteralsInSource}'s second pass, because the
 * use site (`runScoutCycle(d)`) is what names the consumer, not the declaration.
 */
function literalAnchor(node) {
  let n = node;
  let p = n.parent;
  while (p && (ts.isParenthesizedExpression(p) || ts.isAsExpression(p) || ts.isSatisfiesExpression(p))) {
    if (ts.isAsExpression(p) || ts.isSatisfiesExpression(p)) {
      const t = typeRefName(p.type);
      if (t) return { typeName: t };
    }
    n = p;
    p = p.parent;
  }
  if (!p) return null;
  if (ts.isVariableDeclaration(p) && p.initializer === n) {
    const t = typeRefName(p.type);
    if (t) return { typeName: t };
    if (ts.isIdentifier(p.name)) return { varName: p.name.text };
    return null;
  }
  if ((ts.isCallExpression(p) || ts.isNewExpression(p)) && p.arguments) {
    const argIndex = p.arguments.indexOf(n);
    const callee = calleeName(p.expression);
    if (argIndex >= 0 && callee) return { callee, argIndex };
  }
  return null;
}

/**
 * Construction sites of deps-shaped object literals in one source file.
 * [{ file, line, names:Set, anchor }]
 *
 * ⚠ WI-1745363 — a literal with NO anchor is DROPPED, not guessed at. Before that, a
 * literal was attributed to any deps interface whose members happened to be a superset
 * of its keys, which made every wide all-optional interface a structural magnet: the
 * six narrow helper args in git-sync (`{ runGit, repoPath, log }` → detectUnsafeDeletions
 * and friends) were all reported as diverging `RunGitSyncOpts` constructions, on a
 * `--fail` blocking path, against the tree's ONE real one. Precision is what this guard
 * needs: a false positive reds the fleet, a false negative only restores the status quo
 * before the guard existed.
 */
export function findDepsLiteralsInSource(sourceText, fileName = 'f.ts') {
  const sf = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const sites = [];
  /** varName -> {callee,argIndex} | AMBIGUOUS(null), from `f(d)` uses in this file. */
  const varUses = new Map();
  function collectVarUses(node) {
    if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && node.arguments) {
      const callee = calleeName(node.expression);
      if (callee) {
        node.arguments.forEach((a, argIndex) => {
          if (!ts.isIdentifier(a)) return;
          const prev = varUses.get(a.text);
          const here = { callee, argIndex };
          if (prev === undefined) varUses.set(a.text, here);
          else if (prev === null || prev.callee !== callee || prev.argIndex !== argIndex)
            varUses.set(a.text, null); // used two different ways — not a reliable anchor
        });
      }
    }
    ts.forEachChild(node, collectVarUses);
  }
  collectVarUses(sf);

  function visit(node) {
    if (ts.isObjectLiteralExpression(node)) {
      const names = objectLiteralPropertyNames(node);
      if (names && names.size >= 2) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        let anchor = literalAnchor(node);
        if (anchor && anchor.varName !== undefined) anchor = varUses.get(anchor.varName) ?? null;
        if (anchor) sites.push({ file: fileName, line: line + 1, names, anchor });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return sites;
}

/**
 * Index every function name -> the interface name declared at each parameter position.
 * A name declared more than once with DIFFERENT types at a position is recorded as
 * ambiguous (null): resolving it to an arbitrary one of them is exactly the guessing
 * WI-1745363 removed.
 *
 * Returns Map<`${calleeName}#${argIndex}`, string|null>.
 */
export function buildCalleeParamTypeIndex(sources) {
  /** key -> { type:string|null, ambiguous:boolean } */
  const acc = new Map();
  for (const { fileName, text } of sources) {
    for (const { name, params } of findCalleeParamTypesInSource(text, fileName)) {
      params.forEach((type, i) => {
        if (!type) return;
        const key = `${name}#${i}`;
        const prev = acc.get(key);
        if (prev === undefined) acc.set(key, { type, ambiguous: false });
        else if (prev.type !== type) acc.set(key, { type: null, ambiguous: true });
      });
    }
  }
  const out = new Map();
  for (const [k, v] of acc) out.set(k, v.ambiguous ? null : v.type);
  return out;
}

/**
 * Resolve the deps interface a literal actually constructs, from its ANCHOR — the
 * consumer named in the syntax — never from its shape.
 *
 * `interfacesByName` maps an interface name to its descriptor, or to null when two
 * files export that name (ambiguous: attributing to either would be a guess).
 */
export function resolveLiteralInterface(site, interfacesByName, calleeParamTypes) {
  const a = site.anchor;
  if (!a) return null;
  const name = a.typeName ?? (a.callee !== undefined ? calleeParamTypes.get(`${a.callee}#${a.argIndex}`) : null);
  if (!name) return null;
  return interfacesByName.get(name) ?? null;
}

/**
 * THE DETECTOR. `sources` is [{ fileName, text }] — every production file to consider.
 * Returns [{ interface, declaredIn, file, line, missing:string[], wiredElsewhereAt }]:
 * one finding per construction site that omits a seam another site wires.
 */
export function findWiringParityGaps(sources, opts = {}) {
  const seamConsumption = buildSeamConsumptionIndex(sources);
  const interfaces = [];
  for (const { fileName, text } of sources) {
    for (const iface of findDepsInterfacesInSource(text, fileName, { ...opts, seamConsumption })) interfaces.push(iface);
  }
  if (interfaces.length === 0) return [];

  /** name -> descriptor, or null when the name is exported from two files (ambiguous). */
  const interfacesByName = new Map();
  for (const iface of interfaces) {
    if (interfacesByName.has(iface.name)) {
      const prev = interfacesByName.get(iface.name);
      if (!prev || prev.file !== iface.file) interfacesByName.set(iface.name, null);
    } else interfacesByName.set(iface.name, iface);
  }
  const calleeParamTypes = buildCalleeParamTypeIndex(sources);

  /** interfaceName -> [{ file, line, names }] */
  const sitesByInterface = new Map();
  for (const { fileName, text } of sources) {
    for (const site of findDepsLiteralsInSource(text, fileName)) {
      const iface = resolveLiteralInterface(site, interfacesByName, calleeParamTypes);
      if (!iface) continue;
      // A literal wiring no optional seam at all is an option-bag, not a deps object.
      let wiresASeam = false;
      for (const n of site.names) if (iface.injectableSeams.has(n)) wiresASeam = true;
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
/**
 * The seeding reason string: RECORDED, NOT ADJUDICATED — a row nobody has yet judged as
 * either a deliberate asymmetry or a latent instance of the Scout defect. Saying so
 * plainly is the point: a baseline row that claims a judgement nobody made is worse than
 * one that admits it.
 *
 * ✅ As of 2026-08-31 NO ROW CARRIES THIS — all 22 baselined rows were adjudicated and now
 * cite a named reason constant with file:line evidence. It is deliberately retained (and
 * therefore currently unreferenced) because the correct response to a re-attribution
 * change is a fresh measured re-seed, not hand-editing rows: the WI-1745363 fix rewrote
 * every finding key and invalidated the whole previous baseline at once. When that happens
 * again, seed the new rows with this and adjudicate them down.
 *
 * When you touch one of these lanes, adjudicate ITS row: either fix the divergence (the
 * row then goes STALE and the guard tells you to prune it) or replace the string with the
 * actual reason that asymmetry is correct.
 */
const NOT_ADJUDICATED = 'pre-existing at guard wiring (WI-1728261) — recorded, not adjudicated';
void NOT_ADJUDICATED; // retained for the next re-seed; see above.

/**
 * WI-1745363 — `LockAuthorityDeps.fetchPresenceRows` and `.fetchHivePresenceRows` are a
 * MUTUALLY-EXCLUSIVE scope-variant pair, not two halves of one concern. `lockAuthorityFor`
 * / `routeToAuthority` read only the harness half (lock-authority.ts:582); `lockAuthorityForHive`
 * / `routeToAuthorityForHive` read only the hive half (:655); neither function falls back to
 * the other. Each site below injects exactly the half the entry point it calls will read, so
 * the "missing" one is unreachable there. Only `routeFileLockOp` (file-lock-routing.ts:128)
 * picks scope at RUNTIME and would need both — and all four of its production callers
 * (locks/{acquire,release,release-all-owned,file-lock-authority-wiring}.ts) inject NEITHER,
 * taking the real defaults. Correct as written; do not "fix" by adding the other half.
 */
const SCOPE_VARIANT_PAIR =
  'WI-1745363 adjudicated: harness-vs-hive scope-variant pair; this site injects the half its entry point reads';

/**
 * WI-1745363 — a LOAD-TEST harness and the production sidecar legitimately carry different
 * concerns. `load-test.ts:56` drives a synthetic gateway on port 0 and has no local backends
 * to resolve; `sidecar-main.ts:147` is the real entry point and uses the default logger
 * rather than the harness's console tap. Both are `startGatewayService` callers, correctly
 * attributed — this is a deliberate asymmetry, not a skipped concern.
 */
const HARNESS_VS_PRODUCTION =
  'WI-1745363 adjudicated: load-test harness vs production sidecar — deliberate, concern is inapplicable at the other site';

/**
 * WI-1745363 — all five seams have REAL production defaults (host-recycle.ts:168-177:
 * `exit ?? process.exit`, `closeSubstrate ?? closeAllBootedHarnesses`, `isSaturated ??
 * isLoopElevated`, `dropReplicationTracking ?? dropAllReplicationLivenessTracking`,
 * `killSelf ?? process.kill`), so the hono-host callers omitting them get the production
 * behaviour, not a skipped concern.
 *
 * ⚠ AND the site they are "diverging" from (host-recycle.ts:348) is a PASS-THROUGH
 * FORWARDER inside the declaring module — `exit: opts.exit, closeSubstrate:
 * opts.closeSubstrate, …` — which forwards whatever ITS caller supplied, including
 * `undefined`. A forwarder therefore inflates the union of "seams someone wires" without
 * being evidence that any other caller must wire them. That is a known residual
 * imprecision in this detector, recorded here rather than papered over.
 */
const DEFAULTED_PLUS_FORWARDER =
  'WI-1745363 adjudicated: every seam has a real production default; the "wiring" site is a pass-through forwarder of possibly-undefined opts';

/**
 * WI-1745363 — `ConsultVerbDeps` binds VERB-SPECIFIC capabilities, and each verb binds
 * only the seams its own outcome path can reach. `close` binds `mintGraduationWorkItem` +
 * `settleConversation` (both close-time: graduating an unanswered consult into a work
 * item, and settling the conversation as the consult closes). `decline` / `reply` bind
 * `reach` + `revive` (route the question onward to another responder) — they never close
 * the consult, so the close-time seams are unreachable there, and vice versa.
 *
 * Decisive evidence that this is not the silent-skip shape: an absent
 * `mintGraduationWorkItem` fails LOUD — consult-verbs-core.ts:714 returns
 * `{ error: 'graduate_unavailable', hint: … }` rather than quietly skipping.
 */
const VERB_SPECIFIC_BINDING =
  'WI-1745363 adjudicated: verb-specific capability binding; the unbound seams are unreachable on this verb (and an absent mintGraduationWorkItem fails loud)';

/**
 * `EngineCtx.progress` is a PROGRESS NOTIFIER, not a capability gate. The
 * consumption index classifies its three `ctx.progress?.(pct, msg)` uses in the
 * docs-engine SEARCH function (search.ts:179, :192, :198) as discarded optional
 * calls. The four docs `get` / `outline` construction sites never consume it;
 * their omission therefore has the observer meaning ("this caller does not
 * watch"), never the gate meaning ("this path skips the concern").
 *
 * Those four rows were historical baseline entries for the former name-based
 * classifier. The consumption-based classifier now excludes them, so they are
 * intentionally absent from FAIL_BASELINE rather than retained as stale
 * suppressions.
 */

/**
 * An `*Override` / injectable-clock seam whose absence selects a REAL production
 * implementation, not a skipped concern:
 *   - `BootHarnessOpts.verifyBindingOverride` → boot.ts:1866
 *     `opts.verifyBindingOverride ?? buildVerifyBindingAdapter()`, and :1864 says outright
 *     "verifyBindingOverride in tests; real adapter in [production]". Its only wiring sites
 *     are a test rig (composition-rig.ts:1228/:1250) and a perf child (peer-child.ts:306).
 *   - `PgRetryOpts.sleep` → pg-transient-retry.ts:89 `opts.sleep ?? defaultSleep`.
 * Injecting it is what a harness does; omitting it is what production does.
 */
const OVERRIDE_WITH_REAL_DEFAULT =
  'benign: override/clock seam with a real production default (boot.ts:1866 `?? buildVerifyBindingAdapter()`; ' +
  'pg-transient-retry.ts:89 `?? defaultSleep`). Wiring it is the TEST path, omitting it the production one.';

/**
 * The two `GetInProcessStatusOpts` callers inject COMPLEMENTARY halves, each supplying only
 * what its own call shape can actually measure — and every unsupplied half degrades to an
 * honest UNKNOWN rather than a fabricated healthy value:
 *   - build-federation-status.ts is async, so it PREFETCHES sidecar liveness and DHT probe
 *     staleness and hands them to the sync resolvers as closures (:203, :206; its comments
 *     at :147 and :161 state exactly this). It supplies no claim stats.
 *   - dogfood_substrate_status.ts supplies claim stats and remote booted handles
 *     (:180-:223) but performs no such prefetch.
 * Defaults are tri-state-safe: in-process-status.ts:304-305 default both liveness seams to
 * `() => null` (UNKNOWN, never a fabricated `true`), and `resolveClaimStats` defaults to
 * ZERO_STATS (:302) which CANNOT read as a healthy 0% error rate, because health.ts:216
 * gates the rate on `inputs.claimStats.total > 0`. That guard is the specific reason this
 * row is benign rather than an instance of this file's documented "emptiness reads as
 * health" class (EI-20575137548097507, EI-18735338283879820).
 */
const STATUS_MEASURABLE_HALF =
  'benign: complementary halves — each caller injects what its call shape can measure; unsupplied seams degrade to ' +
  'UNKNOWN (in-process-status.ts:304-305 `?? (() => null)`), and ZERO_STATS cannot read as healthy because ' +
  'health.ts:216 gates the error rate on `total > 0`.';

/**
 * `GovernedOperationInput.measureActualDemand` is a governor FEEDBACK sample, read once at
 * execution.ts:166 as `input.measureActualDemand ? await input.measureActualDemand() : undefined`
 * and forwarded at :242. Absent, the operation simply contributes no actual-vs-estimated
 * demand observation to the governor. Correctness of the operation is unaffected; the cost
 * is that this lane's demand estimates are never corrected by measurement.
 */
const GOVERNOR_DEMAND_TELEMETRY =
  'benign for correctness: governor feedback sample (execution.ts:166). Absent = this operation contributes no ' +
  'actual-demand observation; the op still runs identically. Observability gap, not a skipped gate.';

/**
 * ⚠ HIGHEST-SIGNAL ROW IN THIS BASELINE — adjudicated benign only because a REAL bug on this
 * exact seam was already found and repaired. EI-18771324701216281 (major): the federation
 * demux-drop counter was unreachable on JOINERS — the very population the demux bug afflicts
 * — because `withHiveHomeApplyGuard` was installed ONLY when `opts.resolveHomeLogKeyHex` was
 * threaded, and boot.ts threads it only when a home rebind engaged. Its emptiness then read
 * as health.
 *
 * VERIFIED REPAIRED in current code, not taken on the work-item's word: register-all.ts
 * installs the guard unconditionally and reads the resolver as `guard.resolveHomeLogKeyHex?.()
 * ?? null` (:315, :349). The demux-mismatch counter now bumps on `slug !== guard.boundSlug`
 * alone (:333-:345), independent of the resolver, so it is reachable on a joiner that threads
 * nothing. With no home log, only the `home-log-excluded` branch is skipped — which is
 * semantically correct, since there is no home log to exclude against.
 *
 * `resolveAuthorDevice` is enrichment: feature-working-set.ts:172
 * `opts.resolveAuthorDevice?.(provenance.authorPubkey) ?? null` — absent yields "unknown
 * device", never a wrong attribution.
 *
 * Do NOT re-derive this from scratch; if the guard installation at register-all.ts:314 ever
 * becomes conditional on the resolver again, this row is a live major bug, not a baseline entry.
 */
const HIVE_HOME_GUARD_REPAIRED =
  'benign POST-FIX: this seam produced EI-18771324701216281 (major, joiner demux counter unreachable). Verified ' +
  'repaired — register-all.ts installs the guard unconditionally, `?.() ?? null` at :315/:349, and the ' +
  'demux-mismatch counter bumps on slug mismatch alone (:333-345). resolveAuthorDevice is `?? null` enrichment.';

/**
 * Two `wireCrossHiveBoundary` sites in ONE e2e frame file, selected by the frame's ROLE:
 * hive-A (:131) sends an ask, so it must carry the outbound grant the B-05 egress
 * default-deny requires, and injects `loadOutboundGrants` (:136). hive-B (:119) only
 * RECEIVES, so it has no outbound grants to declare. Same entry-point-selected variant
 * shape as SCOPE_VARIANT_PAIR above: the "missing" seam is unreachable on B's path, since
 * cross-hive-wiring.ts:455 calls `loadOutboundGrants()` only on the outbound send leg.
 */
const XHIVE_ROLE_ASYMMETRY =
  'benign: role-asymmetric pair in one e2e frame — hive-A (:131) sends and carries the outbound grant (:136); ' +
  'hive-B (:119) only receives, and cross-hive-wiring.ts:455 reads the seam only on the send leg.';

/**
 * 2026-09-05 (gate red on frozen candidate 50ed2739, adjudicated by the LIVE_GATE_OPS holder) —
 * `GuardSpec` / `ExclusiveWaitParams` carry two seam FAMILIES that are mutually exclusive BY
 * THE INTERFACE'S OWN CONTRACT (resource-lock-guard.ts `GuardSpec` doc comments):
 *   - `onTick` is the DRAIN-WAIT progress callback (EI-18769559897594065): it fires only while
 *     `maxDrainSec > 0` is draining shared holders, and its purpose is to reset an MCP client's
 *     idle clock via `ctx.progress`. deploy-cli is a CLI with no `ctx.progress`, and its
 *     'release-deploy' guard is `maxDrainSec: 0` (never drains), so the seam has nothing to
 *     fire into at deploy-deps.ts.
 *   - `hostLocalOwnerPid` + `onStaleHolderReclaimed` are the HOST-LOCAL PID self-heal
 *     (EI-18674647773291145): the extractor parses a pid out of the HOLDER's owner string and
 *     applies only to deploy-cli's `release-deploy:<pid>:<uuid>` identity shape. db:migrate,
 *     dev:restart and locks:acquire run under agent/session identities that carry no pid, and
 *     the extractor itself lives in apps/operator (deploy-deps.ts) — unreachable from
 *     operator-core without inverting the dependency direction. The session half of the
 *     dead-holder test (`deadOwnerOracle`) IS wired where it applies (acquire_resource.ts).
 * Wiring the other family at each site would be a silent no-op, not a recovered concern.
 */
const WAIT_MODE_SPECIFIC_SEAM =
  'adjudicated 2026-09-05: GuardSpec/ExclusiveWaitParams seam family is inapplicable at this site by contract — ' +
  'onTick fires only during a maxDrainSec>0 drain into ctx.progress (deploy-cli has neither); hostLocalOwnerPid/' +
  'onStaleHolderReclaimed parse a pid only out of deploy-cli\'s release-deploy:<pid>:<uuid> identity (apps/operator), ' +
  'which agent/session owners at migrate/restart/locks:acquire never carry.';

/**
 * 2026-09-05 — the rubric live DRILL (`scout/rubric-live-drill.ts`) deliberately omits
 * `onScoutDraftCreated`: in production (`register-scout-action.ts:442`) that hook pings the
 * Mug about a NEWLY routed draft to start the review feedback loop; a drill's drafts are
 * synthetic (`origin: 'drill'`, `noveltyCorpus: async () => []`) and must never be announced
 * as real work. Same harness-vs-production shape as `HARNESS_VS_PRODUCTION` above.
 */
const DRILL_VS_PRODUCTION =
  'adjudicated 2026-09-05: rubric live drill vs production Scout action — the Mug draft-routed ping is ' +
  'deliberately not wired for synthetic drill drafts';

const FAIL_BASELINE = new Map([
  // Historical seed from the measured `--list` run after the WI-1745363 attribution fix:
  // 28 findings / 22 distinct rows over 7,150 files (was 44 / 33 under shape-based
  // attribution). The 11 rows that disappeared were NOT fixed divergences — they were
  // misattributed literals that are no longer in the population at all. Four additional
  // EngineCtx.progress rows became stale when observer classification became
  // consumption-based and are intentionally omitted below.
  ['BootHarnessOpts|packages/operator-core/lib/sync/hyperbee/perf/scenarios/merge-cost.ts|verifyBindingOverride', OVERRIDE_WITH_REAL_DEFAULT],
  ['ConsultVerbDeps|packages/operator-core/lib/agent-tools/consult/close.ts|reach,revive', VERB_SPECIFIC_BINDING],
  ['ConsultVerbDeps|packages/operator-core/lib/agent-tools/consult/decline.ts|mintGraduationWorkItem,settleConversation', VERB_SPECIFIC_BINDING],
  ['ConsultVerbDeps|packages/operator-core/lib/agent-tools/consult/reply.ts|mintGraduationWorkItem,settleConversation', VERB_SPECIFIC_BINDING],
  ['GatewayServiceOptions|packages/operator-core/lib/inference-gateway/load-test.ts|resolveLocalBackends', HARNESS_VS_PRODUCTION],
  ['GatewayServiceOptions|packages/operator-core/lib/inference-gateway/sidecar-main.ts|log', HARNESS_VS_PRODUCTION],
  ['GetInProcessStatusOpts|packages/operator-core/lib/agent-tools/dev/dogfood_substrate_status.ts|resolveDhtBootstrapProbeStaleMs,resolveSidecarLive', STATUS_MEASURABLE_HALF],
  ['GetInProcessStatusOpts|packages/operator-core/lib/endpoint-route/routes/discovery/build-federation-status.ts|resolveClaimStats,resolveRemoteBootedHandles', STATUS_MEASURABLE_HALF],
  ['GovernedOperationInput|packages/operator-core/lib/agent-tools/testing/run.ts|measureActualDemand', GOVERNOR_DEMAND_TELEMETRY],
  ['GracefulRecycleOpts|apps/operator/bin/hono-host.ts|closeSubstrate,dropReplicationTracking,exit,isSaturated,killSelf', DEFAULTED_PLUS_FORWARDER],
  ['LockAuthorityDeps|packages/operator-core/lib/deployment/p2p-perf-tier3/claim-agent.ts|fetchPresenceRows', SCOPE_VARIANT_PAIR],
  ['LockAuthorityDeps|packages/operator-core/lib/deployment/p2p-perf-tier3/eviction-agent.ts|fetchHivePresenceRows', SCOPE_VARIANT_PAIR],
  ['LockAuthorityDeps|packages/operator-core/lib/deployment/p2p-perf-tier3/loop-agent.ts|fetchPresenceRows', SCOPE_VARIANT_PAIR],
  ['LockAuthorityDeps|packages/operator-core/lib/shared-pot/suite/checks.ts|fetchPresenceRows', SCOPE_VARIANT_PAIR],
  ['PgRetryOpts|packages/operator-core/lib/pot/soak-report.ts|sleep', OVERRIDE_WITH_REAL_DEFAULT],
  ['RegisterAllOpts|packages/operator-core/lib/sync/hyperbee/boot.ts|resolveAuthorDevice', HIVE_HOME_GUARD_REPAIRED],
  ['RegisterAllOpts|packages/operator-core/lib/sync/hyperbee/boot.ts|resolveAuthorDevice,resolveHomeLogKeyHex', HIVE_HOME_GUARD_REPAIRED],
  ['WireCrossHiveBoundaryDeps|packages/operator-core/lib/deployment/cross-hive-frame.ts|loadOutboundGrants', XHIVE_ROLE_ASYMMETRY],
  // 2026-09-05 — seeded from `--list` after the seams landed on tip (frozen candidate 50ed2739
  // gate red); each row adjudicated in the constant it cites, not recorded-and-deferred.
  ['BuildScoutCycleDepsOptions|packages/operator-core/lib/scout/register-scout-action.ts|noveltyCorpus', OVERRIDE_WITH_REAL_DEFAULT],
  ['BuildScoutCycleDepsOptions|packages/operator-core/lib/scout/rubric-live-drill.ts|onScoutDraftCreated', DRILL_VS_PRODUCTION],
  ['DesktopAuditDeps|packages/operator-core/lib/workspace-host/hosted-workspace-host-runtime.ts|now', OVERRIDE_WITH_REAL_DEFAULT],
  ['ExclusiveWaitParams|packages/operator-core/lib/agent-tools/locks/acquire_resource.ts|hostLocalOwnerPid', WAIT_MODE_SPECIFIC_SEAM],
  ['GuardSpec|apps/operator/lib/release/deploy-deps.ts|onTick', WAIT_MODE_SPECIFIC_SEAM],
  ['GuardSpec|packages/operator-core/lib/agent-tools/db/migrate.ts|hostLocalOwnerPid,onStaleHolderReclaimed', WAIT_MODE_SPECIFIC_SEAM],
  ['GuardSpec|packages/operator-core/lib/agent-tools/dev/restart.ts|hostLocalOwnerPid,onStaleHolderReclaimed', WAIT_MODE_SPECIFIC_SEAM],
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
    //
    // DEDUPED on the baseline key, because the key is line-independent by design: two
    // sites in one file omitting the same seams collapse to one row, which is exactly
    // what the Map that consumes these rows does. Emitting the duplicate would produce
    // a baseline whose row count never matches the finding count, and re-seeding from
    // it would look like it had silently lost rows.
    const seen = new Set();
    let rows = 0;
    for (const f of allFindings) {
      const k = findingKey(f);
      if (seen.has(k)) continue;
      seen.add(k);
      rows += 1;
      console.log(`  ['${k}', 'REASON HERE'],`);
    }
    console.log(
      `\ncheck-deps-wiring-parity: ${allFindings.length} finding(s) over ${sources.length} files ` +
        `(${rows} distinct baseline row(s)).`,
    );
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
    if (opts.includeObservers) {
      // ⚠ DO NOT report these as prunable. `--include-observers` widens the seam set,
      // which changes each finding's `missing` list — and the baseline key is built
      // FROM that list, so every baselined row stops matching and looks stale. Telling
      // the reader to prune here would destroy a valid baseline on the strength of a
      // diagnostic run. Staleness is only meaningful against the default population.
      console.log(
        `\nⓘ ${staleBaseline.length} baseline row(s) did not match under --include-observers. ` +
          'That is EXPECTED — widening the population rewrites finding keys. Staleness is ' +
          'only meaningful in the default mode; do NOT prune the baseline from this run.',
      );
    } else {
      console.log(
        `\n⚠ ${staleBaseline.length} STALE baseline row(s) — the divergence no longer exists; prune from FAIL_BASELINE:\n` +
          staleBaseline.map((k) => `    ${k}`).join('\n'),
      );
    }
  }

  if (opts.fail && newFindings.length > 0) process.exit(1);
  process.exit(0);
}

if (isCliEntry(import.meta.url)) {
  main();
}
