import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverOperatorUrl, resolveOperatorBase } from '../scripts/operator-discovery.mjs';

// The sidecar CLIs (onboard, tutorial-runner, ptool) must reach the PACKAGED
// desktop operator, which listens on a per-boot dynamic port recorded in
// ~/.papercusp/operator.json — a bare :3070 default only works on the dev box.
// Owner hit the regression live on the seeded mac install (WI-2903 thread):
// "can't reach papercusp server at 127.0.0.1:3070".

const tmpHomes: string[] = [];
function homeWithOperatorJson(content: string | null): string {
  const home = mkdtempSync(join(tmpdir(), 'opdisc-'));
  tmpHomes.push(home);
  if (content !== null) {
    mkdirSync(join(home, '.papercusp'), { recursive: true });
    writeFileSync(join(home, '.papercusp', 'operator.json'), content);
  }
  return home;
}

afterEach(() => {
  for (const h of tmpHomes.splice(0)) rmSync(h, { recursive: true, force: true });
});

describe('discoverOperatorUrl', () => {
  it('returns httpUrl from operator.json (the packaged-desktop path)', () => {
    const home = homeWithOperatorJson(JSON.stringify({ httpUrl: 'http://127.0.0.1:20114', port: 20114 }));
    expect(discoverOperatorUrl({ home })).toBe('http://127.0.0.1:20114');
  });

  it('falls back to port when httpUrl is absent', () => {
    const home = homeWithOperatorJson(JSON.stringify({ port: 20114 }));
    expect(discoverOperatorUrl({ home })).toBe('http://127.0.0.1:20114');
  });

  it('returns null when operator.json is missing (the dev box)', () => {
    const home = homeWithOperatorJson(null);
    expect(discoverOperatorUrl({ home })).toBeNull();
  });

  it('returns null on unparseable operator.json', () => {
    const home = homeWithOperatorJson('not json');
    expect(discoverOperatorUrl({ home })).toBeNull();
  });
});

describe('resolveOperatorBase precedence', () => {
  it('explicit --operator-url arg wins over everything', () => {
    const home = homeWithOperatorJson(JSON.stringify({ httpUrl: 'http://127.0.0.1:20114' }));
    expect(
      resolveOperatorBase({ operatorUrl: 'http://x:1/' }, { PAPERCUSP_OPERATOR_URL: 'http://y:2' }, { home }),
    ).toBe('http://x:1');
  });

  it('env override beats operator.json discovery', () => {
    const home = homeWithOperatorJson(JSON.stringify({ httpUrl: 'http://127.0.0.1:20114' }));
    expect(resolveOperatorBase({}, { PAPERCUSP_OPERATOR_URL: 'http://y:2/' }, { home })).toBe('http://y:2');
  });

  it('operator.json discovery beats the :3070 dev fallback', () => {
    const home = homeWithOperatorJson(JSON.stringify({ httpUrl: 'http://127.0.0.1:20114' }));
    expect(resolveOperatorBase({}, {}, { home })).toBe('http://127.0.0.1:20114');
  });

  it('lands on :3070 only when nothing else resolves (dev box)', () => {
    const home = homeWithOperatorJson(null);
    expect(resolveOperatorBase({}, {}, { home })).toBe('http://127.0.0.1:3070');
  });
});
