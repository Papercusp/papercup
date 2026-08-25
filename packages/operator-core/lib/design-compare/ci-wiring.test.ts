/**
 * A build-time pin on the CI wiring and on artifact retention.
 *
 * Plan: ratified-mockup-implementation-validation-2026-08-24 (P-008).
 *
 * P-008 adds a report-only step to an EXISTING gating job. That is the shape
 * with the most ways to go quietly wrong, and each of them is silent:
 *
 *   * the report step could acquire the power to fail the build (report-only
 *     stops being report-only, and D-006's staging is bypassed without anyone
 *     deciding to bypass it);
 *   * a Lost Pixel step could acquire `continue-on-error` while someone is
 *     making the report step not gate — turning the EXISTING regression suite
 *     into a no-op with a green tick;
 *   * the report step could drift ABOVE a Lost Pixel step, where `if: always()`
 *     no longer means "after the gating work";
 *   * the diff artifacts could stop being uploaded, or their retention could
 *     revert to an unstated default that nobody chose.
 *
 * None of those fails a test that only checks the design-compare library, and
 * none of them fails until someone needs the evidence and finds it gone. So the
 * workflow file is parsed and asserted here.
 *
 * This is a pin, not a test of GitHub Actions. It asserts that the FACTS this
 * plan's decisions rest on are still facts.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const WORKFLOW_PATH = path.join(REPO_ROOT, '.github/workflows/test.yml');

interface WorkflowStep {
  readonly name?: string;
  readonly run?: string;
  readonly uses?: string;
  readonly if?: string;
  readonly 'continue-on-error'?: boolean;
  readonly with?: Record<string, unknown>;
}

const workflow = parseYaml(readFileSync(WORKFLOW_PATH, 'utf8')) as {
  jobs: Record<string, { steps?: WorkflowStep[] }>;
};

const visualSteps: WorkflowStep[] = workflow.jobs?.visual?.steps ?? [];
const stepIndex = (predicate: (s: WorkflowStep) => boolean): number =>
  visualSteps.findIndex(predicate);

const LOST_PIXEL_STEP = (s: WorkflowStep): boolean => (s.run ?? '').includes('npm run lostpixel');
const REPORT_STEP = (s: WorkflowStep): boolean =>
  (s.run ?? '').includes('npm run design:evidence-report');

describe('visual job wiring (P-008)', () => {
  it('has a visual job with steps at all, so no assertion below passes vacuously', () => {
    // Without this, a renamed job would make every `findIndex` return -1 and
    // every "is not present" assertion below succeed against an empty list.
    expect(visualSteps.length).toBeGreaterThan(0);
  });

  describe('the existing Lost Pixel regression suite still gates', () => {
    const lostPixelSteps = visualSteps.filter(LOST_PIXEL_STEP);

    it('still runs a Lost Pixel comparison for each configured workspace in CI', () => {
      // Four, not five: `libs/generic/papergrid/grid-core` has a lostpixel
      // config but no CI step. That gap predates this plan and is recorded
      // here rather than silently normalised by asserting `>= 1`.
      expect(lostPixelSteps).toHaveLength(4);
    });

    it.each(['libs/generic/ui-primitives', 'libs/marketplace-public-ui', 'libs/agent-chat', 'apps/operator'])(
      'still compares %s',
      (workingDirectory) => {
        const step = visualSteps.find(
          (s) =>
            LOST_PIXEL_STEP(s) &&
            (s as { 'working-directory'?: string })['working-directory'] === workingDirectory,
        );
        expect(step, `no Lost Pixel step for ${workingDirectory}`).toBeDefined();
      },
    );

    it('lets a Lost Pixel failure fail the job', () => {
      // The whole point of the suite. A `continue-on-error` here would leave
      // visual regression running and reporting and never blocking anything.
      for (const step of lostPixelSteps) {
        expect(step['continue-on-error'] ?? false).toBe(false);
      }
    });

    it('still uploads Lost Pixel diff artifacts when the job fails', () => {
      const upload = visualSteps.find((s) => s.with?.name === 'lost-pixel-diffs');
      expect(upload).toBeDefined();
      expect(upload?.if).toBe('failure()');
      const paths = String(upload?.with?.path ?? '');
      for (const workspace of [
        'libs/generic/ui-primitives',
        'libs/marketplace-public-ui',
        'libs/agent-chat',
        'apps/operator',
      ]) {
        expect(paths).toContain(`${workspace}/lostpixel-current`);
        expect(paths).toContain(`${workspace}/lostpixel-diff`);
      }
    });
  });

  describe('the design evidence step reports and never gates (D-006)', () => {
    it('is wired into this job rather than standing up a parallel one', () => {
      // P-008 says "wire into the EXISTING path". A separate job would rebuild
      // four Storybooks to produce the same evidence.
      expect(stepIndex(REPORT_STEP)).toBeGreaterThanOrEqual(0);
    });

    it('cannot fail the build', () => {
      const step = visualSteps[stepIndex(REPORT_STEP)];
      expect(step?.['continue-on-error']).toBe(true);
    });

    it('still runs after a Lost Pixel failure, so it observes the same commit', () => {
      const step = visualSteps[stepIndex(REPORT_STEP)];
      expect(step?.if).toBe('always()');
    });

    it('runs after every gating Lost Pixel step', () => {
      // `if: always()` above only means "after the gating work" while the step
      // is actually positioned after it. Ordering is the other half of that
      // claim and drifts the moment someone inserts a workspace.
      const reportAt = stepIndex(REPORT_STEP);
      const lastLostPixelAt = visualSteps.reduce(
        (last, step, index) => (LOST_PIXEL_STEP(step) ? index : last),
        -1,
      );
      expect(lastLostPixelAt).toBeGreaterThanOrEqual(0);
      expect(reportAt).toBeGreaterThan(lastLostPixelAt);
    });

    it('invokes the report mode, never the calibrate mode', () => {
      // Calibrating in CI would overwrite the committed calibration artifact
      // from whatever host the runner happens to be, silently re-deriving every
      // threshold with no review. D-021 makes that a decision, not a side
      // effect of a build.
      const step = visualSteps[stepIndex(REPORT_STEP)];
      expect(step?.run).not.toContain('design:evidence-calibrate');
    });
  });

  describe('artifact retention is stated, not inherited', () => {
    it.each(['design-evidence-report', 'lost-pixel-diffs'])(
      '%s declares an explicit retention-days',
      (artifactName) => {
        const upload = visualSteps.find((s) => s.with?.name === artifactName);
        expect(upload, `no upload step for ${artifactName}`).toBeDefined();
        const retention = upload?.with?.['retention-days'];
        expect(retention, `${artifactName} inherits an unstated retention default`).toBeDefined();
        expect(Number(retention)).toBeGreaterThan(0);
      },
    );

    it('uploads the design evidence even when the job failed', () => {
      // `if: failure()` would publish evidence only when something else broke,
      // which is the opposite of what a report is for.
      const upload = visualSteps.find((s) => s.with?.name === 'design-evidence-report');
      expect(upload?.if).toBe('always()');
    });

    it('warns rather than silently ignoring a missing design evidence report', () => {
      // `ignore` is right for the Lost Pixel diffs, which legitimately do not
      // exist on a green run. The report always should, so its absence is a
      // signal and must not be swallowed.
      const upload = visualSteps.find((s) => s.with?.name === 'design-evidence-report');
      expect(upload?.with?.['if-no-files-found']).toBe('warn');
    });
  });

  it('exposes the report entrypoint as an npm script the workflow can call', () => {
    const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(pkg.scripts?.['design:evidence-report']).toContain('--mode=report');
  });
});
