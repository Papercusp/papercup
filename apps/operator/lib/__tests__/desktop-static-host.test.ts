import { describe, expect, it } from 'vitest';
import { isStaticDesktopHost } from '../ui/desktop-static-host';

describe('static desktop host detection', () => {
  it('matches the static desktop hosts', () => {
    expect(isStaticDesktopHost('http://localhost:3070')).toBe(true);
    expect(isStaticDesktopHost('http://127.0.0.1:3070')).toBe(true);
    expect(isStaticDesktopHost('http://localhost:4173')).toBe(true);
    expect(isStaticDesktopHost('http://127.0.0.1:4173')).toBe(true);
  });

  it('does not match the live HMR/web host', () => {
    expect(isStaticDesktopHost('http://localhost:3055')).toBe(false);
  });
});
