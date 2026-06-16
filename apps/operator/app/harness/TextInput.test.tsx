// @vitest-environment jsdom
/**
 * Tests for TextInput and TextArea primitives — bare input, with slots,
 * class composition, ref forwarding, and state changes.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { createRef } from 'react';
import { TextInput, TextArea } from './TextInput';

afterEach(() => cleanup());

describe('TextInput', () => {
  it('renders a bare input with default styles', () => {
    render(<TextInput placeholder="Enter text" />);
    const input = screen.getByPlaceholderText('Enter text') as HTMLInputElement;
    expect(input).toBeInstanceOf(HTMLInputElement);
    expect(input.type).toBe('text');
    expect(input.className).toBe('pc-text-input');
  });

  it('applies custom className to bare input', () => {
    render(<TextInput className="custom-class" placeholder="Test" />);
    const input = screen.getByPlaceholderText('Test');
    expect(input.className).toBe('pc-text-input custom-class');
  });

  it('renders with leading slot wrapping the input', () => {
    render(<TextInput leading={<span>$</span>} placeholder="Amount" />);
    const input = screen.getByPlaceholderText('Amount') as HTMLInputElement;
    const wrap = input.closest('.pc-text-input-wrap');
    expect(wrap).toBeDefined();
    expect(wrap?.textContent).toContain('$');
  });

  it('renders with trailing slot wrapping the input', () => {
    render(<TextInput trailing={<span>%</span>} placeholder="Percent" />);
    const input = screen.getByPlaceholderText('Percent') as HTMLInputElement;
    const wrap = input.closest('.pc-text-input-wrap');
    expect(wrap).toBeDefined();
    expect(wrap?.textContent).toContain('%');
  });

  it('renders with both leading and trailing slots', () => {
    render(
      <TextInput
        leading={<span>🔍</span>}
        trailing={<button>Clear</button>}
        placeholder="Search"
      />
    );
    const input = screen.getByPlaceholderText('Search');
    const wrap = input.closest('.pc-text-input-wrap');
    expect(wrap?.textContent).toContain('🔍');
    expect(wrap?.textContent).toContain('Clear');
  });

  it('applies className to the wrapper when slots are present', () => {
    render(
      <TextInput
        leading={<span>@</span>}
        className="email-input"
        placeholder="Email"
      />
    );
    const input = screen.getByPlaceholderText('Email') as HTMLInputElement;
    const wrap = input.closest('.pc-text-input-wrap');
    expect(wrap?.className).toContain('email-input');
  });

  it('updates value and fires onChange events', () => {
    render(<TextInput placeholder="Type here" />);
    const input = screen.getByPlaceholderText('Type here') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'hello' } });
    expect(input.value).toBe('hello');
  });

  it('respects type prop for variants (email, number, etc.)', () => {
    const { rerender } = render(<TextInput type="email" placeholder="Email" />);
    expect((screen.getByPlaceholderText('Email') as HTMLInputElement).type).toBe('email');

    cleanup();
    rerender(<TextInput type="number" placeholder="Count" />);
    expect((screen.getByPlaceholderText('Count') as HTMLInputElement).type).toBe('number');

    cleanup();
    rerender(<TextInput type="password" placeholder="Pass" />);
    expect((screen.getByPlaceholderText('Pass') as HTMLInputElement).type).toBe('password');
  });

  it('respects disabled attribute', () => {
    render(<TextInput disabled placeholder="Disabled" />);
    expect((screen.getByPlaceholderText('Disabled') as HTMLInputElement).disabled).toBe(true);
  });

  it('forwards ref to the input element', () => {
    const ref = createRef<HTMLInputElement>();
    render(<TextInput ref={ref} placeholder="Ref test" />);
    expect(ref.current).toBeInstanceOf(HTMLInputElement);
    expect(ref.current?.placeholder).toBe('Ref test');
  });

  it('passes through arbitrary HTML attributes', () => {
    render(
      <TextInput
        placeholder="Test"
        required
        minLength={5}
        maxLength={20}
        data-testid="custom-id"
      />
    );
    const input = screen.getByTestId('custom-id') as HTMLInputElement;
    expect(input.required).toBe(true);
    expect(input.minLength).toBe(5);
    expect(input.maxLength).toBe(20);
  });

  it('renders input inside wrapper with correct flexbox layout when slots present', () => {
    render(
      <TextInput
        leading={<span data-testid="lead">L</span>}
        trailing={<span data-testid="trail">T</span>}
        placeholder="Test"
      />
    );
    const input = screen.getByPlaceholderText('Test') as HTMLInputElement;
    const wrap = input.closest('.pc-text-input-wrap') as HTMLDivElement;
    const style = window.getComputedStyle(wrap);
    expect(style.display).toBe('inline-flex');
    expect(style.alignItems).toBe('center');
  });
});

describe('TextArea', () => {
  it('renders a textarea with default styles', () => {
    render(<TextArea placeholder="Enter description" />);
    const textarea = screen.getByPlaceholderText('Enter description') as HTMLTextAreaElement;
    expect(textarea).toBeInstanceOf(HTMLTextAreaElement);
    expect(textarea.className).toBe('pc-text-input');
  });

  it('applies custom className', () => {
    render(<TextArea className="custom" placeholder="Text" />);
    const textarea = screen.getByPlaceholderText('Text');
    expect(textarea.className).toBe('pc-text-input custom');
  });

  it('allows value changes and fires onChange', () => {
    render(<TextArea placeholder="Editable" />);
    const textarea = screen.getByPlaceholderText('Editable') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'multi\nline' } });
    expect(textarea.value).toBe('multi\nline');
  });

  it('respects disabled attribute', () => {
    render(<TextArea disabled placeholder="Disabled" />);
    expect((screen.getByPlaceholderText('Disabled') as HTMLTextAreaElement).disabled).toBe(true);
  });

  it('respects rows and cols attributes', () => {
    render(<TextArea rows={5} cols={40} placeholder="Sized" />);
    const textarea = screen.getByPlaceholderText('Sized') as HTMLTextAreaElement;
    expect(textarea.rows).toBe(5);
    expect(textarea.cols).toBe(40);
  });

  it('forwards ref to the textarea element', () => {
    const ref = createRef<HTMLTextAreaElement>();
    render(<TextArea ref={ref} placeholder="Ref test" />);
    expect(ref.current).toBeInstanceOf(HTMLTextAreaElement);
    expect(ref.current?.placeholder).toBe('Ref test');
  });

  it('passes through arbitrary HTML attributes', () => {
    render(
      <TextArea
        placeholder="Test"
        required
        minLength={10}
        maxLength={500}
        data-testid="custom-id"
        spellCheck="true"
      />
    );
    const textarea = screen.getByTestId('custom-id') as HTMLTextAreaElement;
    expect(textarea.required).toBe(true);
    expect(textarea.minLength).toBe(10);
    expect(textarea.maxLength).toBe(500);
    expect(textarea.spellCheck).toBe(true);
  });

  it('allows resize vertical by default', () => {
    render(<TextArea placeholder="Resizable" />);
    const textarea = screen.getByPlaceholderText('Resizable') as HTMLTextAreaElement;
    const style = window.getComputedStyle(textarea);
    expect(style.resize).toBe('vertical');
  });

  it('respects inline style overrides', () => {
    render(
      <TextArea
        placeholder="Styled"
        style={{ minHeight: 200, fontFamily: 'monospace' }}
      />
    );
    const textarea = screen.getByPlaceholderText('Styled') as HTMLTextAreaElement;
    const style = window.getComputedStyle(textarea);
    expect(style.minHeight).toBe('200px');
    expect(style.fontFamily).toBe('monospace');
  });
});
