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
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

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
