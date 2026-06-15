/**
 * headroom.test.ts — the deploy-accounts pool view's rate-headroom helpers.
 */
import { describe, expect, it } from 'vitest';
import {
  formatResetIn,
  isActiveAccount,
  setupTokenCommand,
  utilizationTone,
} from './headroom';

describe('utilizationTone', () => {
  it('is ok below 70, warn in 70–89, bad at/above 90', () => {
    expect(utilizationTone(0)).toBe('ok');
    expect(utilizationTone(69)).toBe('ok');
    expect(utilizationTone(70)).toBe('warn');
    expect(utilizationTone(89)).toBe('warn');
    expect(utilizationTone(90)).toBe('bad');
    expect(utilizationTone(101)).toBe('bad'); // over the 5h budget
  });

  it('treats missing data (undefined) as ok rather than alarming', () => {
    expect(utilizationTone(undefined)).toBe('ok');
  });
});

describe('formatResetIn', () => {
  it('renders seconds, minutes, hours, and hours+minutes', () => {
    expect(formatResetIn(45)).toBe('45s');
    expect(formatResetIn(600)).toBe('10m');
    expect(formatResetIn(3600)).toBe('1h');
    expect(formatResetIn(3600 + 180)).toBe('1h 3m');
  });

  it('renders "now" for zero / past / unknown', () => {
    expect(formatResetIn(0)).toBe('now');
    expect(formatResetIn(-5)).toBe('now');
    expect(formatResetIn(undefined)).toBe('now');
  });
});

describe('setupTokenCommand', () => {
  it('interpolates a valid id into the isolated config dir', () => {
    expect(setupTokenCommand('aviynw11')).toBe(
      'CLAUDE_CONFIG_DIR="$HOME/.claude-deploy-aviynw11" claude setup-token',
    );
  });

  it('degrades an empty or unsafe id to the <id> placeholder (no injection)', () => {
    expect(setupTokenCommand('')).toContain('.claude-deploy-<id>');
    expect(setupTokenCommand('bad id; rm -rf /')).toContain('.claude-deploy-<id>');
  });
});

describe('isActiveAccount', () => {
  it('matches the gateway-bound account only when the gateway is reachable', () => {
    expect(isActiveAccount({ reachable: true, accountId: 'a' }, 'a')).toBe(true);
    expect(isActiveAccount({ reachable: true, accountId: 'a' }, 'b')).toBe(false);
    expect(isActiveAccount({ reachable: false, accountId: 'a' }, 'a')).toBe(false);
    expect(isActiveAccount(null, 'a')).toBe(false);
  });
});
