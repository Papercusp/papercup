#!/usr/bin/env node
/**
 * check-reachable-advisories.mjs — the going-forward gate for production dependency
 * advisories (plan security-boundary-remediation-and-usability-2026-09-04, P-007;
 * spec SEC-P007-deps-keys-recovery: "an invalid dependency ... state is refused
 * before it becomes active").
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT `npm audit`
 * ---------------------------------------------
 * A bare `npm audit --omit=dev` over this monorepo reports the union of every
 * workspace's production deps — including workspaces that never ship in the Tauri
 * desktop product (the Astro docs sites, the testing shell, the test-config package).
 * Measured 2026-09-05: 99 advisories, of which 26 entered through @papercusp/testing-shell,
 * 11 through @papercupai/operator-docs and 7 through @papercusp/test-config. Reporting
 * that 99 as "production advisories" overstates the shipped attack surface by roughly
 * half, and — worse — buries the handful that genuinely ship.
 *
 * P-007 asks for *reachable* production advisories. So this gate does what audit cannot:
 * it attributes every advisory to the top-level workspace(s) that actually pull it in,
 * classifies those workspaces as shipping vs non-shipping, and gates only on the
 * shipping set.
 *
 * FAIL-CLOSED
 * -----------
 * An advisory the walker cannot attribute to any workspace is treated as SHIPPING, not
 * skipped. npm dedupes/hoists, so an unattributed package is a measurement gap, and a
 * measurement gap must never read as "safe" (repo doctrine: an empty result from a
 * bounded instrument is not a negative finding). These are reported under
 * `unattributed` so the gap stays visible instead of silently passing.
 *
 *   node scripts/check-reachable-advisories.mjs             # report (informational)
 *   node scripts/check-reachable-advisories.mjs --strict    # exit 1 on un-baselined shipping high/critical
 *   node scripts/check-reachable-advisories.mjs --list      # print the measured population (re-seeds the baseline)
 *   node scripts/check-reachable-advisories.mjs --json      # machine-readable
 *   node scripts/check-reachable-advisories.mjs --self-test # prove the analyzer is falsifiable
 *
 * The baseline (scripts/reachable-advisories-baseline.json) is SHRINK-ONLY, exactly like
 * KNOWN_DARK_FLAGS: fixing an advisory removes its entry; a NEW shipping high/critical
 * advisory fails the gate rather than being quietly appended. Re-seed it only from a real
 * `--list` run, never from a hand-run grep.
 *
 * The audit/ls inputs are overridable (`--audit-json`, `--ls-json`) so the analyzer can be
 * exercised on fixtures without mutating the shared tree — see
 * packages/operator-core/lib/reachable-advisories-guard.test.ts.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_PATH = join(ROOT, 'scripts', 'reachable-advisories-baseline.json');

/** Severities that GATE. Moderate/low are reported but do not fail. */
const GATING_SEVERITIES = new Set(['high', 'critical']);

/**
 * Workspaces that do NOT ship in the desktop product. An advisory reachable ONLY through
 * these is real debt but not shipped attack surface, so it is reported and not gated.
 * Each entry states WHY it does not ship — this is the judgment the derivation cannot make.
 */
const NON_SHIPPING_WORKSPACES = new Map([
  ['@papercupai/operator-docs', 'Astro docs site; built to static HTML, never bundled into the desktop app'],
  ['@papercupai/papercusp-docs', 'Astro docs site; static output only'],
  ['@papercusp/docs-engine', 'docs build tooling; not part of the operator sidecar or host bundle'],
  ['@papercusp/testing-shell', 'test harness package; dev/test only'],
  ['@papercusp/test-config', 'shared vitest/test configuration; dev/test only'],
]);

export function isNonShipping(workspace) {
  return NON_SHIPPING_WORKSPACES.has(workspace);
}

/**
 * Attribute each advisory package to the top-level workspace(s) whose production
 * dependency subtree reaches it.
 *
 * `npm ls --omit=dev --all --json` nests workspaces as direct children of the root, each
 * carrying `resolved: "file:..."`. Everything below a workspace is attributed to it; a
 * nested workspace re-roots attribution to itself.
 */
