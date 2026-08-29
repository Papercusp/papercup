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

const SCANNER_SOURCE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'bin',
  'papercusp-image-scan.mjs',
);

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
    ]) {
      expect(script).toContain(detail);
    }
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
});
