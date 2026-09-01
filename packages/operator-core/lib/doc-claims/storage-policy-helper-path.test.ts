/**
 * EI-21114194605020241 — the storage-policy invariant must point at the live
 * operator-state helper after its move from apps/operator into operator-core.
 *
 * The canonical text lives in harness_shared.harness_doc_parts and reaches these
 * tests through the committed corpus. CLAUDE.md and AGENTS.md are client projections
 * of the same row. Checking all three catches both kinds of drift: a stale canonical
 * claim and a projection that did not pick up the canonical repair.
 *
 * The fixture controls are load-bearing. Once the live documents are green, they no
 * longer prove that this detector can see the shipped stale-path defect. The exact
 * pre-fix helper line remains below so the guard must keep demonstrating that it
 * fails for the reason this work item exists.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CORPUS_PATH, ROOT } from './corpus-subject';

const SECTION_HEADING = '## Storage policy: Postgres by default';
const EXPECTED_HELPER = 'packages/operator-core/lib/operator-state-pg.ts';
const RETIRED_HELPER = 'apps/operator/lib/operator-state-pg.ts';
const HELPER_CLAIM = /Helpers:\s*`([^`]+)`\./g;

interface HelperPathVerdict {
  readonly ok: boolean;
  readonly sectionFound: boolean;
  readonly claimedPaths: readonly string[];
  readonly violations: readonly string[];
}

/** Extract one H2 section without allowing a matching path elsewhere to mask drift. */
function storagePolicySection(markdown: string): string | null {
  const start = markdown.indexOf(SECTION_HEADING);
  if (start < 0) return null;
  const end = markdown.indexOf('\n## ', start + SECTION_HEADING.length);
  return markdown.slice(start, end < 0 ? markdown.length : end);
}

function judgeStoragePolicyHelperPath(
  markdown: string,
  pathExists: (repoRelativePath: string) => boolean,
): HelperPathVerdict {
  const section = storagePolicySection(markdown);
  if (section === null) {
    return {
      ok: false,
      sectionFound: false,
      claimedPaths: [],
      violations: [`missing ${SECTION_HEADING}`],
    };
  }

  const claimedPaths = [...section.matchAll(HELPER_CLAIM)].map((match) => match[1]!);
  const violations: string[] = [];

  if (claimedPaths.length !== 1) {
    violations.push(
      `expected exactly one storage helper claim, found ${claimedPaths.length}: ${claimedPaths.join(', ') || '<none>'}`,
    );
  }
  if (!claimedPaths.includes(EXPECTED_HELPER)) {
    violations.push(`storage helper must be ${EXPECTED_HELPER}`);
  }
  if (section.includes(RETIRED_HELPER)) {
    violations.push(`storage helper still names retired path ${RETIRED_HELPER}`);
  }
  if (claimedPaths.includes(EXPECTED_HELPER) && !pathExists(EXPECTED_HELPER)) {
    violations.push(`documented storage helper does not exist: ${EXPECTED_HELPER}`);
  }

  return {
    ok: violations.length === 0,
    sectionFound: true,
    claimedPaths,
    violations,
  };
}

const fixture = (helperPath: string): string =>
  `${SECTION_HEADING}\n\n` +
  '**New durable state goes in Postgres unless there is a specific reason it must\n' +
  'be a file.** No plain-JSON state files, no module-scoped TTL `Map`s, no "PG\n' +
  `mirror with file primary". Helpers: \`${helperPath}\`.\n\n` +
  '## Next section\n';

describe('storage-policy operator-state helper path', () => {
  describe('fixture controls (the detector must be able to fail)', () => {
    it('catches the shipped stale apps/operator helper path', () => {
      const verdict = judgeStoragePolicyHelperPath(fixture(RETIRED_HELPER), () => true);

      expect(verdict.ok).toBe(false);
      expect(verdict.claimedPaths).toEqual([RETIRED_HELPER]);
      expect(verdict.violations.join('\n')).toContain(`must be ${EXPECTED_HELPER}`);
      expect(verdict.violations.join('\n')).toContain(`retired path ${RETIRED_HELPER}`);
    });

    it('treats a missing section as measured-nothing, never as clean', () => {
      const verdict = judgeStoragePolicyHelperPath('## Different section\n', () => true);

      expect(verdict.ok).toBe(false);
      expect(verdict.sectionFound).toBe(false);
      expect(verdict.violations).toEqual([`missing ${SECTION_HEADING}`]);
    });

    it('catches a correct-looking path that no longer resolves on disk', () => {
      const verdict = judgeStoragePolicyHelperPath(fixture(EXPECTED_HELPER), () => false);

      expect(verdict.ok).toBe(false);
      expect(verdict.violations).toEqual([
        `documented storage helper does not exist: ${EXPECTED_HELPER}`,
      ]);
    });

    it('accepts the corrected claim when its target resolves', () => {
      const verdict = judgeStoragePolicyHelperPath(
        fixture(EXPECTED_HELPER),
        (path) => path === EXPECTED_HELPER,
      );

      expect(verdict).toEqual({
        ok: true,
        sectionFound: true,
        claimedPaths: [EXPECTED_HELPER],
        violations: [],
      });
    });
  });

  describe('the live canonical corpus and client projections', () => {
    const subjects = [
      ['corpus', CORPUS_PATH],
      ['CLAUDE.md', resolve(ROOT, 'CLAUDE.md')],
      ['AGENTS.md', resolve(ROOT, 'AGENTS.md')],
    ] as const;

    for (const [label, path] of subjects) {
      it(`${label} carries the live helper path and resolves it`, () => {
        expect(existsSync(path), `${label} projection must exist`).toBe(true);
        const markdown = readFileSync(path, 'utf8');
        expect(markdown.length, `${label} projection must be non-trivial`).toBeGreaterThan(10_000);

        const verdict = judgeStoragePolicyHelperPath(markdown, (repoPath) =>
          existsSync(resolve(ROOT, repoPath)),
        );
        expect(verdict.violations, `${label} storage-policy claim`).toEqual([]);
        expect(verdict.claimedPaths).toEqual([EXPECTED_HELPER]);
        expect(verdict.ok).toBe(true);
      });
    }
  });
});
