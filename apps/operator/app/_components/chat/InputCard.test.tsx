// @vitest-environment jsdom
/**
 * InputCard tests — text, date, slider presentations.
 *
 * Plan: bespoke-card-improvements-2026-05-13.md §6
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { InputCard } from './InputCard';

afterEach(() => cleanup());

describe('InputCard — text', () => {
  it('submit disabled until value typed; submits typed string', () => {
    const onResponse = vi.fn();
    render(
      <InputCard
        prompt="What's your name?"
        presentation={{ kind: 'text', placeholder: 'name' }}
        onResponse={onResponse}
      />,
    );
    const submit = screen.getByRole('button', { name: 'Submit' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    const input = screen.getByLabelText('response') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'alice' } });
    expect(submit.disabled).toBe(false);

    fireEvent.click(submit);
    expect(onResponse).toHaveBeenCalledWith({ action: 'submit', value: 'alice' });
  });

  it('Enter key submits without Shift; Shift+Enter does not', () => {
    const onResponse = vi.fn();
    render(
      <InputCard
        prompt="x"
        presentation={{ kind: 'text' }}
        onResponse={onResponse}
      />,
    );
    const input = screen.getByLabelText('response');
    fireEvent.change(input, { target: { value: 'hi' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(onResponse).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onResponse).toHaveBeenCalledWith({ action: 'submit', value: 'hi' });
  });

  it('multiline:true renders a textarea, not an input', () => {
    const { container } = render(
      <InputCard
        prompt="x"
        presentation={{ kind: 'text', multiline: true }}
        onResponse={vi.fn()}
      />,
    );
    expect(container.querySelector('textarea')).toBeTruthy();
    expect(container.querySelector('input[type="text"]')).toBeNull();
  });

  it('Skip fires action:decline when allowDecline (default)', () => {
    const onResponse = vi.fn();
    render(
      <InputCard
        prompt="x"
        presentation={{ kind: 'text' }}
        onResponse={onResponse}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /^Skip$/ }));
    expect(onResponse).toHaveBeenCalledWith({ action: 'decline' });
  });

  it('allowDecline:false hides Skip', () => {
    render(
      <InputCard
        prompt="x"
        presentation={{ kind: 'text' }}
        onResponse={vi.fn()}
        allowDecline={false}
      />,
    );
    expect(screen.queryByRole('button', { name: /^Skip$/ })).toBeNull();
  });
});

describe('InputCard — date', () => {
  it('submits an ISO yyyy-mm-dd string', () => {
    const onResponse = vi.fn();
    const { container } = render(
      <InputCard
        prompt="When?"
        presentation={{ kind: 'date', min: '2024-01-01', max: '2030-12-31' }}
        onResponse={onResponse}
      />,
    );
    const input = container.querySelector('input[type="date"]') as HTMLInputElement;
    expect(input.min).toBe('2024-01-01');
    expect(input.max).toBe('2030-12-31');
    fireEvent.change(input, { target: { value: '2026-07-04' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    expect(onResponse).toHaveBeenCalledWith({ action: 'submit', value: '2026-07-04' });
  });

  it('submit disabled until a date is picked', () => {
    render(
      <InputCard
        prompt="x"
        presentation={{ kind: 'date' }}
        onResponse={vi.fn()}
      />,
    );
    expect((screen.getByRole('button', { name: 'Submit' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('InputCard — slider', () => {
  it('initial value is the midpoint, rounded to step', () => {
    render(
      <InputCard
        prompt="Quality"
        presentation={{ kind: 'slider', min: 0, max: 10, step: 1 }}
        onResponse={vi.fn()}
      />,
    );
    const out = document.querySelector('.input-card-slider-value');
    expect(out?.textContent).toBe('5');
  });

  it('submits the current numeric value', () => {
    const onResponse = vi.fn();
    render(
      <InputCard
        prompt="x"
        presentation={{ kind: 'slider', min: 0, max: 100, step: 5 }}
        onResponse={onResponse}
      />,
    );
    const range = screen.getByLabelText('value') as HTMLInputElement;
    fireEvent.change(range, { target: { value: '75' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    expect(onResponse).toHaveBeenCalledWith({ action: 'submit', value: 75 });
  });

  it('respects min/max/step on the range input', () => {
    const { container } = render(
      <InputCard
        prompt="x"
        presentation={{ kind: 'slider', min: 5, max: 25, step: 5 }}
        onResponse={vi.fn()}
      />,
    );
    const range = container.querySelector('input[type="range"]') as HTMLInputElement;
    expect(range.min).toBe('5');
    expect(range.max).toBe('25');
    expect(range.step).toBe('5');
    // initial = round(15/5)*5 = 15
    expect(range.value).toBe('15');
  });
});
