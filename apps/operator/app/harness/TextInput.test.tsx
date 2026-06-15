// @vitest-environment jsdom
//
// TextInput / TextArea — the canonical text-entry primitives. Pure-render
// presentational components (no app deps): assert the class hook, the
// leading/trailing slot wrapper branch, ref forwarding, and that arbitrary
// input attrs (type, placeholder, value) pass through to the native element.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRef } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { TextInput, TextArea } from './TextInput';

afterEach(cleanup);

describe('<TextInput />', () => {
  it('renders a bare input (no wrapper) when there is no leading/trailing slot', () => {
    const { container } = render(<TextInput placeholder="name" />);
    const input = container.querySelector('input');
    expect(input).not.toBeNull();
    // The class hook is present and there is NO wrapper div around the input.
    expect(input!.classList.contains('pc-text-input')).toBe(true);
    expect(container.querySelector('.pc-text-input-wrap')).toBeNull();
    expect(input!.getAttribute('placeholder')).toBe('name');
  });

  it('merges a caller className onto the base class hook', () => {
    const { container } = render(<TextInput className="mine" />);
    const input = container.querySelector('input')!;
    expect(input.classList.contains('pc-text-input')).toBe(true);
    expect(input.classList.contains('mine')).toBe(true);
  });

  it('wraps the input in a slot container when a leading element is provided', () => {
    const { container } = render(<TextInput leading={<span data-testid="lead">@</span>} />);
    const wrap = container.querySelector('.pc-text-input-wrap');
    expect(wrap).not.toBeNull();
    // The leading node renders inside the wrapper alongside the input.
    expect(screen.getByTestId('lead')).toBeTruthy();
    expect(wrap!.querySelector('input')).not.toBeNull();
  });

  it('renders trailing slot content', () => {
    render(<TextInput trailing={<span data-testid="trail">ms</span>} />);
    expect(screen.getByTestId('trail').textContent).toBe('ms');
  });

  it('passes native attrs (type, value, onChange) through to the input element', () => {
    const onChange = vi.fn();
    const { container } = render(
      <TextInput type="number" value={5} onChange={onChange} readOnly />,
    );
    const input = container.querySelector('input') as HTMLInputElement;
    expect(input.type).toBe('number');
    expect(input.value).toBe('5');
  });

  it('forwards the ref to the underlying input element', () => {
    const ref = createRef<HTMLInputElement>();
    render(<TextInput ref={ref} />);
    expect(ref.current).toBeInstanceOf(HTMLInputElement);
  });
});

describe('<TextArea />', () => {
  it('renders a textarea with the shared class hook and passes attrs through', () => {
    const { container } = render(<TextArea placeholder="notes" rows={4} />);
    const ta = container.querySelector('textarea') as HTMLTextAreaElement;
    expect(ta).not.toBeNull();
    expect(ta.classList.contains('pc-text-input')).toBe(true);
    expect(ta.getAttribute('placeholder')).toBe('notes');
    expect(ta.rows).toBe(4);
  });

  it('forwards the ref to the underlying textarea element', () => {
    const ref = createRef<HTMLTextAreaElement>();
    render(<TextArea ref={ref} />);
    expect(ref.current).toBeInstanceOf(HTMLTextAreaElement);
  });
});
