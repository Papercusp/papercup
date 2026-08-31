/**
 * Guards the guest startup script that `papercusp-image-scan` runs on the scanner VM.
 *
 * Two properties are load-bearing and neither is visible to the adapter tests:
 *
 * 1. SECRET MATERIAL NEVER LEAVES THE VM. The scan reports which RULE matched in which
 *    FILE at which LINE — never the matched value. The result document is read back over
 *    SSH and lands in release logs and work-item evidence, so projecting gitleaks' own
 *    `.Secret` / `.Match` fields would convert a detection into a disclosure. That is a
 *    one-character change away at all times, which is why it is pinned here.
 *
 * 2. EVERY MEASUREMENT STEP FAILS CLOSED. The scanner previously ended its gitleaks call
 *    in `|| true` with `secret_count` defaulting to 0, so a CRASHED secret scanner was
 *    indistinguishable from a clean image and the release's `secretFindings === 0` gate
 *    PASSED (EI-21769463387738098). Any step that can fail must set its own `detail=` and
 *    exit non-zero rather than fall through to a zero count.
 *
 * The scanner bin executes `main()` at module load, and it is resolved through an npm bin
 * SYMLINK at every call site, so an `import.meta.url === argv[1]` guard would disagree with
 * itself there and silently turn the scanner into a no-op — the exact silent-pass class
 * above. Rather than take that risk on a release-critical entrypoint, the test evaluates
 * `startupScript()` out of the source in isolation. `emitGuestScript` self-checks that the
 * extraction actually produced the real script, so a broken extraction fails loudly instead
 * of vacuously passing.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

/**
 * The scanner source under test. Overridable ONLY so falsifiability can be proven against
 * a COPY outside the tree: these guards assert properties of a shared, swept checkout, and
 * mutating that checkout in place to prove a guard can fail risks git-sync committing the
 * mutant mid-probe. With this one line, `PAPERCUSP_IMAGE_SCAN_SOURCE=<copy> vitest ...`
 * proves the guard reds against a pre-fix snapshot without touching the real file.
 */
const SCANNER_SOURCE =
  process.env.PAPERCUSP_IMAGE_SCAN_SOURCE ??
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'papercusp-image-scan.mjs');

/** Evaluate startupScript() out of the scanner source without executing its CLI main(). */
function emitGuestScript(): string {
  const source = readFileSync(SCANNER_SOURCE, 'utf8');
  const lines = source.split('\n');

  const declaration = 'function startupScript()';
  const fnLineIndex = lines.findIndex((line) => line.startsWith(declaration));
  if (fnLineIndex < 0) {
    throw new Error('could not locate startupScript() — extraction is stale, not the subject');
  }

  // The module-scope constants the template interpolates sit above the declaration; the
  // first is CONTRACT_VERSION. Take that span verbatim rather than pattern-matching each
  // one, so a multi-line constant cannot be silently dropped.
  const firstConstIndex = lines.findIndex((line) => line.startsWith('const CONTRACT_VERSION'));
  if (firstConstIndex < 0 || firstConstIndex >= fnLineIndex) {
    throw new Error('could not locate the constant preamble — extraction is stale');
  }
  const preamble = lines.slice(firstConstIndex, fnLineIndex).join('\n');

  const start = source.indexOf(declaration);
  let depth = 0;
  let end = -1;
  for (let index = source.indexOf('{', start); index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) {
        end = index + 1;
        break;
      }
    }
  }
  if (end < 0) throw new Error('could not brace-match startupScript() — extraction is stale');

  // eslint-disable-next-line no-new-func -- deliberate: evaluate one pure template function.
  const emit = new Function(
    `${preamble}\n${source.slice(start, end)}\nreturn startupScript();`,
  ) as () => string;
  const script = emit();

  // Self-check: prove we emitted the REAL script, so none of the assertions below can pass
  // against an empty string produced by a broken extraction.
  if (!script.includes('gitleaks') || !script.includes('syft') || script.length < 1000) {
    throw new Error('extraction produced something that is not the guest script');
  }
  return script;
}

