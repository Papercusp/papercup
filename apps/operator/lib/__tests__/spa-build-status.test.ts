// EI-10539 — when there is no bundle, the 503 must tell the truth.
//
// The message that met the owner on a dead desktop was "operator-vite is not
// built. Run `npm --workspace @papercusp/operator-vite run build`." — while the
// reason there was no bundle was that THAT BUILD had just failed (a link-time
// error, which vite hits after it has already emptied dist/). Prescribing the
// command that failed is worse than useless: it sends you round the same loop.
import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  describeMissingBundle,
  formatMissingBundleMessage,
  parseBuildFailure,
  readBuildFailure,
  tailLines,
} from '../spa-build-status';

const BUILD_CMD = 'npm --workspace @papercusp/operator-vite run build';

describe('formatMissingBundleMessage', () => {
  it('with NO failure on record, keeps the build advice — a fresh checkout genuinely needs one', () => {
    const msg = formatMissingBundleMessage(null);
    expect(msg).toContain('not built');
    expect(msg).toContain(BUILD_CMD);
  });

  it('with a failure on record, leads with the FAILURE and refuses to prescribe the build that failed', () => {
    const msg = formatMissingBundleMessage(
      { failedAt: '2026-07-12T20:12:03Z', exitCode: 1, log: '/tmp/.vite-build.log' },
      ['error: "@assistant-ui/store" does not provide an export named "tapClientResource"'],
    );

    expect(msg).toContain('LAST BUILD FAILED');
    expect(msg).toContain('exit 1');
    expect(msg).toContain('2026-07-12T20:12:03Z');
    // The actionable part: the real error, and where to read more.
    expect(msg).toContain('tapClientResource');
    expect(msg).toContain('/tmp/.vite-build.log');
    // It may MENTION the build command, but only to say re-running it is futile —
    // never as the bare instruction the old message gave.
    expect(msg).toContain('will fail exactly the same way');
    expect(msg).not.toMatch(/^operator-vite is not built\. Run/);
  });
});

describe('parseBuildFailure', () => {
  it('parses a well-formed marker', () => {
    const f = parseBuildFailure('{"failedAt":"2026-07-12T20:12:03Z","exitCode":2,"log":"/l"}');
    expect(f).toEqual({ failedAt: '2026-07-12T20:12:03Z', exitCode: 2, log: '/l' });
  });

  it('returns null on junk rather than throwing — a corrupt marker must never 500 the SPA route', () => {
    expect(parseBuildFailure('not json')).toBeNull();
    expect(parseBuildFailure('{}')).toBeNull();
    expect(parseBuildFailure('{"failedAt":"x"}')).toBeNull();
  });
});

describe('tailLines', () => {
  it('takes the last non-blank lines — where the error actually is', () => {
    const log = ['vite v8.0.16 building...', '', 'transforming...', '', 'error: boom', ''].join('\n');
    expect(tailLines(log, 2)).toEqual(['transforming...', 'error: boom']);
  });
});

describe('readBuildFailure / describeMissingBundle (on disk)', () => {
  it('reads the marker beside dist/ and folds the log tail into the message', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'spa-bs-'));
    try {
      const dist = join(tmp, 'dist');
      mkdirSync(dist);
      const log = join(tmp, '.vite-build.log');
      writeFileSync(log, 'building...\nerror: does not provide an export named "tapClientResource"\n');
      writeFileSync(
        join(tmp, '.vite-build-failure.json'),
        JSON.stringify({ failedAt: '2026-07-12T20:12:03Z', exitCode: 1, log }),
      );

      expect(readBuildFailure(dist)).toMatchObject({ exitCode: 1 });

      const msg = describeMissingBundle(dist);
      expect(msg).toContain('LAST BUILD FAILED');
      expect(msg).toContain('tapClientResource');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('with no marker (a packaged desktop, or a never-built checkout) falls back to the plain build advice', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'spa-bs-'));
    try {
      const dist = join(tmp, 'dist');
      mkdirSync(dist);
      expect(readBuildFailure(dist)).toBeNull();
      expect(describeMissingBundle(dist)).toContain(BUILD_CMD);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
