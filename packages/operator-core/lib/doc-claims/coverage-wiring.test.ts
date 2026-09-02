/**
 * P-007 (design-to-code-coverage-seam-2026-09-02): the coverage provider config
 * and the nightly workflow must not drift back into documenting each other while
 * nothing connects them. See `./coverage-wiring.ts` for the incident.
 *
 * The FIXTURE controls are load-bearing, for the reason the sibling doc-claims
 * tests state: once the live assertion goes green it stops being evidence that
 * the detector works at all. Each fixture reproduces a shape that MUST be
 * caught — including the exact arrangement that stood in the tree until
 * 2026-09-02, where every individual artifact looked correct.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  judgeCoverageWiring,
  stripYamlComments,
  DISCLAIMER_SENTINEL,
} from './coverage-wiring';

// lib/doc-claims → lib → operator-core → packages → <repo root>
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const RUNNER = join(ROOT, 'scripts/affected-tests.mjs');
const CONFIG = join(ROOT, 'libs/test-config/src/vitest-config.ts');
const WORKFLOW_DIR = join(ROOT, '.github/workflows');

const INERT_CONFIG_WITH_DISCLAIMER = `
      // ⚠ ${DISCLAIMER_SENTINEL} \`--coverage\`. This block runs only when a
      // human or agent types the flag.
      coverage: {
        provider: 'v8',
        reportsDirectory: './coverage',
      },
`;

const UPLOAD_STEP = `
      - name: Upload coverage artifacts (if produced)
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: coverage
          path: '**/coverage/**'
          if-no-files-found: ignore
`;

describe('coverage-wiring doc claim', () => {
  describe('fixture controls (the detector must be able to FAIL)', () => {
    it('catches the exact pre-2026-09-02 tree: an upload step with no producer', () => {
      const verdict = judgeCoverageWiring({
        runnerSource: 'const KNOWN_FLAGS = ["--all", "--integration"];',
        workflows: [
          { name: 'test-nightly.yml', source: `      - run: node scripts/affected-tests.mjs --all --integration\n${UPLOAD_STEP}` },
        ],
        configSource: INERT_CONFIG_WITH_DISCLAIMER,
      });
      expect(verdict.ok).toBe(false);
      expect(verdict.artifactConsumerSites.length).toBeGreaterThan(0);
      expect(verdict.producerSites).toHaveLength(0);
      expect(verdict.violations.join('\n')).toMatch(/can never fire/);
    });

    it('catches a stale disclaimer once a producer is wired up', () => {
      const verdict = judgeCoverageWiring({
        runnerSource: 'const KNOWN_FLAGS = ["--all", "--coverage"];',
        workflows: [],
        configSource: INERT_CONFIG_WITH_DISCLAIMER,
      });
      expect(verdict.ok).toBe(false);
      expect(verdict.producerSites).toHaveLength(1);
      expect(verdict.violations.join('\n')).toMatch(/still says/);
    });

    it('catches an inert provider block that does not admit it is inert', () => {
      const verdict = judgeCoverageWiring({
        runnerSource: 'const KNOWN_FLAGS = ["--all"];',
        workflows: [],
        configSource: "coverage: { provider: 'v8' },",
      });
      expect(verdict.ok).toBe(false);
      expect(verdict.violations.join('\n')).toMatch(/does not say it is inert/);
    });

    it('accepts coverage genuinely wired: a producer, a consumer, no disclaimer', () => {
      const verdict = judgeCoverageWiring({
        runnerSource: 'if (has("--coverage")) forward.push("--coverage");',
        workflows: [{ name: 'test-nightly.yml', source: UPLOAD_STEP }],
        configSource: "coverage: { provider: 'v8' },",
      });
      expect(verdict.ok).toBe(true);
      expect(verdict.violations).toEqual([]);
    });

    it('does not mistake a COMMENTED-OUT producer for a real one', () => {
      const verdict = judgeCoverageWiring({
        runnerSource: '// someday: accept --coverage here\nconst KNOWN_FLAGS = ["--all"];',
        workflows: [
          { name: 'test-nightly.yml', source: '      # the --coverage flag is deliberately absent\n' },
        ],
        configSource: INERT_CONFIG_WITH_DISCLAIMER,
      });
      expect(verdict.producerSites).toHaveLength(0);
      expect(verdict.ok).toBe(true);
    });

    it('does not mistake an unrelated "…-coverage" lint name for an artifact consumer', () => {
      const verdict = judgeCoverageWiring({
        runnerSource: 'const KNOWN_FLAGS = ["--all"];',
        workflows: [
          { name: 'test.yml', source: '      - name: Lint tests (four-framework + tab-coverage guard)\n' },
        ],
        configSource: INERT_CONFIG_WITH_DISCLAIMER,
      });
      expect(verdict.artifactConsumerSites).toEqual([]);
      expect(verdict.ok).toBe(true);
    });
  });

  describe('stripYamlComments', () => {
    it('drops full-line comments', () => {
      expect(stripYamlComments('  # path: "**/coverage/**"').join('')).toBe('');
    });

    it('never truncates a quoted glob that could contain a #', () => {
      const line = "          path: '**/coverage/**' # trailing";
      expect(stripYamlComments(line)[0]).toContain('**/coverage/**');
    });
  });

  describe('the live tree', () => {
    it('keeps the coverage config and the workflows in agreement', () => {
      const workflows = readdirSync(WORKFLOW_DIR)
        .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
        .map((name) => ({ name, source: readFileSync(join(WORKFLOW_DIR, name), 'utf8') }));

      // A zero-length workflow list would make the consumer check vacuous.
      expect(workflows.length).toBeGreaterThan(0);

      const verdict = judgeCoverageWiring({
        runnerSource: readFileSync(RUNNER, 'utf8'),
        workflows,
        configSource: readFileSync(CONFIG, 'utf8'),
      });

      expect(verdict.violations).toEqual([]);
      expect(verdict.ok).toBe(true);
      // Calibration: the config really does still declare a provider block, so
      // the rules above are being exercised rather than skipped.
      expect(verdict.providerBlockPresent).toBe(true);
    });
  });
});
