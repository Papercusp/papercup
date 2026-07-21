// @vitest-environment jsdom
/**
 * ErrorDetail — the console-quality error surface shared by the three
 * boundaries (owner report 2026-07-21: the popup showed only React's minified
 * reconciler frames, which name nothing; the message + react.dev decode link +
 * component stack were dropped). These assert the useful parts are surfaced.
 */
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { ErrorDetail, errorMessage, errorStack } from './ErrorDetail';

describe('errorMessage / errorStack', () => {
  it('reads Error.message + Error.stack', () => {
    const e = new Error('boom');
    expect(errorMessage(e)).toBe('boom');
    expect(errorStack(e)).toContain('boom');
  });
  it('handles a bare string throw', () => {
    expect(errorMessage('just a string')).toBe('just a string');
    expect(errorStack('just a string')).toBe('');
  });
  it('handles null / undefined without throwing', () => {
    expect(errorMessage(null)).toBe('');
    expect(errorMessage(undefined)).toBe('');
  });
});

describe('ErrorDetail', () => {
  it('surfaces the message, linkifies the react.dev decode URL, and shows the component stack', () => {
    const err = new Error(
      'Minified React error #306; visit https://react.dev/errors/306?args[]=Foo for the full message',
    );
    render(<ErrorDetail error={err} componentStack={'\n    in Foo\n    in Bar'} />);

    // The actual message is shown (the ONLY human-decodable form of #306) —
    // not just the minified stack.
    expect(screen.getByTestId('error-detail-message').textContent).toContain(
      'Minified React error #306',
    );
    // The decode URL is a real, clickable link.
    const link = screen.getByRole('link') as HTMLAnchorElement;
    expect(link.href).toContain('react.dev/errors/306');
    expect(link.getAttribute('target')).toBe('_blank');
    // The component stack (which NAMES the broken component) is surfaced.
    expect(screen.getByTestId('error-detail-component-stack').textContent).toContain('in Foo');
    // And there's a copy affordance.
    expect(screen.getByTestId('error-detail-copy')).toBeTruthy();
  });

  it('omits the component-stack block when none was captured (router-default path)', () => {
    render(<ErrorDetail error={new Error('plain boom')} />);
    expect(screen.getByTestId('error-detail-message').textContent).toContain('plain boom');
    expect(screen.queryByTestId('error-detail-component-stack')).toBeNull();
  });

  it('renders nothing scary for a null error (no message, no copy)', () => {
    render(<ErrorDetail error={null} />);
    expect(screen.queryByTestId('error-detail-message')).toBeNull();
    expect(screen.queryByTestId('error-detail-copy')).toBeNull();
  });
});
