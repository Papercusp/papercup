import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { gateSite, main, resolveSubset } from './gate-release-site';
import type { IdentityLiteral } from './release-content-scrub';

// WI-10003694: an incremental publish gates exactly the files it uploads (`--files-from`). The
// subset gate must still FAIL on a leak in a listed file, and must refuse — never silently
// skip — a listed path it cannot read.

const FAKE_HOME = ['/home', 'jdoe'].join('/');
const LITS: IdentityLiteral[] = [
  { kind: 'home', value: FAKE_HOME },
  { kind: 'user', value: 'jdoe' },
  { kind: 'git-name', value: 'Jane' },
];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-subset-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function site(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(tmp, 'site-'));
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body, 'utf8');
  }
  return dir;
}

function list(rels: string[]): string {
  const file = path.join(tmp, `list-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(file, `${rels.join('\n')}\n`);
  return file;
}

describe('gate-release-site --files-from', () => {
  const dir = site({
    'index.html': '<p>clean</p>',
    'work-items/WI-1.html': `<p>run ${FAKE_HOME}/x</p>`,
    'work-items/WI-2.html': '<p>clean too</p>',
  });

  it('catches a leak in a LISTED file (positive control: the subset gate can fail)', () => {
    const leaks = gateSite(dir, LITS, ['index.html', 'work-items/WI-1.html']);
    expect(leaks.map((leak) => leak.file)).toContain(path.join('work-items', 'WI-1.html'));
  });

  it('scans only the listed files', () => {
    expect(gateSite(dir, LITS, ['index.html', 'work-items/WI-2.html'])).toEqual([]);
  });

  it('refuses a listed path that is missing or escapes the site root', () => {
    expect(() => resolveSubset(dir, ['work-items/WI-404.html'])).toThrow(/not a file/);
    expect(() => resolveSubset(dir, ['../outside.html'])).toThrow(/escapes/);
  });

  it('main(): exit 1 on a listed leak, 0 on a clean subset, 2 when it could not check', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(main([dir, '--files-from', list(['work-items/WI-1.html'])], LITS)).toBe(1);
      expect(main([dir, '--files-from', list(['index.html'])], LITS)).toBe(0);
      expect(log.mock.calls.flat().join('\n')).toMatch(/1 page\(s\) scanned/);
      expect(main([dir, '--files-from', list(['nope.html'])], LITS)).toBe(2);
      expect(main([dir, '--files-from', path.join(tmp, 'no-such-list')], LITS)).toBe(2);
    } finally {
      err.mockRestore();
      log.mockRestore();
    }
  });
});
