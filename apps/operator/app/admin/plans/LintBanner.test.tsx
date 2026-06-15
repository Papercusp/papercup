// @vitest-environment jsdom
//
// LintBanner — the slim plan-lint banner (P-206). All its logic is render-time
// (null-guards, error/warning pluralization, the per-finding click → scroll +
// highlight pulse), so this is a render-smoke + interaction test. No pure
// helper is exported; the behavior IS the conditional render, so we drive it
// directly with mocked report shapes and a real scopeRef DOM.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { createRef } from 'react';
import type { PlanLintReport } from './plans-api';
import LintBanner from './LintBanner';

afterEach(cleanup);

function report(over: Partial<PlanLintReport> = {}): PlanLintReport {
  return {
    slug: 'p',
    archived: false,
    legacy: false,
    exempt: false,
    errors: [],
    warnings: [],
    ...over,
  };
}

describe('<LintBanner /> guards', () => {
  const ref = createRef<HTMLElement>();

  it('renders nothing when the report is null/undefined', () => {
    const { container } = render(<LintBanner report={null} scopeRef={ref} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing for an exempt plan', () => {
    const { container } = render(<LintBanner report={report({ exempt: true })} scopeRef={ref} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing for a legacy plan', () => {
    const { container } = render(<LintBanner report={report({ legacy: true })} scopeRef={ref} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when there are no findings', () => {
    const { container } = render(<LintBanner report={report()} scopeRef={ref} />);
    expect(container.firstChild).toBeNull();
  });
});

describe('<LintBanner /> render', () => {
  const ref = createRef<HTMLElement>();

  it('pluralizes errors and warnings and joins them with a comma', () => {
    render(
      <LintBanner
        report={report({
          errors: [{ level: 'error', code: 'E1', message: 'bad' }, { level: 'error', code: 'E2', message: 'also bad' }],
          warnings: [{ level: 'warning', code: 'W1', message: 'meh' }],
        })}
        scopeRef={ref}
      />,
    );
    expect(screen.getByText(/2 errors/)).toBeTruthy();
    expect(screen.getByText(/1 warning/)).toBeTruthy();
  });

  it('uses the singular form for a lone error', () => {
    render(
      <LintBanner
        report={report({ errors: [{ level: 'error', code: 'E1', message: 'x' }] })}
        scopeRef={ref}
      />,
    );
    expect(screen.getByText('1 error')).toBeTruthy();
  });

  it('adds the error modifier class when there is at least one error', () => {
    const { container } = render(
      <LintBanner
        report={report({ errors: [{ level: 'error', code: 'E1', message: 'x' }] })}
        scopeRef={ref}
      />,
    );
    expect(container.querySelector('.pc-lint-banner--error')).toBeTruthy();
  });

  it('uses the warn modifier class when there are only warnings', () => {
    const { container } = render(
      <LintBanner
        report={report({ warnings: [{ level: 'warning', code: 'W1', message: 'x' }] })}
        scopeRef={ref}
      />,
    );
    expect(container.querySelector('.pc-lint-banner--warn')).toBeTruthy();
  });

  it('renders one clickable finding button per error and warning', () => {
    const { container } = render(
      <LintBanner
        report={report({
          errors: [{ level: 'error', code: 'E1', message: 'one' }],
          warnings: [
            { level: 'warning', code: 'W1', message: 'two' },
            { level: 'warning', code: 'W2', message: 'three' },
          ],
        })}
        scopeRef={ref}
      />,
    );
    expect(container.querySelectorAll('.pc-lint-banner__finding')).toHaveLength(3);
    expect(screen.getByText('E1')).toBeTruthy();
  });
});

describe('<LintBanner /> click → scroll + highlight', () => {
  it('scrolls to the matching plan item and pulses the highlight class', () => {
    // Build a scope DOM with a data-plan-item target the finding points at.
    const scope = document.createElement('div');
    const target = document.createElement('div');
    target.setAttribute('data-plan-item', 'P-007');
    const scrollSpy = vi.fn();
    target.scrollIntoView = scrollSpy;
    scope.appendChild(target);
    const ref = { current: scope };

    render(
      <LintBanner
        report={report({ errors: [{ level: 'error', code: 'E1', message: 'x', itemId: 'P-007' }] })}
        scopeRef={ref}
      />,
    );

    fireEvent.click(screen.getByText('E1').closest('button')!);
    expect(scrollSpy).toHaveBeenCalledOnce();
    expect(target.classList.contains('pc-plan-highlight')).toBe(true);
  });

  it('is a no-op when the scope ref is unset (nothing throws)', () => {
    const ref = { current: null };
    render(
      <LintBanner
        report={report({ errors: [{ level: 'error', code: 'E1', message: 'x', itemId: 'P-007' }] })}
        scopeRef={ref}
      />,
    );
    expect(() => fireEvent.click(screen.getByText('E1').closest('button')!)).not.toThrow();
  });
});
