// @vitest-environment jsdom
/**
 * Tests for the harness <Button> primitive — variant→class mapping, the
 * className composition rules, type default/override, ref forwarding, and
 * prop passthrough. Pure presentational, so a render + DOM assertions.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { createRef } from 'react';
import { Button, type ButtonVariant } from './Button';

afterEach(() => cleanup());

describe('Button', () => {
  it('renders children and defaults to type="button" with no class', () => {
    render(<Button>Click me</Button>);
    const btn = screen.getByRole('button', { name: 'Click me' });
    expect(btn.getAttribute('type')).toBe('button');
    expect(btn.className).toBe('');
  });

  it.each([
    ['primary', 'pc-btn-primary'],
    ['destructive', 'pc-btn-destructive'],
    ['ghost', 'pc-btn-ghost'],
  ] as [ButtonVariant, string][])('maps variant=%s to %s', (variant, cls) => {
    render(<Button variant={variant}>Label</Button>);
    expect(screen.getByRole('button').className).toBe(cls);
  });

  it('composes the variant class with a caller className', () => {
    render(<Button variant="primary" className="extra">Label</Button>);
    expect(screen.getByRole('button').className).toBe('pc-btn-primary extra');
  });

  it('uses only the caller className when no variant is given', () => {
    render(<Button className="just-mine">Label</Button>);
    expect(screen.getByRole('button').className).toBe('just-mine');
  });

  it('honours a type override', () => {
    render(<Button type="submit">Submit</Button>);
    expect(screen.getByRole('button').getAttribute('type')).toBe('submit');
  });

  it('forwards arbitrary props (onClick fires)', () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Go</Button>);
    fireEvent.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('passes through the disabled attribute', () => {
    render(<Button disabled>Nope</Button>);
    expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true);
  });

  it('forwards the ref to the underlying button element', () => {
    const ref = createRef<HTMLButtonElement>();
    render(<Button ref={ref}>R</Button>);
    expect(ref.current).toBeInstanceOf(HTMLButtonElement);
    expect(ref.current?.textContent).toBe('R');
  });
});
