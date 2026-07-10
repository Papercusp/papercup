// @vitest-environment jsdom
/**
 * Tests for the harness <Button> primitive — the size × variant class mapping,
 * className composition, `asChild` slotting onto a link, type default/override,
 * ref forwarding, and prop passthrough. Pure presentational, so a render + DOM
 * assertions.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { createRef } from 'react';
import { Button, type ButtonVariant } from './Button';

afterEach(() => cleanup());

describe('Button', () => {
  it('renders children and defaults to type="button" and the base class', () => {
    render(<Button>Click me</Button>);
    const btn = screen.getByRole('button', { name: 'Click me' });
    expect(btn.getAttribute('type')).toBe('button');
    // `neutral` + `sm` are the base look — they add no class of their own.
    expect(btn.className).toBe('pc-btn');
  });

  it.each([
    ['neutral', 'pc-btn'],
    ['accent', 'pc-btn pc-btn-accent'],
    ['primary', 'pc-btn pc-btn-primary'],
    ['destructive', 'pc-btn pc-btn-destructive'],
    ['ghost', 'pc-btn pc-btn-ghost'],
  ] as [ButtonVariant, string][])('maps variant=%s to "%s"', (variant, cls) => {
    render(<Button variant={variant}>Label</Button>);
    expect(screen.getByRole('button').className).toBe(cls);
  });

  it('adds the size class only for size="lg", before the variant class', () => {
    render(<Button size="lg" variant="primary">Label</Button>);
    expect(screen.getByRole('button').className).toBe('pc-btn pc-btn-lg pc-btn-primary');
  });

  it('composes size + variant with a caller className', () => {
    render(<Button size="lg" variant="primary" className="extra">Label</Button>);
    expect(screen.getByRole('button').className).toBe('pc-btn pc-btn-lg pc-btn-primary extra');
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

  describe('asChild', () => {
    it('renders the child element instead of a button, merging the classes', () => {
      render(
        <Button asChild size="lg" variant="primary">
          <a href="/cupboard">Browse</a>
        </Button>,
      );
      expect(screen.queryByRole('button')).toBeNull();
      const link = screen.getByRole('link', { name: 'Browse' });
      expect(link.tagName).toBe('A');
      expect(link.className).toBe('pc-btn pc-btn-lg pc-btn-primary');
      expect(link.getAttribute('href')).toBe('/cupboard');
    });

    it("keeps the child's own className alongside the button classes", () => {
      render(
        <Button asChild variant="ghost">
          <a href="/x" className="mine">L</a>
        </Button>,
      );
      expect(screen.getByRole('link').className).toBe('pc-btn pc-btn-ghost mine');
    });

    it('never stamps the button-only `type` attribute onto a link', () => {
      render(
        <Button asChild>
          <a href="/x">L</a>
        </Button>,
      );
      expect(screen.getByRole('link').hasAttribute('type')).toBe(false);
    });

    it('forwards handlers onto the child', () => {
      const onClick = vi.fn();
      render(
        <Button asChild onClick={onClick}>
          <a href="/x">L</a>
        </Button>,
      );
      fireEvent.click(screen.getByRole('link'));
      expect(onClick).toHaveBeenCalledTimes(1);
    });
  });
});
