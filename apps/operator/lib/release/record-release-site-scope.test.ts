import { describe, expect, it } from 'vitest';
import { FULL_SITE_SCOPE, SITE_SURFACES, parseSiteScope } from './record-release-cli';

// WI-10003694 / owner #821: `--only` is the generic, agent-judged force for a regenerate. It must
// be explicit (named surfaces), justified (--reason, written to the audit log), and never the
// default — a bare regenerate still renders every surface.

describe('parseSiteScope', () => {
  it('defaults to the FULL site, unforced', () => {
    const scope = parseSiteScope(['--regenerate']);
    expect(scope).toBe(FULL_SITE_SCOPE);
    expect([...FULL_SITE_SCOPE.surfaces].sort()).toEqual([...SITE_SURFACES].sort());
    expect(FULL_SITE_SCOPE.forced).toBe(false);
  });

  it('accepts named surfaces with a reason, as a forced scope', () => {
    const scope = parseSiteScope(['--regenerate', '--only', 'index,changes', '--reason', 'instructions text only']);
    expect('error' in scope).toBe(false);
    if ('error' in scope) return;
    expect([...scope.surfaces].sort()).toEqual(['changes', 'index']);
    expect(scope.forced).toBe(true);
    expect(scope.reason).toBe('instructions text only');
  });

  it('refuses --only without a meaningful --reason', () => {
    expect(parseSiteScope(['--only', 'index'])).toHaveProperty('error');
    expect(parseSiteScope(['--only', 'index', '--reason', 'x'])).toHaveProperty('error');
  });

  it('refuses unknown or missing surfaces', () => {
    expect(parseSiteScope(['--only', 'index,everything', '--reason', 'long enough'])).toHaveProperty('error');
    expect(parseSiteScope(['--only', '--reason', 'long enough'])).toHaveProperty('error');
  });
});
