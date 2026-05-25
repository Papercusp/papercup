import { describe, expect, it } from 'vitest';
import { shouldSoftNavigate } from '../client-navigation';

describe('client navigation', () => {
  it('soft-navigates same-origin absolute and relative app routes', () => {
    expect(shouldSoftNavigate('/support', 'http://localhost:3070/harness?ws=default')).toBe(true);
    expect(shouldSoftNavigate('http://localhost:3070/settings/operator', 'http://localhost:3070/harness')).toBe(true);
    expect(shouldSoftNavigate('http://127.0.0.1:3070/settings/operator', 'http://127.0.0.1:3070/harness')).toBe(true);
  });

  it('does not soft-navigate cross-origin targets', () => {
    expect(shouldSoftNavigate('https://example.com', 'http://localhost:3070/harness')).toBe(false);
    expect(shouldSoftNavigate('http://localhost:3055/harness', 'http://localhost:3070/harness')).toBe(false);
  });

  it('fails closed on unsafe schemes', () => {
    expect(shouldSoftNavigate('javascript:alert(1)', 'http://localhost:3070/harness')).toBe(false);
    expect(shouldSoftNavigate('data:text/plain,hi', 'http://localhost:3070/harness')).toBe(false);
  });
});
