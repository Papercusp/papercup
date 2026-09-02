/**
 * Pins the claim carried in `libs/test-config/src/vitest-config.ts`:
 * "⚠ NOTHING AUTOMATED PASSES `--coverage`."
 *
 * P-007 (plan design-to-code-coverage-seam-2026-09-02). The incident this guard
 * exists to prevent is not "a config documenting a job that was never built" —
 * it is subtler and it defeated two careful readers in opposite directions:
 *
 *   • The provider block in vitest-config.ts cited "the nightly full run" as its
 *     consumer, so it read as wired.
 *   • `.github/workflows/test-nightly.yml` really does exist, really does run
 *     nightly, and really did carry an "Upload coverage artifacts (if produced)"
 *     step — so IT read as wired too.
 *   • The link between them never existed: the nightly's test step is
 *     `affected-tests.mjs --all --integration`, and that runner has no
 *     Vitest-flag passthrough at all, so no workspace has ever run with
 *     `--coverage`. `if-no-files-found: ignore` then made the miss silent.
 *
 * Each end documented the other, so each made the other look intentional. That
 * mutual corroboration is why this needs a machine check rather than prose: a
 * reader who inspects EITHER end alone comes away satisfied, and only a reader
 * who inspects the middle finds the gap.
 *
 * The rule is therefore bidirectional. Wiring coverage up is welcome; what is
 * forbidden is either half drifting out of agreement with the other:
 *   1. a coverage artifact consumer with no producer  → decoration returns;
 *   2. a producer while the config still disclaims one → the disclaimer is a lie;
 *   3. an inert provider block carrying no disclaimer  → the original trap.
 */
import { stripComments } from './gate-candidate-ref';

/** Sentinel the config comment must carry while coverage is collected nowhere. */
export const DISCLAIMER_SENTINEL = 'NOTHING AUTOMATED PASSES';

/** Marks the Vitest coverage provider block as present in the shared config. */
const PROVIDER_BLOCK = /provider:\s*['"]v8['"]/;

/** Anything that would hand `--coverage` to a test runner. */
const COVERAGE_FLAG = /--coverage\b/;

/**
 * A workflow line that consumes a coverage ARTIFACT — an upload path glob or an
 * artifact literally named `coverage`. Deliberately narrow: an unrelated word
 * ("attributor-runner-coverage") must not read as a consumer.
 */
const ARTIFACT_CONSUMER = /\*\*\/coverage\b|\bcoverage\/\*\*|name:\s*coverage\s*$/;

export interface CoverageWiringInput {
  /** `scripts/affected-tests.mjs` — the runner every automated test path enters. */
  runnerSource: string;
  /** Every `.github/workflows/*.yml`, keyed by file name. */
  workflows: Array<{ name: string; source: string }>;
  /** `libs/test-config/src/vitest-config.ts` — the provider block and its claim. */
  configSource: string;
}

export interface CoverageWiringVerdict {
  ok: boolean;
  /** Sites that would actually cause coverage to be collected automatically. */
  producerSites: string[];
  /** Sites that consume a coverage artifact. */
  artifactConsumerSites: string[];
  providerBlockPresent: boolean;
  disclaimerPresent: boolean;
  violations: string[];
}

/**
 * Drop YAML comments. Full-line `#` comments go unconditionally; a trailing `#`
 * is stripped only on lines carrying no quote, so a quoted glob such as
 * `path: '**\/coverage/**'` can never be truncated by a `#` inside a string.
 */
export function stripYamlComments(source: string): string[] {
  return source.split('\n').map((line) => {
    if (/^\s*#/.test(line)) return '';
    return /['"]/.test(line) ? line : line.replace(/#.*$/, '');
  });
}

/** Report `name:line` for each line of `lines` matching `pattern`. */
function sites(name: string, lines: string[], pattern: RegExp): string[] {
  const found: string[] = [];
  lines.forEach((line, i) => {
    if (pattern.test(line)) found.push(`${name}:${i + 1}`);
  });
  return found;
}

export function judgeCoverageWiring(input: CoverageWiringInput): CoverageWiringVerdict {
  const producerSites = [
    ...sites('scripts/affected-tests.mjs', stripComments(input.runnerSource), COVERAGE_FLAG),
    ...input.workflows.flatMap((w) =>
      sites(w.name, stripYamlComments(w.source), COVERAGE_FLAG),
    ),
  ];

  const artifactConsumerSites = input.workflows.flatMap((w) =>
    sites(w.name, stripYamlComments(w.source), ARTIFACT_CONSUMER),
  );

  const configLines = stripComments(input.configSource);
  const providerBlockPresent = configLines.some((line) => PROVIDER_BLOCK.test(line));
  // The sentinel lives in a COMMENT, so it is read from the raw source.
  const disclaimerPresent = input.configSource.includes(DISCLAIMER_SENTINEL);

  const violations: string[] = [];

  if (artifactConsumerSites.length > 0 && producerSites.length === 0) {
    violations.push(
      `Coverage artifact consumer with no producer (${artifactConsumerSites.join(', ')}): ` +
        'nothing passes `--coverage`, so this step can never fire and will silently ' +
        'upload nothing. Add a real producer (a Vitest-flag passthrough in ' +
        'affected-tests.mjs) or remove the consumer.',
    );
  }

  if (producerSites.length > 0 && disclaimerPresent) {
    violations.push(
      `Coverage IS collected automatically now (${producerSites.join(', ')}), but ` +
        `libs/test-config/src/vitest-config.ts still says "${DISCLAIMER_SENTINEL} ` +
        '`--coverage`". Update that comment — and say where the report lands.',
    );
  }

  if (producerSites.length === 0 && providerBlockPresent && !disclaimerPresent) {
    violations.push(
      'libs/test-config/src/vitest-config.ts configures a Vitest coverage provider ' +
        `that nothing ever runs, without the "${DISCLAIMER_SENTINEL}" disclaimer. ` +
        'An inert config that does not say it is inert reads as evidence that ' +
        'coverage is being collected. Restore the disclaimer or wire a producer.',
    );
  }

  return {
    ok: violations.length === 0,
    producerSites,
    artifactConsumerSites,
    providerBlockPresent,
    disclaimerPresent,
    violations,
  };
}
