// @vitest-environment jsdom
//
// ReportTakeover (cleanup-report-flows-2026-08-24 P-001): the shared takeover
// wiring — useReportTakeoverParam is URL-driven (nuqs) with open/show/close,
// and ReportTakeoverLayer renders the takeover chrome. Mirrors the
// PlanDashboardHost.test.tsx nuqs-mock conventions.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const { nuqs, setters } = vi.hoisted(() => ({
  nuqs: {} as Record<string, unknown>,
  setters: {} as Record<string, ReturnType<typeof vi.fn>>,
}));
function mkSetter(key: string) {
  if (!setters[key]) setters[key] = vi.fn(async (v: unknown) => { nuqs[key] = v; });
  return setters[key];
}

import { nuqsParsers } from '@papercusp/test-config/nuqs-mock';
vi.mock('nuqs', () => ({
  ...nuqsParsers,
  useQueryState: (key: string, parser?: { _d?: unknown }) => [
    nuqs[key] !== undefined ? nuqs[key] : (parser?._d ?? null),
    mkSetter(key),
  ],
  parseAsString: { withDefault: (d: unknown) => ({ _d: d }) },
}));

import { ReportTakeoverLayer, useReportTakeoverParam } from './ReportTakeover';

afterEach(() => {
  cleanup();
  for (const k of Object.keys(nuqs)) delete nuqs[k];
});

function Probe({ paramKey }: { paramKey: string }) {
  const p = useReportTakeoverParam(paramKey);
  return (
    <div data-testid="probe" data-open={p.open} data-value={p.value ?? ''}>
      <button type="button" data-testid="probe-show" onClick={() => p.show('run-7')}>
        show
      </button>
      <button type="button" data-testid="probe-close" onClick={p.close}>
        close
      </button>
    </div>
  );
}

describe('useReportTakeoverParam', () => {
  it('is closed with no param, opens via show(value), and close() clears the param', () => {
    render(<Probe paramKey="opcln" />);
    expect(screen.getByTestId('probe').dataset.open).toBe('false');

    fireEvent.click(screen.getByTestId('probe-show'));
    expect(setters['opcln']).toHaveBeenCalledWith('run-7');

    nuqs['opcln'] = 'run-7';
    cleanup();
    render(<Probe paramKey="opcln" />);
    const probe = screen.getByTestId('probe');
    expect(probe.dataset.open).toBe('true');
    expect(probe.dataset.value).toBe('run-7');

    fireEvent.click(screen.getByTestId('probe-close'));
    expect(setters['opcln']).toHaveBeenLastCalledWith(null);
  });

  it('keys are independent — one renderer per param, as with pdash/pplan', () => {
    nuqs['opcln'] = 'run-7';
    render(<Probe paramKey="inbox-review" />);
    expect(screen.getByTestId('probe').dataset.open).toBe('false');
  });
});

describe('ReportTakeoverLayer', () => {
  it('renders the takeover chrome around its children with the default testid', () => {
    render(
      <ReportTakeoverLayer>
        <span data-testid="payload">report body</span>
      </ReportTakeoverLayer>,
    );
    const layer = screen.getByTestId('report-takeover');
    expect(layer.className).toBe('review-report-takeover');
    expect(screen.getByTestId('payload').textContent).toBe('report body');
  });

  it('honors a custom testid so two takeovers can coexist in one DOM', () => {
    render(
      <ReportTakeoverLayer testId="cleanup-report-takeover">
        <span>x</span>
      </ReportTakeoverLayer>,
    );
    expect(screen.getByTestId('cleanup-report-takeover')).toBeTruthy();
  });
});
