import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
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
        expect(existsSync(join(process.cwd(), coverage.path!)), `${row.id}: ${coverage.path}`).toBe(true);
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

  it('keeps account routing fail-closed for backends without provider adapters', () => {
    const row = BACKEND_PARITY_SMOKE_MATRIX.find(
      (candidate) => candidate.area === 'gateway-account-pin-fail-closed',
    );
    expect(row?.capabilities).toEqual(
      expect.arrayContaining([
        { backend: 'omp', feature: 'account-pinning', state: 'unsupported' },
        { backend: 'omp', feature: 'gateway-routing', state: 'unsupported' },
      ]),
    );
    expect(accountProviderForInteractiveBackend('claude')).toBe('claude');
    expect(accountProviderForInteractiveBackend('codex')).toBe('codex');
    expect(accountProviderForInteractiveBackend('omp')).toBeNull();
  });
});
