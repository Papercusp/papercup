// @vitest-environment jsdom
/**
 * PromptModal.test.tsx — render-tier coverage for the window.prompt()
 * replacement (whole-app-test-coverage-breadth). Exercises: closed vs open,
 * the defaultValue seed, the optional body, the empty/whitespace gate
 * (allowEmpty off vs on), a custom validate() blocking submit, the form-submit
 * path (Enter / button) calling onSubmit with the trimmed value, and the error
 * surfaced when onSubmit throws (dialog stays open). The Radix Modal renders to
 * a portal under document.body in jsdom.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';

import { PromptModal } from './PromptModal';

afterEach(cleanup);

function noop() {}

describe('PromptModal (canonical window.prompt replacement)', () => {
  it('does not render its body when closed', () => {
    render(<PromptModal open={false} onOpenChange={noop} title="Rename" label="New name" onSubmit={noop} />);
    expect(screen.queryByText('New name')).toBeNull();
  });

  it('renders title + label and seeds the input from defaultValue when open', () => {
    render(
      <PromptModal open onOpenChange={noop} title="Rename workspace" label="New name" defaultValue="alpha" onSubmit={noop} />,
    );
    expect(screen.getAllByText('Rename workspace').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('New name')).toBeTruthy();
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('alpha');
  });

  it('renders the optional body when provided', () => {
    render(
      <PromptModal open onOpenChange={noop} title="x" label="L" body="Pick something descriptive." onSubmit={noop} />,
    );
    expect(screen.getByText('Pick something descriptive.')).toBeTruthy();
  });

  it('disables submit for an empty value when allowEmpty is false (default)', () => {
    render(<PromptModal open onOpenChange={noop} title="x" label="L" onSubmit={noop} />);
    expect((screen.getByRole('button', { name: 'Submit' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('disables submit for whitespace-only input', () => {
    render(<PromptModal open onOpenChange={noop} title="x" label="L" defaultValue="hello" onSubmit={noop} />);
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: '   ' } });
    expect((screen.getByRole('button', { name: 'Submit' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('allows an empty submit when allowEmpty is set', () => {
    render(<PromptModal open onOpenChange={noop} title="x" label="L" allowEmpty onSubmit={noop} />);
    expect((screen.getByRole('button', { name: 'Submit' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('a custom validate() error blocks submit', () => {
    const validate = (v: string) => (v.length < 3 ? 'too short' : null);
    render(<PromptModal open onOpenChange={noop} title="x" label="L" defaultValue="ab" validate={validate} onSubmit={noop} />);
    expect((screen.getByRole('button', { name: 'Submit' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'abcd' } });
    expect((screen.getByRole('button', { name: 'Submit' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('submit calls onSubmit with the trimmed value and closes on resolve', async () => {
    const onSubmit = vi.fn(async () => {});
    const onOpenChange = vi.fn();
    render(<PromptModal open onOpenChange={onOpenChange} title="x" label="L" defaultValue="  spaced  " onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith('spaced'));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('pressing Enter in the form submits', async () => {
    const onSubmit = vi.fn(async () => {});
    render(<PromptModal open onOpenChange={noop} title="x" label="L" defaultValue="name" onSubmit={onSubmit} />);
    const input = screen.getByRole('textbox');
    // Submitting the form is what Enter triggers; fire submit on the form directly.
    fireEvent.submit(input.closest('form')!);
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith('name'));
  });

  it('keeps the dialog open and shows the error message when onSubmit throws', async () => {
    const onOpenChange = vi.fn();
    const onSubmit = vi.fn(async () => { throw new Error('save exploded'); });
    render(<PromptModal open onOpenChange={onOpenChange} title="x" label="L" defaultValue="name" onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    await waitFor(() => expect(screen.getByText('save exploded')).toBeTruthy());
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it('honours custom submit/cancel labels and Cancel closes the dialog', () => {
    const onOpenChange = vi.fn();
    render(
      <PromptModal
        open
        onOpenChange={onOpenChange}
        title="x"
        label="L"
        submitLabel="Rename"
        cancelLabel="Nevermind"
        defaultValue="n"
        onSubmit={noop}
      />,
    );
    expect(screen.getByRole('button', { name: 'Rename' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Nevermind' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