/** Executable lines only — the file deliberately NAMES these fields in a warning comment. */
const executableLines = (script: string): string[] =>
  script.split('\n').filter((line) => !/^\s*#/.test(line));

describe('image scan guest script', () => {
  it('never projects gitleaks secret material into the result document', () => {
    const executable = executableLines(emitGuestScript());
    const offenders = executable.filter((line) => /\.Secret\b|\.Match\b/.test(line));
    expect(offenders).toEqual([]);
  });

  it('the secret-material check is not vacuous', () => {
    // Positive control: a deliberately leaking projection MUST be caught by the same rule.
    const leaking = emitGuestScript().replace(
      '{rule:.RuleID, file:.File, line:.StartLine}',
      '{rule:.RuleID, secret:.Secret}',
    );
    const offenders = executableLines(leaking).filter((line) => /\.Secret\b|\.Match\b/.test(line));
    expect(offenders.length).toBeGreaterThan(0);
  });

  it('reports the rule, file and line for each secret finding', () => {
    const script = emitGuestScript();
    expect(script).toContain('rule:.RuleID');
    expect(script).toContain('file:.File');
    expect(script).toContain('line:.StartLine');
  });

  it('emits severity and fixability breakdowns so a red gate is triageable', () => {
    const script = emitGuestScript();
    // A bare total cannot distinguish thousands of unfixed negligible CVEs from one
    // Critical with a patch available, and the image is often gone before anyone can ask.
    for (const field of [
      'vulnerabilityBySeverity',
      'vulnerabilityFixable',
      'secretsByRule',
      'secretSample',
    ]) {
      expect(script).toContain(field);
    }
  });

  it('fails closed on every measurement step rather than reporting a zero it did not measure', () => {
    const script = emitGuestScript();
    for (const detail of [
      'syft-failed',
      'grype-failed',
      'gitleaks-failed',
      'gitleaks-no-report',
      'gitleaks-missing',
      'secret-parse-failed',
      'vuln-parse-failed',
      'vuln-severity-parse-failed',
      'vuln-fix-parse-failed',
      'secret-rule-parse-failed',
      'secret-sample-parse-failed',
      // Mounting SOMETHING is not the same as mounting the thing under test.
      'candidate-root-not-mounted',
    ]) {
      expect(script).toContain(detail);
    }
  });

  it('proves it mounted the operating system, not merely some filesystem', () => {
    const script = emitGuestScript();
    // The mount loop swallows each failure with `2>/dev/null` and only fails closed at a
    // total of zero, so a root filesystem that fails to mount while an EFI partition
    // succeeds leaves mounted>=1. The scan then runs across a few hundred MB of boot
    // partition and returns a near-zero measurement — and near-zero is exactly what the
    // release policy ACCEPTS, so the failure mode is a GREEN gate on an image that was
    // never scanned (WI-1092039).
    //
    // Counting cannot express this guard: the lsblk filter admits any non-empty FSTYPE, so
    // swap / LVM2_member / crypto_LUKS partitions are attempted and legitimately fail, and
    // `mounted == attempted` would red every honest run. Proving the userland was read is
    // the narrower checkable property, and it is immune to those partition types.
    expect(script).toContain('-name os-release');
    expect(script).toMatch(/if \[ -z "\$candidate_root" \]/);
    expect(script).toContain('candidateRootProof');
  });

  it('never swallows a failure from a measurement step with `|| true`', () => {
    // The original defect: `gitleaks ... || true` with secret_count defaulting to 0 made a
    // dead scanner look like a clean image. No measurement step may reintroduce that.
    const measurementLines = executableLines(emitGuestScript()).filter((line) =>
      /\b(gitleaks|grype|syft|jq)\b/.test(line),
    );
    expect(measurementLines.length).toBeGreaterThan(0);
    expect(measurementLines.filter((line) => /\|\|\s*true/.test(line))).toEqual([]);
  });

  it('verifies the pinned gitleaks download against its published digest before trusting it', () => {
    const script = emitGuestScript();
    // gitleaks ships no installer; it was previously fetched from an install.sh URL that
    // has never existed, and the 404 was swallowed. The tarball must be digest-checked.
    expect(script).toContain('sha256sum -c');
    expect(script).toContain('gitleaks-digest-mismatch');
    expect(script).not.toContain('scripts/install.sh');
  });

  it('has a host-side reader for every field the guest emits', () => {
    // THE CLASS THIS GUARDS. The guest and the host are two halves of one document with
    // nothing asserting they agree, so a field could be computed on the VM, fail-closed
    // validated, serialised over SSH — and read by nothing. That happened twice, and both
    // were invisible for exactly the same reason:
    //
    //   vulnerabilityFixableBySeverity — whose own comment calls it "precisely the number
    //     that decides whether a red gate means 'patch the image' or 'the threshold is
    //     unsatisfiable against this distro'". Added to stop a guess, then never delivered,
    //     so the guess had to be made a second time on the 0.0.18 candidate (WI-1088331).
    //   mountedFilesystems — the scan's own coverage. Losing it made a partially mounted
    //     candidate publishable behind a green gate (WI-1092039).
    //
    // Both had two references in the whole tree, both inside the guest's own jq call.
    // Deriving the field list from the script means the NEXT one cannot hide the same way.
    const source = readFileSync(SCANNER_SOURCE, 'utf8');
    const script = emitGuestScript();

    const projection = script.match(/'\{sbomSha256:[^}]*\}'/);
    if (!projection) {
      throw new Error('could not locate the guest result projection — extraction is stale, not the subject');
    }
    const emitted = [...projection[0].matchAll(/([A-Za-z0-9_]+):\$/g)].map((match) => match[1]);
    // Self-check, same spirit as emitGuestScript's: a regex that silently matched nothing
    // would make this test pass vacuously, which is the failure mode it exists to prevent.
    expect(emitted).toContain('sbomSha256');
    expect(emitted.length).toBeGreaterThanOrEqual(9);

    const unread = emitted.filter((field) => !source.includes(`measurement.${field}`));
    expect(unread).toEqual([]);
  });
});

/**
 * THE CATALOGER MUST ACTUALLY LOOK AT WHAT THE IMAGE SHIPS.
 *
 * syft selects its catalogers from the SOURCE TYPE. On a dir: source it enables
 * javascript-lock-cataloger (tagged 'directory') but NOT javascript-package-cataloger
 * (tagged 'image, installed'). The shipped bundle contains node_modules but no lock file,
 * so before 2026-08-30 neither JS cataloger produced a package: the release gate reported
 * npm:0 for 276 real npm dependencies it had never looked at, and grype cannot match what
 * was never cataloged (D-200 / WI-1117135).
 *
 * Measured against the real shipped bundle with syft 1.51.1: a default dir: scan yields
 * binary 5 / go-module 284 / opam 1 = 290 with npm 0; adding the flag yields 579 — the same
 * 290 plus npm 289. What that blindness hid was 26 findings at or above HIGH in our own
 * dependencies, every one with an upstream fix available, including a Critical in
 * form-data 4.0.0.
 *
 * This is the same fail-open SHAPE as the dead gitleaks and the unmounted root: the scan
 * succeeds, every parse check passes, and a confident low number is returned for a
 * population that was never measured. So both halves are pinned here — the flag that makes
 * the measurement happen, and the assertion that fails closed if it stops happening.
 */
describe('image scan guest script — ecosystem cataloger coverage', () => {
  it('adds the javascript package cataloger ADDITIVELY, so npm is scanned without dropping the OS catalogers', () => {
    const script = emitGuestScript();

    const syftLine = script.split('\n').find((line) => line.includes('syft scan dir:/mnt/candidate'));
    expect(syftLine, 'the syft invocation moved — extraction is stale, not the subject').toBeTruthy();

    // The leading '+' is the whole point: without it the selection REPLACES the default set
    // and the distro measurement — the 3938 findings the gate actually reports — silently
    // disappears. A test asserting only "mentions the cataloger" would pass on that
    // catastrophic variant, so the '+' is asserted explicitly.
    expect(syftLine).toContain('--select-catalogers +javascript-package-cataloger');
    expect(syftLine).not.toContain('--override-default-catalogers');
  });

  it('fails CLOSED when node_modules manifests are present but the SBOM cataloged no npm package', () => {
    const script = emitGuestScript();

    // The guard must key on the SBOM, not on grype's output: a cataloger that produces
    // nothing yields an empty match set that every downstream parse check accepts.
    expect(script).toContain('sbom-npm-coverage-zero');
    expect(script).toMatch(/select\(\.type == "npm"\)/);

    // And it must be a hard exit, not a warning. Locate the guard's own block rather than
    // asserting against the whole script, so an `exit 1` belonging to another step cannot
    // make this pass vacuously.
    const guard = script.slice(script.indexOf('npm_manifests='));
    const block = guard.slice(0, guard.indexOf('grype sbom:'));
    expect(block, 'the npm coverage guard no longer precedes grype').toContain('exit 1');
    expect(block).toContain('sbom-npm-parse-failed');
  });
});

/**
 * SCOPE ATTRIBUTION — papercusp-bundled versus inherited base image.
 *
 * The scan measures the whole mounted image on purpose, but the release it reports on is only
 * the content under /opt/papercusp. D-201 proved the difference decides whether the gate is
 * reachable at all: linux-kernel alone carries 1054 findings at or above high, so no change to
 * the release can ever green a gate that measures the whole mount, while D-202 showed the npm
 * findings under the bundle are ours and 100% fixable. Two populations, opposite remediations.
 *
 * These are EVIDENCE fields — no policy reads them yet, by design (D-202 section 4 sequences the
 * npm remediation before the gate changes what it accepts). What is pinned here is therefore not
 * a verdict but the two properties that make the evidence trustworthy: that the split is actually
 * computed for both legs, and that it fails CLOSED when it computes nothing.
 */
describe('image scan guest script — template integrity', () => {
  it('contains no backtick inside the guest-script template literal', () => {
    // Says the cause out loud, because the symptom does not.
    //
    // The whole guest script is a JS template literal, so ONE backtick in a shell comment
    // terminates it early and the rest of the file stops parsing. The scanner's own source
    // carries a warning about this ("Caught twice now by node --check"); it has now happened a
    // third time — writing `find` in prose inside a comment, an entirely natural thing to type.
    //
    // Without this test the failure is already caught, but it presents as sixteen unrelated
    // "SyntaxError: Unexpected identifier" failures across every test in the file, none of which
    // names a backtick. The cause is a one-character edit and the symptom is a wall of noise, so
    // the diagnosis costs far more than the fix. This turns that into one named assertion.
    const source = readFileSync(SCANNER_SOURCE, 'utf8');
    const lines = source.split('\n');
    const open = lines.findIndex((line) => line.includes('return `#!/bin/bash'));
    expect(open, 'could not locate the template opening — extraction is stale, not the subject')
      .toBeGreaterThan(-1);
    const close = lines.findIndex((line, i) => i > open && line === '`;');
    expect(close, 'could not locate the template close — extraction is stale').toBeGreaterThan(open);

    const offenders = lines
      .slice(open + 1, close)
      .map((line, i) => ({ line, n: open + 2 + i }))
      .filter((row) => row.line.includes('`'));
    expect(
      offenders.map((row) => `${row.n}: ${row.line.trim()}`),
      'a backtick inside the template terminates it early — the whole script stops parsing',
    ).toEqual([]);
  });
});

describe('image scan guest script — papercusp/inherited scope attribution', () => {
  it('splits BOTH legs on the bundle path, matching the substring with both delimiters', () => {
    const script = emitGuestScript();

    // Both legs, because D-201 established they are one defect — a split that covered only
    // vulnerabilities would leave the 275 secret findings exactly as unattributable as before.
    expect(script).toContain('vuln_by_scope=');
    expect(script).toContain('vuln_crit_high_by_scope=');
    expect(script).toContain('secrets_by_scope=');

    // The BOUNDING SLASHES are the assertion, not the bare path. syft and gitleaks disagree on
    // whether a dir:-source path is absolute-on-guest or relative to the scan root, so the
    // matcher is a substring test; without the trailing slash it would also match a sibling
    // such as /opt/papercusp-old and silently over-attribute findings to us.
    expect(script).toContain('contains("/opt/papercusp/")');
    expect(script).not.toMatch(/startswith\("\/opt\/papercusp/);

    // Every finding must land in exactly one of two buckets — an `else` branch, not a filter.
    // A filter would drop the inherited population from the document entirely, which is the
    // evidence D-201 depends on to prove the gate is unreachable.
    expect(script).toContain('"inherited-base-image"');
    expect(script).toContain('"papercusp-bundled"');
  });

  it('fails CLOSED when the bundle is on the image but the matcher attributed nothing to it', () => {
    const script = emitGuestScript();

    const guard = script.slice(script.indexOf('bundle_present='));
    const block = guard.slice(0, guard.indexOf('# Secret DETAIL'));
    expect(block, 'the scope attribution guard moved — extraction is stale, not the subject')
      .toContain('scope-attribution-zero');
    expect(block).toContain('exit 1');
    expect(block).toContain('sbom-scope-parse-failed');
  });

  it('treats a MISSING bundle as a hard error, not as "nothing of ours to report"', () => {
    const script = emitGuestScript();

    const guard = script.slice(script.indexOf('bundle_present='));
    const block = guard.slice(0, guard.indexOf('# Secret DETAIL'));

    // A detector must not share its subject's single point of failure.
    //
    // `find` and the SBOM matcher both read the same bundle-path constant, so if that constant is
    // WRONG they fail together: nothing is found on disk, nothing is attributed, and a guard
    // written as "present AND NOT cataloged" never fires. Every finding would then be labelled
    // inherited and the release would read as having no findings of its own — the precise
    // fail-open this proof exists to prevent, reintroduced by the guard meant to catch it.
    //
    // The image is a papercusp workspace-host image by construction, so an absent bundle means
    // either a mis-built image or a wrong constant, and both must red. Pinned because the
    // conditional form is the one that LOOKS more careful.
    expect(block).toContain('bundle-path-not-found');
    expect(block, 'the missing-bundle check must be unconditional, not gated on bundle_present')
      .toMatch(/bundle_present" -eq 0 \]; then detail="bundle-path-not-found"/);
    expect(block, 'a "present AND NOT cataloged" conjunction re-opens the wrong-constant hole')
      .not.toMatch(/bundle_present" -gt 0 \].*&&/);
  });

  it('keys the guard on CATALOGED PACKAGES, never on finding counts', () => {
    const script = emitGuestScript();

    const guard = script.slice(script.indexOf('bundle_present='));
    const block = guard.slice(0, guard.indexOf('# Secret DETAIL'));

    // This is the property most likely to be "simplified" into a bug, so it is pinned directly.
    //
    // A bundle carrying ZERO vulnerabilities is the SUCCESS state this whole effort is driving
    // toward — D-202 says the npm findings are ours and every one has an upstream fix. So a
    // guard keyed on a zero FINDING count would red the gate at exactly the moment the
    // remediation finally worked, and the obvious response to that would be to delete the
    // guard. Cataloged packages cannot legitimately fall to zero while the bundle exists
    // (~291 npm packages under the path, per the D-200 measurement), so they are the honest
    // denominator: they falsify a broken matcher without punishing a clean release.
    expect(block, 'the guard must read the SBOM, not grype output').toContain('/tmp/sbom.json');
    expect(block, 'keying the guard on findings reds a successfully remediated bundle')
      .not.toContain('/tmp/vuln.json');
    expect(block).toContain('.artifacts[]?');
  });

  it('never emits a matched secret value while attributing the secrets leg', () => {
    const script = emitGuestScript();

    const line = script.split('\n').find((l) => l.includes('secrets_by_scope='));
    expect(line, 'the secrets scope projection moved — extraction is stale').toBeTruthy();

    // Same non-disclosure rule the sample and area projections are held to: this document is
    // read back over SSH into release logs and work-item evidence, so projecting gitleaks'
    // own .Secret / .Match would turn a detection into a disclosure. Attribution needs the
    // FILE path and nothing else.
    expect(line).not.toContain('.Secret');
    expect(line).not.toContain('.Match');
    expect(line).toContain('.File');
  });
});

/**
 * A CONDITIONAL FAIL-CLOSED GUARD IS ONLY SOUND IF ITS PRECONDITION IS PROVEN BY SOMETHING
 * OUTSIDE THE GUARD'S OWN INPUTS.
 *
 * `if subject_present > 0 AND subject_measured == 0 then fail` reads as the CAREFUL version of
 * a guard and is frequently a silent no-op. When the precondition and the measurement derive
 * from the same source, a fault in that source zeroes BOTH: nothing is present, nothing is
 * measured, the conjunction is never satisfied, the guard never fires, and the release reads
 * spotless. The detector shares its subject's single point of failure, so it cannot detect that
 * failure — and it looks MORE rigorous than the unconditional form it replaced.
 *
 * This shape was written into this file twice on 2026-08-30. The bundle scope-attribution guard
 * derived both `find` and the SBOM matcher from PAPERCUSP_BUNDLE_PATH, so a wrong constant
 * zeroed both; it was caught in review and is now pinned unconditionally at `bundle-path-not-found`
 * above. The npm ecosystem-coverage guard has the same shape and is CORRECT, because its
 * precondition is independently established.
 *
 * So the shape is not bannable — banning it would delete a working guard, and the assertion
 * below deliberately does not. What it forces is the JUSTIFICATION: every conditional guard must
 * carry written prose saying why its precondition cannot fail in the same breath as its subject.
 *
 * The second-order reason this is a build-time guard rather than review discipline: the npm
 * guard became sound as a SIDE EFFECT of two unrelated fixes landing the same day (the
 * unconditional bundle hard-fail, and host-side mount-coverage enforcement under
 * GCP_IMAGE_SCAN_POLICY — WI-1092039 / D-205). Nothing re-evaluated it when they landed.
 * Soundness is not local to a guard; it is the guard plus everything upstream, and upstream
 * changes silently. A registry that must be edited to add a guard is the cheapest place to make
 * that re-evaluation happen.
 */

/** One fail-closed `exit 1`, with every predicate that must hold for it to fire. */
type FailClosedExit = { detail: string; predicates: string[] };

/**
 * Split a shell test into its conjuncts. `-a` is POSIX's obsolete in-bracket AND; it is also a
 * unary file-exists operator, which this file does not use and which would mis-split if it ever
 * appeared. Prefer `] && [`.
 */
const splitConjuncts = (test: string): string[] =>
  test
    .split(/&&|\s-a\s/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

/**
 * Every fail-closed exit in the guest script, paired with the predicates that gate it.
 *
 * Deliberately STRUCTURAL rather than textual. The obvious detector — grep for `] && [` — sees
 * only the single-line conjunction and is blind to the identical class written as a nested `if`,
 * or as a `|| { exit }` inside an enclosing `if`. Both forms are what a well-meaning author
 * actually types, and three of the four guards this finds today are invisible to that grep.
 *
 * BOUNDARY, stated so no coverage claim is read wider than the evidence: this walks
 * comment-stripped lines and understands `if` / `fi` / `else` and `|| {`. It does not parse the
 * shell. A guard hidden inside a `case`, a `while`, a function called from elsewhere, or a
 * command substitution is NOT in this population.
 */
function failClosedExits(script: string): FailClosedExit[] {
  const lines = script.split('\n').filter((line) => !/^\s*#/.test(line));
  const stack: { test: string; lineIndex: number }[] = [];
  const exits: FailClosedExit[] = [];

  lines.forEach((line, index) => {
    const opened = /^\s*(?:el)?if\s+(.+)$/.exec(line);
    if (opened) {
      const thenIndex = opened[1].indexOf('; then');
      const test = (thenIndex >= 0 ? opened[1].slice(0, thenIndex) : opened[1]).trim();
      stack.push({ test, lineIndex: index });
    }

    if (/(^|;|\s)exit 1(\s|;|$)/.test(line)) {
      // Every enclosing test must hold for this exit to be REACHED, and each conjunct within a
      // test is its own predicate. A `|| { ... }` clause contributes the command failure itself.
      const predicates = stack.flatMap((frame) => splitConjuncts(frame.test));
      if (/\|\|\s*\{/.test(line)) predicates.push(`command failure: ${line.trim()}`);

      // Name the exit by the detail code it reports. That code is what reaches a release log and
      // what host-side policy reads, so it is the stable identity — line numbers are not.
      const floor = stack.length > 0 ? stack[stack.length - 1].lineIndex : 0;
      let detail: string | null = null;
      for (let i = index; i >= floor; i -= 1) {
        const match = /detail="([^"]+)"/.exec(lines[i]);
        if (match) {
          detail = match[1];
          break;
        }
      }
      if (!detail) {
        throw new Error(
          `a fail-closed exit sets no detail= code, so it cannot be named in a release log ` +
            `or keyed for justification: ${line.trim()}`,
        );
      }
      exits.push({ detail, predicates });
    }

    if (/(^|;|\s)fi(\s|;|$)/.test(line)) stack.pop();
  });

  return exits;
}

/**
 * A guard is CONDITIONAL when more than one predicate must hold for it to fire — i.e. something
 * other than its own failure condition gates it. That is precisely the population whose
 * precondition can share a failure mode with its subject.
 *
 * `if [ "$vuln_count" = "null" ]; then ... exit 1; fi` has ONE predicate (its own failure
 * condition) and is unconditional. So is the `else` branch of a gate, which fires exactly when
 * the gate does not.
 */
const conditionalGuards = (script: string): FailClosedExit[] =>
  failClosedExits(script).filter((exit) => exit.predicates.length > 1);

/**
 * The `command -v gitleaks` gate is a sound precondition because its COMPLEMENT is itself an
 * unconditional fail-closed exit: the `else` branch reports `gitleaks-missing` and exits. There
 * is therefore no path on which a missing scanner yields a zero secret count — the property the
 * three guards below rely on, established outside their own inputs.
 */
const GITLEAKS_PRESENCE_PROVEN =
  'Gated on `command -v gitleaks`, whose complement is an unconditional fail-closed exit: the ' +
  '`else` branch sets detail="gitleaks-missing" and exits 1. A missing scanner therefore reds ' +
  'the scan rather than falling through to secret_count=0, so this guard skipping is never a ' +
  'silent pass. The precondition is proven by the else branch, not by any input this guard reads.';

/**
 * Why each conditional guard's precondition cannot fail in the same breath as its subject.
 *
 * SHRINK-ONLY. An entry whose guard leaves the script must be deleted with it — asserted below,
 * so this can never decay into an append-forever parking lot. Adding an entry is the moment to
 * ask the only question that matters: is this precondition established by something OUTSIDE the
 * inputs this guard reads? If the honest answer is no, make the guard unconditional instead.
 */
const CONDITIONAL_GUARD_JUSTIFICATIONS: Record<string, string> = {
  'sbom-npm-coverage-zero':
    'The precondition `npm_manifests > 0` cannot be zeroed by the same fault as `npm_cataloged` ' +
    'because the bundle is proven present independently: an absent bundle path is an ' +
    'UNCONDITIONAL hard error (detail="bundle-path-not-found"), an unmounted OS root is an ' +
    'unconditional hard error (detail="candidate-root-not-mounted"), and mount coverage is ' +
    'enforced host-side by evaluateImageScanPolicy under GCP_IMAGE_SCAN_POLICY (WI-1092039 / ' +
    'D-205). node_modules lives under /opt/papercusp, so on a proven-mounted, proven-bundle- ' +
    'bearing image `npm_manifests == 0` is a REAL reading, not an instrument failure.',
  'gitleaks-failed': GITLEAKS_PRESENCE_PROVEN,
  'gitleaks-no-report': GITLEAKS_PRESENCE_PROVEN,
  'secret-parse-failed': GITLEAKS_PRESENCE_PROVEN,
};

/** A conjunction guard with no independent proof of its precondition — must be REJECTED. */
const CONTROL_UNJUSTIFIED_CONJUNCTION = `#!/bin/bash
subject_present=$(find /mnt/candidate -path "$SUBJECT_ROOT/*" -name manifest.json | head -1 | wc -l)
subject_measured=$(jq "[.artifacts[]? | select(.path | contains(\\"$SUBJECT_ROOT\\"))] | length" /tmp/sbom.json)
if [ "$subject_present" -gt 0 ] && [ "$subject_measured" -eq 0 ]; then
  detail="control-unjustified-conjunction"; exit 1
fi
`;

/** The SAME class written as a nested `if` — invisible to a `] && [` grep. Must be REJECTED. */
const CONTROL_NESTED_PRECONDITION = `#!/bin/bash
if command -v controltool >/dev/null 2>&1; then
  if [ ! -f /tmp/control-report.json ]; then detail="control-nested-precondition"; exit 1; fi
fi
`;

/** A gated command failure — also invisible to a `] && [` grep. Must be REJECTED. */
const CONTROL_GATED_COMMAND_FAILURE = `#!/bin/bash
if command -v controltool >/dev/null 2>&1; then
  controltool run || { detail="control-gated-command-failure"; exit 1; }
fi
`;

/** An unconditional guard. Must be ACCEPTED, or the checker is just "everything is a violation". */
const CONTROL_UNCONDITIONAL = `#!/bin/bash
measured=$(jq "[.matches[]?] | length" /tmp/vuln.json 2>/dev/null || echo "null")
if [ "$measured" = "null" ]; then detail="control-parse-failed"; exit 1; fi
controltool run || { detail="control-run-failed"; exit 1; }
`;

describe('image scan guest script — conditional fail-closed guards carry a justification', () => {
  it('finds the conditional guards a `] && [` grep cannot see', () => {
    // CALIBRATION. Every assertion below is of the form "the detected set satisfies X", so a
    // detector that silently matched nothing would make all of them pass vacuously — the exact
    // failure mode this whole describe block exists to prevent, reintroduced one level up.
    const detected = conditionalGuards(emitGuestScript()).map((guard) => guard.detail);

    // The single-line conjunction, which the naive grep does find.
    expect(detected).toContain('sbom-npm-coverage-zero');
    // The three it does not: all gated by an enclosing `if command -v gitleaks`.
    expect(detected).toContain('gitleaks-failed');
    expect(detected).toContain('gitleaks-no-report');
    expect(detected).toContain('secret-parse-failed');

    // And the unconditional majority must NOT be swept in, or the registry becomes a list of
    // every guard in the file and stops meaning anything.
    const all = failClosedExits(emitGuestScript());
    expect(all.length).toBeGreaterThanOrEqual(40);
    expect(detected.length).toBeLessThan(all.length / 2);
    expect(detected).not.toContain('vuln-parse-failed');
    expect(detected).not.toContain('gitleaks-missing');
  });

  it('every conditional guard carries a written justification', () => {
    const unjustified = conditionalGuards(emitGuestScript())
      .filter((guard) => !CONDITIONAL_GUARD_JUSTIFICATIONS[guard.detail])
      .map((guard) => `${guard.detail} :: gated by ${JSON.stringify(guard.predicates)}`);

    expect(
      unjustified,
      'a conditional fail-closed guard was added without recording why its precondition is ' +
        'proven OUTSIDE its own inputs. If it is not, the guard is a silent no-op wearing the ' +
        'costume of care — make it unconditional. If it is, add the entry saying how.',
    ).toEqual([]);
  });

  it('the registry is shrink-only — no entry outlives its guard', () => {
    const present = new Set(conditionalGuards(emitGuestScript()).map((guard) => guard.detail));
    const stale = Object.keys(CONDITIONAL_GUARD_JUSTIFICATIONS).filter(
      (detail) => !present.has(detail),
    );

    expect(
      stale,
      'these justifications name guards that are no longer in the script; delete them. Without ' +
        'this the registry becomes an append-forever parking lot and stops being evidence.',
    ).toEqual([]);
  });

  it('each conditional guard is distinctly named, so one entry cannot justify two guards', () => {
    const details = conditionalGuards(emitGuestScript()).map((guard) => guard.detail);
    expect(details.length).toBe(new Set(details).size);
  });

  it('each justification is prose, not a rubber stamp', () => {
    // A length floor cannot judge whether a justification is TRUE — only a reader can, which is
    // the point of forcing one to be written. What it does buy is that '' and 'ok' cannot pass,
    // so the registry entry costs enough to be worth thinking about.
    const thin = Object.entries(CONDITIONAL_GUARD_JUSTIFICATIONS)
      .filter(([, why]) => why.trim().length < 120)
      .map(([detail]) => detail);
    expect(thin).toEqual([]);
  });

  it('REJECTS an unjustified single-line conjunction (permanent control)', () => {
    // Falsifiability, proven against fixtures rather than by mutating the real scanner: this is
    // a shared, swept checkout, so an in-tree mutant can be committed by git-sync mid-probe even
    // when nothing goes wrong. These controls are permanent and bidirectional instead.
    const detected = conditionalGuards(CONTROL_UNJUSTIFIED_CONJUNCTION);
    expect(detected.map((guard) => guard.detail)).toEqual(['control-unjustified-conjunction']);
    expect(CONDITIONAL_GUARD_JUSTIFICATIONS['control-unjustified-conjunction']).toBeUndefined();
  });

  it('REJECTS the same class written as a nested if (permanent control)', () => {
    const detected = conditionalGuards(CONTROL_NESTED_PRECONDITION);
    expect(detected.map((guard) => guard.detail)).toEqual(['control-nested-precondition']);
  });

  it('REJECTS a command failure gated by an enclosing precondition (permanent control)', () => {
    const detected = conditionalGuards(CONTROL_GATED_COMMAND_FAILURE);
    expect(detected.map((guard) => guard.detail)).toEqual(['control-gated-command-failure']);
  });

  it('ACCEPTS unconditional guards (permanent control)', () => {
    // The negative direction. Without this, a checker that flagged EVERY guard would satisfy
    // every rejection control above while being useless.
    expect(conditionalGuards(CONTROL_UNCONDITIONAL)).toEqual([]);
    expect(failClosedExits(CONTROL_UNCONDITIONAL).map((exit) => exit.detail)).toEqual([
      'control-parse-failed',
      'control-run-failed',
    ]);
  });

  it('refuses a fail-closed exit that names no detail code', () => {
    // An unkeyable guard is also an untraceable one: it reds a release with no code to look up.
    expect(() => failClosedExits('#!/bin/bash\nif [ -z "$x" ]; then exit 1; fi\n')).toThrow(
      /sets no detail= code/,
    );
  });
});

/**
 * THE BUNDLED POPULATION MUST BE ENUMERABLE BY FILE, OR IT CANNOT BE TRIAGED.
 *
 * `secretsByScope` says HOW MANY findings are in content we ship. `secretsByArea` says which
 * top-level directory they sit under. Neither says WHICH FILE — and judging whether a finding is
 * a real baked-in credential means opening the file it is in. The only per-file field was
 * `secretSample`, `.[0:50]` over the UNSCOPED set in gitleaks' own emission order.
 *
 * Measured on the 0.0.18 candidate: 275 findings, 31 of them papercusp-bundled. The 50-row
 * unscoped sample resolved 2 of those 31 to a file. The other 29 were unresolvable from any
 * emitted field, so the release gate was red on a population nobody could inspect without paying
 * for a second scan of a 32GB image. (The 2 that WERE named turned out to be an upstream
 * @excalidraw public Firebase client key vendored under our bundle path — a verdict reachable
 * only because the sample happened to name the file.)
 *
 * These tests EXECUTE the guest's real jq programs, extracted from the emitted script, against
 * synthetic reports. A structural assertion could confirm the field is spelled correctly while
 * the filter selected the wrong population; running it cannot.
 */
describe('image scan guest script — bundled secret findings are enumerable', () => {
  const workdir = mkdtempSync(join(tmpdir(), 'p046-bundled-sample-'));
  afterAll(() => rmSync(workdir, { recursive: true, force: true }));

  /** jq is a hard dependency of the guest script itself, so a missing one is a real failure. */
  const jqAvailable = (() => {
    try {
      // WI-41180: bound every sync spawn in the pure lane — it blocks the shared worker's
      // event loop, so vitest cannot time it out and one hang wedges ~2,740 files.
      execFileSync('jq', ['--version'], { stdio: 'pipe', timeout: 10_000, killSignal: 'SIGKILL' });
      return true;
    } catch {
      return false;
    }
  })();

  /**
   * Pull the single-quoted jq program out of a `name=$(jq ... '<program>' file)` assignment in
   * the EMITTED script (so shell escapes and the interpolated bundle path are already resolved).
   */
  function jqProgramOf(assignment: string): string {
    const line = emitGuestScript()
      .split('\n')
      .find((candidate) => candidate.startsWith(`${assignment}=`));
    if (!line) throw new Error(`no ${assignment}= assignment in the emitted script`);
    const open = line.indexOf("'");
    const close = line.indexOf("'", open + 1);
    if (open < 0 || close < 0) throw new Error(`no quoted jq program in ${assignment}=`);
    const program = line.slice(open + 1, close);
    // Self-check, same spirit as emitGuestScript's: an extraction that silently produced a
    // trivial program would make every assertion below pass against nothing.
    if (program.length < 20 || !program.includes('.[]?')) {
      throw new Error(`extraction produced something that is not a jq program: ${program}`);
    }
    return program;
  }

  /** The cap the guest actually passes, read off the script rather than restated here. */
  function declaredCap(): number {
    const line = emitGuestScript()
      .split('\n')
      .find((candidate) => candidate.startsWith('secrets_bundled_sample='));
    const match = line?.match(/--argjson cap (\d+)/);
    if (!match) throw new Error('secrets_bundled_sample= passes no --argjson cap');
    return Number(match[1]);
  }

  function runJq(program: string, report: unknown, cap: number): unknown {
    const path = join(workdir, `report-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(path, JSON.stringify(report), 'utf8');
    const out = execFileSync('jq', ['-c', '--argjson', 'cap', String(cap), program, path], {
      encoding: 'utf8',
      // WI-41180: see the `jq --version` probe above — a sync spawn is uninterruptible by
      // vitest, so a jq program that never terminates would wedge the whole pure lane.
      timeout: 30_000,
      killSignal: 'SIGKILL',
    });
    return JSON.parse(out);
  }

  const bundledFinding = (n: number) => ({
    RuleID: 'generic-api-key',
    File: `/mnt/candidate/sda1/opt/papercusp/releases/0.0.18/spa/chunk-${n}.js`,
    StartLine: n,
    Secret: `FAKE-BUNDLED-VALUE-${n}`,
  });
  const inheritedFinding = (n: number) => ({
    RuleID: 'private-key',
    File: `/mnt/candidate/sda1/usr/share/doc/thing-${n}/key.pem`,
    StartLine: n,
    Secret: `FAKE-INHERITED-VALUE-${n}`,
  });

  it.runIf(jqAvailable)('returns EVERY bundled finding and ONLY bundled findings', () => {
    const report = [
      inheritedFinding(1),
      bundledFinding(2),
      inheritedFinding(3),
      bundledFinding(4),
      bundledFinding(5),
    ];
    const rows = runJq(jqProgramOf('secrets_bundled_sample'), report, declaredCap()) as {
      rule: string;
      file: string;
      line: number;
    }[];

    expect(rows.map((row) => row.line).sort()).toEqual([2, 4, 5]);
    expect(rows.every((row) => row.file.includes('/opt/papercusp/'))).toBe(true);
    // rule/file/line and nothing else — the projection is the non-disclosure boundary.
    expect([...new Set(rows.flatMap((row) => Object.keys(row)))].sort()).toEqual([
      'file',
      'line',
      'rule',
    ]);
  });

  it.runIf(jqAvailable)('never carries a matched secret value out of the report', () => {
    const report = [bundledFinding(1), inheritedFinding(2)];
    const serialised = JSON.stringify(
      runJq(jqProgramOf('secrets_bundled_sample'), report, declaredCap()),
    );
    expect(serialised).not.toContain('FAKE-BUNDLED-VALUE');
    expect(serialised).not.toContain('FAKE-INHERITED-VALUE');
    expect(serialised).not.toContain('Secret');
  });

  it.runIf(jqAvailable)(
    'THE DEFECT THIS CLOSES: the unscoped 50-row sample resolves none of them',
    () => {
      // The 0.0.18 shape, reproduced: enough inherited findings to fill the unscoped sample
      // before a single bundled one is reached. This is not a hypothetical ordering — gitleaks
      // walks /usr and /var long before /opt, which is exactly why 29 of 31 were invisible.
      const report = [
        ...Array.from({ length: 60 }, (_unused, index) => inheritedFinding(index + 1)),
        ...Array.from({ length: 3 }, (_unused, index) => bundledFinding(index + 100)),
      ];

      const unscoped = runJq(jqProgramOf('secrets_sample'), report, declaredCap()) as {
        file: string;
      }[];
      const bundledInUnscoped = unscoped.filter((row) => row.file.includes('/opt/papercusp/'));
      expect(unscoped).toHaveLength(50);
      expect(bundledInUnscoped).toEqual([]); // the blind spot, pinned

      const scoped = runJq(jqProgramOf('secrets_bundled_sample'), report, declaredCap()) as {
        file: string;
      }[];
      expect(scoped).toHaveLength(3); // every one of them, from the same report
    },
  );

  it.runIf(jqAvailable)('reports completeness honestly in BOTH directions', () => {
    const report = Array.from({ length: 4 }, (_unused, index) => bundledFinding(index + 1));
    const completeProgram = jqProgramOf('secrets_bundled_complete');
    const sampleProgram = jqProgramOf('secrets_bundled_sample');

    // Under the cap: the array is the whole population and says so.
    expect(runJq(completeProgram, report, 500)).toBe(true);
    expect(runJq(sampleProgram, report, 500)).toHaveLength(4);

    // Over the cap: the array is cut, and the flag is what makes that visible. A truncated list
    // that cannot announce itself is indistinguishable from a complete one, and reading one as
    // the other is how a real finding gets triaged away.
    expect(runJq(completeProgram, report, 2)).toBe(false);
    expect(runJq(sampleProgram, report, 2)).toHaveLength(2);
  });

  it.runIf(jqAvailable)(
    'counts completeness over the BUNDLED population, not the whole report',
    () => {
      // A flag computed over all findings would read `false` on an image whose bundled set is
      // tiny but whose inherited set is huge — the common case — permanently reporting the
      // complete list as truncated and re-opening the "we need another scan" hole.
      const report = [
        ...Array.from({ length: 40 }, (_unused, index) => inheritedFinding(index + 1)),
        bundledFinding(99),
      ];
      expect(runJq(jqProgramOf('secrets_bundled_complete'), report, 10)).toBe(true);
    },
  );

  it('emits the bundled sample and its completeness flag into the result document', () => {
    const script = emitGuestScript();
    for (const field of ['secretBundledSample', 'secretBundledSampleComplete']) {
      expect(script).toContain(field);
    }
    // Both fail closed, like every other measurement step: a parse failure must red the run
    // rather than report an empty bundled list, which the gate would read as a clean image.
    expect(script).toContain('secret-bundled-sample-parse-failed');
    expect(script).toContain('secret-bundled-complete-parse-failed');
  });

  it('scopes the bundled sample on the bundle path with both delimiters', () => {
    // `/opt/papercusp` without the trailing slash also matches `/opt/papercusp-old`; without
    // the leading one it matches a `.../vendor/opt/papercusp` path. Same rule the scope split
    // above is already pinned to.
    expect(jqProgramOf('secrets_bundled_sample')).toContain('contains("/opt/papercusp/")');
    expect(jqProgramOf('secrets_bundled_complete')).toContain('contains("/opt/papercusp/")');
  });
});
