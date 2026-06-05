/**
 * @vitest-environment jsdom
 *
 * JoinProgress — per-step progress rendering tests (P-009, D-005).
 *
 * Covers:
 *  - All six canonical steps render in JOIN_STEP_IDS order, defaulting
 *    to `pending` when no state is supplied for a step.
 *  - Per-step status indicators: done (✓), running (spinner + detail),
 *    error (✕ + errorCode/detail), pending (○), phase_0_pending (— + "Phase 5").
 *  - The `gh_auth_required` error path: an `oauth_attest` step in error
 *    surfaces its detail as the call-to-action copy.
 *  - The fatal/error banner renders when `fatalError` is set.
 *  - The "Open harness →" link renders only when `insightsPath` is set.
 *
 * Uses @testing-library/react + vitest only (no jest-dom matchers).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { JoinProgress } from '../JoinProgress';
import { JOIN_STEP_IDS } from '@papercusp/operator-core/lib/harness/join-steps';
import type { JoinStepState } from '@papercusp/operator-core/lib/harness/join-steps';

afterEach(() => cleanup());

// Human-readable labels mirrored from STEP_META in the source so the test
// asserts against the actual rendered copy.
const STEP_LABELS = [
  'Authenticating with GitHub',
  'Cloning repository',
  'Publishing your binding',
  'Joining the swarm',
  'Syncing with peers',
  'Opening insights',
];

describe('JoinProgress — step list', () => {
  it('renders all six canonical steps in order, defaulting unsupplied steps to pending (○)', () => {
    const { container } = render(<JoinProgress steps={[]} />);
    // All six labels are present (no step state passed → all default pending).
    for (const label of STEP_LABELS) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    // Order matches JOIN_STEP_IDS — assert by matching label order in the DOM.
    const text = container.textContent ?? '';
    let lastIdx = -1;
    for (const label of STEP_LABELS) {
      const idx = text.indexOf(label);
      expect(idx).toBeGreaterThan(lastIdx);
      lastIdx = idx;
    }
    // No state supplied → every step is pending → six "○" markers.
    expect((text.match(/○/g) ?? []).length).toBe(JOIN_STEP_IDS.length);
  });
});

describe('JoinProgress — per-step status indicators', () => {
  it('renders a done step with the ✓ marker', () => {
    const steps: JoinStepState[] = [{ id: 'oauth_attest', status: 'done' }];
    const { container } = render(<JoinProgress steps={steps} />);
    expect(container.textContent).toContain('✓');
  });

  it('renders a running step with its detail copy (and no ✓/✕ for that step)', () => {
    const steps: JoinStepState[] = [{ id: 'clone_repo', status: 'running' }];
    render(<JoinProgress steps={steps} />);
    // The running step shows its detail line.
    expect(screen.getByText('Downloading the shared GitHub repository.')).toBeTruthy();
    // A spinner (no glyph) replaces the static marker — no ✓/✕ text present.
    expect(document.body.textContent).not.toContain('✓');
    expect(document.body.textContent).not.toContain('✕');
  });

  it('renders an error step with the ✕ marker and surfaces detail copy', () => {
    const steps: JoinStepState[] = [
      { id: 'publish_binding', status: 'error', errorCode: 'publish_failed', detail: 'Signature rejected' },
    ];
    render(<JoinProgress steps={steps} />);
    expect(document.body.textContent).toContain('✕');
    // detail is preferred over errorCode in the error sub-line.
    expect(screen.getByText('Signature rejected')).toBeTruthy();
  });

  it('error step falls back to errorCode when no detail is provided', () => {
    const steps: JoinStepState[] = [
      { id: 'publish_binding', status: 'error', errorCode: 'publish_failed' },
    ];
    render(<JoinProgress steps={steps} />);
    expect(screen.getByText('publish_failed')).toBeTruthy();
  });

  it('renders a phase_0_pending step with the "Phase 5" badge and — marker', () => {
    const steps: JoinStepState[] = [{ id: 'await_admission_merge', status: 'phase_0_pending' }];
    render(<JoinProgress steps={steps} />);
    expect(screen.getByText('Phase 5')).toBeTruthy();
    expect(document.body.textContent).toContain('—');
  });
});

describe('JoinProgress — gh_auth_required call-to-action path', () => {
  it('surfaces the gh-auth detail as the oauth_attest error copy', () => {
    // Mirrors what EntryHarnessLinkForm sets on a 401 / gh_auth_required:
    //   { id:'oauth_attest', status:'error', detail:'Not authenticated', errorCode:'gh_auth_required' }
    const steps: JoinStepState[] = [
      { id: 'oauth_attest', status: 'error', detail: 'Not authenticated', errorCode: 'gh_auth_required' },
    ];
    render(<JoinProgress steps={steps} />);
    // The authenticate-with-GitHub step is the one in error.
    expect(screen.getByText('Authenticating with GitHub')).toBeTruthy();
    // Its CTA / reason copy is rendered (detail preferred over errorCode).
    expect(screen.getByText('Not authenticated')).toBeTruthy();
    expect(document.body.textContent).toContain('✕');
  });
});

describe('JoinProgress — fatal error + completion', () => {
  it('renders the fatal-error banner when fatalError is set', () => {
    render(<JoinProgress steps={[]} fatalError="Join failed: network unreachable" />);
    expect(screen.getByText('Join failed: network unreachable')).toBeTruthy();
  });

  it('does NOT render the "Open harness" link when insightsPath is absent', () => {
    render(<JoinProgress steps={[]} />);
    expect(screen.queryByText(/Open harness/)).toBeNull();
  });

  it('renders the "Open harness →" link pointing at insightsPath when set', () => {
    render(<JoinProgress steps={[]} insightsPath="/harness/myslug/insights" />);
    const link = screen.getByText(/Open harness/);
    expect(link).toBeTruthy();
    expect(link.getAttribute('href')).toBe('/harness/myslug/insights');
  });
});