export function attributeAdvisories(lsTree, advisoryNames) {
  const advisory = advisoryNames instanceof Set ? advisoryNames : new Set(advisoryNames);
  const reach = new Map(); // pkg -> Set(workspace)
  const seen = new Set();

  const walk = (node, owner, depth) => {
    if (!node || depth > 64) return;
    for (const [name, child] of Object.entries(node.dependencies || {})) {
      if (!child || typeof child !== 'object') continue;
      const isWorkspace = typeof child.resolved === 'string' && child.resolved.startsWith('file:');
      const nextOwner = isWorkspace ? name : owner;
      if (advisory.has(name) && nextOwner) {
        if (!reach.has(name)) reach.set(name, new Set());
        reach.get(name).add(nextOwner);
      }
      // Guard against pathological cycles while still allowing the same package to be
      // revisited under a DIFFERENT workspace owner (that is the attribution we want).
      // '::' is a safe delimiter: npm names cannot contain a colon.
      const key = `${nextOwner ?? '~root'}::${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      walk(child, nextOwner, depth + 1);
    }
  };
  walk(lsTree, null, 0);
  return reach;
}

/** Severity ordering, for fail-closed reconciliation between the two audit lenses. */
const SEVERITY_RANK = { unknown: 0, info: 1, low: 2, moderate: 3, high: 4, critical: 5 };
const worseSeverity = (a, b) => ((SEVERITY_RANK[b] ?? 0) > (SEVERITY_RANK[a] ?? 0) ? b : a);

/**
 * Core analysis. Pure: takes parsed audit + ls JSON, returns the classified population.
 *
 * `fullAuditJson` is the OPTIONAL second lens — `npm audit --json` over the tree as it is
 * actually installed (dev deps included). It exists because the two lenses disagree, and
 * the prod-only one is OPTIMISTIC about fixes:
 *
 *   style-dictionary, measured 2026-09-05 — installed 4.4.0, root declares "^4.4.0":
 *     npm audit --omit=dev  ->  fixAvailable: true          ("patch-compatible")
 *     npm audit             ->  fixAvailable: 5.5.2, isSemVerMajor: true
 *
 *   4.4.0 -> 5.5.2 is unambiguously major and "^4.4.0" cannot reach it, so the prod-only
 *   lens is simply WRONG here. It answers "what would fix this if the tree had no dev
 *   deps" — a tree we never install. (Note --omit=dev is not even a subset: it reported
 *   99 advisories against the full tree's 91.)
 *
 * So reachability/shipping is judged on the prod graph (the correct lens for what ships),
 * while FIX FEASIBILITY is judged against the tree we really install, and any disagreement
 * resolves to the PESSIMISTIC reading — the same fail-closed doctrine as unattributed
 * advisories above. A guard that under-reports a major upgrade as "patch-compatible" sends
 * you to attempt a fix that cannot work.
 */
export function analyze(auditJson, lsJson, baseline, fullAuditJson) {
  const vulns = auditJson?.vulnerabilities || {};
  const names = Object.keys(vulns);
  const reach = attributeAdvisories(lsJson || {}, names);
  const fullVulns = fullAuditJson?.vulnerabilities || null;

  const findings = [];
  for (const name of names) {
    const v = vulns[name] || {};
    const owners = [...(reach.get(name) || [])].sort();
    const attributed = owners.length > 0;
    // Fail closed: an unattributed advisory counts as shipping.
    const shippingOwners = owners.filter((w) => !isNonShipping(w));
    const shipping = !attributed || shippingOwners.length > 0;

    // Reconcile the two lenses pessimistically. `full` is absent when the second audit
    // was not supplied, or when that lens does not see this package at all.
    const full = fullVulns ? fullVulns[name] : undefined;
    const severity = full
      ? worseSeverity(String(v.severity || 'unknown'), String(full.severity || 'unknown'))
      : String(v.severity || 'unknown');

    const fa = v.fixAvailable;
    const faFull = full ? full.fixAvailable : undefined;
    // A fix is only "patch-compatible" if EVERY lens that can see it agrees.
    const majorOf = (x) => x && typeof x === 'object' && x.isSemVerMajor === true;
    const authoritative = majorOf(faFull) ? faFull : majorOf(fa) ? fa : (faFull ?? fa);
    const fix =
      authoritative === true
        ? 'patch-compatible'
        : authoritative && typeof authoritative === 'object'
          ? `${authoritative.name}@${authoritative.version}${authoritative.isSemVerMajor ? ' [SEMVER-MAJOR]' : ''}`
          : 'none';
    const patchCompatible = authoritative === true;
    // Visible when the prod-only lens claimed a compatible fix the real tree contradicts.
    const fixDisagreement = fa === true && majorOf(faFull) ? `--omit=dev said patch-compatible; installed tree requires ${faFull.name}@${faFull.version} (MAJOR)` : null;

    findings.push({
      name,
      severity,
      owners,
      attributed,
      shipping,
      shippingOwners,
      gating: shipping && GATING_SEVERITIES.has(severity),
      fix,
      patchCompatible,
      ...(fixDisagreement ? { fixDisagreement } : {}),
    });
  }

  const accepted = new Set(baseline?.accepted || []);
  const gating = findings.filter((f) => f.gating);
  const offenders = gating.filter((f) => !accepted.has(f.name));
  // Shrink-only bookkeeping: a baseline entry that no longer gates is now fixed.
  const stale = [...accepted].filter((n) => !gating.some((f) => f.name === n));

  return {
    total: findings.length,
    findings,
    gating,
    offenders,
    stale,
    unattributed: findings.filter((f) => !f.attributed).map((f) => f.name),
    nonShippingOnly: findings.filter((f) => f.attributed && !f.shipping).length,
  };
}

function loadBaseline() {
  if (!existsSync(BASELINE_PATH)) return { accepted: [], note: 'no baseline file' };
  try {
    return JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  } catch (err) {
    throw new Error(`baseline at ${BASELINE_PATH} is unreadable: ${err.message}`);
  }
}

function runJson(args, label) {
  // npm exits non-zero when advisories/extraneous deps exist; that is expected, so we
  // read stdout regardless and fail only when the payload is unparseable.
  let out;
  try {
    out = execFileSync('npm', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  } catch (err) {
    out = err.stdout;
  }
  if (!out || !out.trim()) throw new Error(`${label} produced no output — cannot measure`);
  try {
    return JSON.parse(out);
  } catch (err) {
    throw new Error(`${label} output was not JSON (${err.message})`);
  }
}

// ── self-test: prove the analyzer discriminates, on inline fixtures ──────────────
// A guard that has never failed is a guard nobody has tested. These controls stay in the
// file permanently and mutate nothing on disk.
function selfTest() {
  const results = [];
  const check = (label, cond) => {
    results.push({ label, pass: !!cond });
  };

  const ls = {
    dependencies: {
      '@papercusp/web': {
        resolved: 'file:apps/web',
        dependencies: { 'evil-shipped': { version: '1.0.0' } },
      },
      '@papercusp/testing-shell': {
        resolved: 'file:libs/testing-shell',
        dependencies: { 'evil-testonly': { version: '1.0.0' } },
      },
    },
  };
  const audit = {
    vulnerabilities: {
      'evil-shipped': { severity: 'high', fixAvailable: true },
      'evil-testonly': { severity: 'high', fixAvailable: true },
      'evil-orphan': { severity: 'critical', fixAvailable: false },
      'noisy-moderate': { severity: 'moderate', fixAvailable: true },
    },
  };

  const r = analyze(audit, ls, { accepted: [] });
  const byName = Object.fromEntries(r.findings.map((f) => [f.name, f]));

  // POSITIVE control — a shipping high advisory must be caught.
  check('catches a shipping high advisory', r.offenders.some((o) => o.name === 'evil-shipped'));
  check('attributes it to its workspace', byName['evil-shipped'].owners.includes('@papercusp/web'));

  // NEGATIVE control — a non-shipping one must NOT gate (else the gate is noise).
  check('does not gate a non-shipping advisory', !r.offenders.some((o) => o.name === 'evil-testonly'));
  check('still records the non-shipping one', byName['evil-testonly'].attributed === true);

  // FAIL-CLOSED control — an unattributable advisory must gate, not vanish.
  check('fails closed on an unattributed advisory', r.offenders.some((o) => o.name === 'evil-orphan'));
  check('reports the measurement gap', r.unattributed.includes('evil-orphan'));

  // SEVERITY control — moderate must not gate.
  check('does not gate a moderate advisory', !r.offenders.some((o) => o.name === 'noisy-moderate'));

  // BASELINE control — an accepted entry stops gating, and a fixed one is reported stale.
  const r2 = analyze(audit, ls, { accepted: ['evil-shipped', 'evil-orphan', 'already-fixed'] });
  check('baseline suppresses an accepted offender', !r2.offenders.some((o) => o.name === 'evil-shipped'));
  check('reports a stale baseline entry', r2.stale.includes('already-fixed'));

  // TWO-LENS controls — regression guard for the style-dictionary miss (2026-09-05).
  // The prod-only lens called it patch-compatible; the installed tree required a MAJOR
  // bump. Reporting the optimistic reading sends an agent to attempt an impossible fix.
  const fullAudit = {
    vulnerabilities: {
      // Same package, the two lenses disagreeing exactly as npm really did.
      'evil-shipped': {
        severity: 'high',
        fixAvailable: { name: 'evil-shipped', version: '5.5.2', isSemVerMajor: true },
      },
      // Severity understated by the prod-only lens.
      'noisy-moderate': { severity: 'critical', fixAvailable: true },
    },
  };
  const r3 = analyze(audit, ls, { accepted: [] }, fullAudit);
  const by3 = Object.fromEntries(r3.findings.map((f) => [f.name, f]));

  check('a major fix in the installed tree overrides a compatible prod-only fix', by3['evil-shipped'].patchCompatible === false);
  check('reports the overriding fix version', by3['evil-shipped'].fix.includes('5.5.2') && by3['evil-shipped'].fix.includes('SEMVER-MAJOR'));
  check('surfaces the lens disagreement', typeof by3['evil-shipped'].fixDisagreement === 'string');
  check('takes the worse severity of the two lenses', by3['noisy-moderate'].severity === 'critical');
  check('worse severity can promote a finding into the gate', r3.offenders.some((o) => o.name === 'noisy-moderate'));
  // A package only the prod-only lens sees keeps its own reading rather than vanishing.
  check('keeps a finding absent from the full-tree lens', by3['evil-orphan'].fix === 'none');
  // CALIBRATION for the two-lens controls — without the second lens these MUST differ,
  // or the controls above would pass no matter what analyze() did.
  check('single-lens reading really is the optimistic one', byName['evil-shipped'].patchCompatible === true && byName['noisy-moderate'].severity === 'moderate');

  // CALIBRATION — the controls above must not all pass vacuously.
  check('analyzer actually produced findings', r.total === 4);

  const failed = results.filter((x) => !x.pass);
  for (const x of results) console.log(`${x.pass ? 'ok  ' : 'FAIL'} ${x.label}`);
  if (failed.length) {
    console.error(`\nself-test FAILED: ${failed.length}/${results.length}`);
    process.exit(1);
  }
  console.log(`\nself-test passed: ${results.length}/${results.length} controls`);
}

function main() {
  const argv = process.argv.slice(2);
  const has = (f) => argv.includes(f);
  const valueOf = (f) => {
    const i = argv.indexOf(f);
    return i >= 0 ? argv[i + 1] : null;
  };

  if (has('--self-test')) return selfTest();

  const auditPath = valueOf('--audit-json');
  const lsPath = valueOf('--ls-json');
  const fullAuditPath = valueOf('--full-audit-json');
  const audit = auditPath
    ? JSON.parse(readFileSync(auditPath, 'utf8'))
    : runJson(['audit', '--omit=dev', '--json'], 'npm audit');
  const ls = lsPath
    ? JSON.parse(readFileSync(lsPath, 'utf8'))
    : runJson(['ls', '--omit=dev', '--all', '--json'], 'npm ls');
  // Second lens: the tree as actually installed. Fix feasibility is judged here (see
  // analyze()). Never fatal — if it cannot be read we fall back to the single-lens
  // reading, which is optimistic about fixes but still gates on the same population.
  let fullAudit = null;
  try {
    fullAudit = fullAuditPath
      ? JSON.parse(readFileSync(fullAuditPath, 'utf8'))
      : runJson(['audit', '--json'], 'npm audit (full tree)');
  } catch {
    fullAudit = null;
  }

  const baseline = loadBaseline();
  const r = analyze(audit, ls, baseline, fullAudit);
  if (!fullAudit) {
    console.warn('warn: full-tree audit unavailable — fix feasibility is the optimistic --omit=dev reading');
  }

  if (has('--json')) {
    console.log(JSON.stringify(r, null, 2));
  } else if (has('--list')) {
    // The re-seed surface: the measured gating population, for the baseline file.
    for (const f of r.gating.sort((a, b) => a.name.localeCompare(b.name))) {
      console.log(`${f.severity.padEnd(9)} ${f.name.padEnd(34)} fix=${f.fix} owners=${f.owners.join(',') || 'UNATTRIBUTED'}`);
    }
    console.log(`\n${r.gating.length} gating (shipping high/critical) of ${r.total} total advisories`);
  } else {
    console.log(`advisories: ${r.total} total`);
    console.log(`  gating (shipping high/critical): ${r.gating.length}`);
    console.log(`  non-shipping only (reported, not gated): ${r.nonShippingOnly}`);
    console.log(`  unattributed (failed closed as shipping): ${r.unattributed.length}`);
    console.log(`  baselined: ${(baseline.accepted || []).length}   NEW offenders: ${r.offenders.length}`);
    if (r.offenders.length) {
      console.log('\nNEW un-baselined shipping high/critical advisories:');
      for (const o of r.offenders) {
        console.log(`  ${o.severity.toUpperCase()} ${o.name} fix=${o.fix} owners=${o.owners.join(',') || 'UNATTRIBUTED'}`);
      }
    }
    if (r.stale.length) {
      console.log(`\nSTALE baseline entries (advisory resolved — remove them, the baseline is shrink-only):`);
      for (const s of r.stale) console.log(`  ${s}`);
    }
  }

  if (has('--strict') && r.offenders.length) {
    console.error(
      `\ncheck-reachable-advisories: ${r.offenders.length} NEW shipping high/critical advisory(ies). ` +
        `Patch it, or — only with a stated reason — add it to ${BASELINE_PATH}.`,
    );
    process.exit(1);
  }
}

// Only run as a CLI; importing for tests must not execute.
if (process.argv[1] && process.argv[1].endsWith('check-reachable-advisories.mjs')) main();
