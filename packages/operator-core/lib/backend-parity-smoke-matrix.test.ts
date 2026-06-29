import { existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Coverage paths in BACKEND_PARITY_SMOKE_MATRIX are repo-root-relative. Resolve them
// against the repo root derived from THIS file's location — NOT process.cwd(), which is
// the package dir under `test:affected` (the doubled-path "expected false to be true"
// red the green gate caught). lib → operator-core → packages → repo root = ../../..
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
import {
  BACKEND_FEATURE_CAPABILITIES,
  accountProviderForInteractiveBackend,
  type InteractiveBackend,
} from './backend-feature-capabilities';
import {
  BACKEND_PARITY_SMOKE_MATRIX,
  REQUIRED_BACKEND_PARITY_SMOKE_AREAS,
  type BackendParitySmokeArea,
} from './backend-parity-smoke-matrix';

const ALL_BACKENDS: readonly InteractiveBackend[] = ['claude', 'codex', 'omp'];

function repoPathExists(path: string): boolean {
  // Resolve against the location-derived repo root (REPO_ROOT) — robust regardless of
  // process.cwd() (repo root under a root vitest run, the package dir under test:affected).
  return existsSync(join(REPO_ROOT, path));
}

describe('BACKEND_PARITY_SMOKE_MATRIX', () => {
  it('covers every P-017 acceptance area exactly once', () => {
    const ids = BACKEND_PARITY_SMOKE_MATRIX.map((row) => row.id);
    expect(new Set(ids).size).toBe(ids.length);

    const areas = BACKEND_PARITY_SMOKE_MATRIX.map((row) => row.area).sort();
    expect(areas).toEqual([...REQUIRED_BACKEND_PARITY_SMOKE_AREAS].sort());

    const missing = REQUIRED_BACKEND_PARITY_SMOKE_AREAS.filter(
      (area) => !BACKEND_PARITY_SMOKE_MATRIX.some((row) => row.area === area),
    );
    expect(missing).toEqual([]);
  });

  it('uses concrete repo coverage files or bounded smoke commands for every row', () => {
    for (const row of BACKEND_PARITY_SMOKE_MATRIX) {
      expect(row.coverage.length, row.id).toBeGreaterThan(0);
      for (const coverage of row.coverage) {
        if (coverage.kind === 'bounded-cli-smoke') {
          expect(coverage.command, row.id).toEqual(
            expect.arrayContaining(['timeout', 'omp', '-r', '-p']),
          );
          expect(coverage.expected, row.id).toMatch(/not found|non-zero|TUI/i);
          continue;
        }
        expect(coverage.path, row.id).toBeTruthy();
        expect(repoPathExists(coverage.path!), `${row.id}: ${coverage.path}`).toBe(true);
      }
    }
  });

  it('pins capability states to the live backend capability table', () => {
    for (const row of BACKEND_PARITY_SMOKE_MATRIX) {
      expect(row.capabilities.length, row.id).toBeGreaterThan(0);
      for (const expected of row.capabilities) {
        expect(
          BACKEND_FEATURE_CAPABILITIES[expected.backend][expected.feature].state,
          `${row.id}: ${expected.backend}/${expected.feature}`,
        ).toBe(expected.state);
      }
    }
  });

  it('keeps the broad smoke rows explicitly cross-backend', () => {
    const crossBackendAreas: BackendParitySmokeArea[] = [
      'psu-launch-resume-wake',
      'spawned-agent-attach',
      'retired-brain-pinning',
      'gateway-account-pin-fail-closed',
      'prompt-materialization',
      'operator-command-run',
      'delegate-work-items',
      'plan-agent-backend-run',
    ];
    for (const area of crossBackendAreas) {
      const row = BACKEND_PARITY_SMOKE_MATRIX.find((candidate) => candidate.area === area);
      expect(row?.backends, area).toEqual(ALL_BACKENDS);
    }
  });

  it('documents the OMP resume leg as headless and bounded', () => {
    const row = BACKEND_PARITY_SMOKE_MATRIX.find((candidate) => candidate.area === 'omp-resume-leg');
    const smoke = row?.coverage.find((coverage) => coverage.kind === 'bounded-cli-smoke');
    expect(row?.backends).toEqual(['omp']);
    expect(smoke?.command).toEqual([
      'timeout',
      '10s',
      'omp',
      '-r',
      '__papercusp_smoke_nonexistent_thread__',
      '--approval-mode',
      'yolo',
      '-p',
      '__papercusp_resume_syntax_smoke__',
      '--no-tools',
      '--no-lsp',
      '--no-pty',
    ]);
  });

  it('marks account routing supported for claude, codex AND omp (omp via the models.yml gateway provider, D-006)', () => {
    const row = BACKEND_PARITY_SMOKE_MATRIX.find(
      (candidate) => candidate.area === 'gateway-account-pin-fail-closed',
    );
    expect(row?.capabilities).toEqual(
      expect.arrayContaining([
        { backend: 'omp', feature: 'account-pinning', state: 'supported' },
        { backend: 'omp', feature: 'gateway-routing', state: 'supported' },
      ]),
    );
    expect(accountProviderForInteractiveBackend('claude')).toBe('claude');
    expect(accountProviderForInteractiveBackend('codex')).toBe('codex');
    expect(accountProviderForInteractiveBackend('omp')).toBe('claude');
  });

  it('keeps retired brain pinning fail-closed for every backend', () => {
    const row = BACKEND_PARITY_SMOKE_MATRIX.find(
      (candidate) => candidate.area === 'retired-brain-pinning',
    );
    expect(row?.backends).toEqual(ALL_BACKENDS);
    expect(row?.coverage).toEqual(
      expect.arrayContaining([
        { kind: 'retired-surface', path: 'apps/operator-docs/src/content/docs/agent-spawning/terminal-wrappers.mdx' },
      ]),
    );
    expect(row?.capabilities).toEqual(
      expect.arrayContaining([
        { backend: 'claude', feature: 'brain-pinning', state: 'unsupported' },
        { backend: 'codex', feature: 'brain-pinning', state: 'unsupported' },
        { backend: 'omp', feature: 'brain-pinning', state: 'unsupported' },
      ]),
    );
  });
});
