// @vitest-environment jsdom
/**
 * StepWelcome.test.tsx — render-tier coverage for the SetupWizard welcome
 * step. Pure presentational: the hello copy, the three-item essentials
 * checklist, the reassurance list, and the "Start setup" button that fires the
 * onStart callback.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { StepWelcome } from './StepWelcome';

afterEach(cleanup);

describe('StepWelcome (SetupWizard welcome step)', () => {
  it('renders the hello heading and the lead copy', () => {
    render(<StepWelcome onStart={vi.fn()} />);
    expect(screen.getByRole('heading', { name: /Welcome\. We.ll set this up together\./i })).toBeTruthy();
    expect(screen.getByText(/Papercusp works best with a local database/i)).toBeTruthy();
  });

  it('lists the three setup essentials', () => {
    render(<StepWelcome onStart={vi.fn()} />);
    expect(screen.getByText('Local database')).toBeTruthy();
    expect(screen.getByText('Workspace folder')).toBeTruthy();
    expect(screen.getByText('Coding agent')).toBeTruthy();
    // The aria-labelled checklist exists with all three steps.
    const list = screen.getByLabelText('Setup essentials');
    expect(list.querySelectorAll('li').length).toBe(3);
  });

  it('renders the reassurance list', () => {
    render(<StepWelcome onStart={vi.fn()} />);
    const comfort = screen.getByLabelText('Setup reassurance');
    expect(comfort.querySelectorAll('li').length).toBe(3);
    expect(screen.getByText(/Nothing leaves your machine unless you choose it\./i)).toBeTruthy();
  });

  it('fires onStart when the "Start setup" button is clicked', () => {
    const onStart = vi.fn();
    render(<StepWelcome onStart={onStart} />);
    fireEvent.click(screen.getByRole('button', { name: /Start setup/i }));
    expect(onStart).toHaveBeenCalledTimes(1);
  });
});
