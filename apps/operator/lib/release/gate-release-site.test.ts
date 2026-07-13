import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { gateSite } from './gate-release-site';
import type { IdentityLiteral } from './release-content-scrub';

// A stand-in owner — never the real one (putting his name in a source file to test
// for it would BE the leak, committed to git).
const LITS: IdentityLiteral[] = [
  { kind: 'home', value: '/home/jdoe' },
  { kind: 'user', value: 'jdoe' },
  { kind: 'git-name', value: 'Jane' },
];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-site-'));
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

describe('gateSite — it must be able to FAIL, or it is not a gate', () => {
  it('passes a clean site', () => {
    const dir = site({
      'index.html': '<h1>Papercusp releases</h1><p>Download the installer.</p>',
      'plans/a.html': '<h1>A plan</h1><p>Run <code>~/.papercusp/thing.sh</code></p>',
    });
    expect(gateSite(dir, LITS)).toEqual([]);
  });

  it('catches the home path in a nested plan page, and says WHERE', () => {
    const dir = site({
      'index.html': '<h1>clean</h1>',
      'plans/leaky.html': '<h1>A plan</h1>\n<p>Run bash /home/jdoe/.papercusp/x.sh now</p>',
    });
    const leaks = gateSite(dir, LITS);
    expect(leaks.length).toBeGreaterThan(0);
    expect(leaks[0].file).toBe(path.join('plans', 'leaky.html'));
    expect(leaks[0].sample).toContain('/home/jdoe');
  });

  it('catches an email nobody enumerated — the leak that actually shipped', () => {
    // The gate knows this box's git identity. It did NOT know the owner's personal
    // gmail address, which is what plan frontmatter carried onto a real page. The
    // shape-based patterns are why this now fails instead of publishing.
    const dir = site({ 'index.html': '<p>owner: someone-we-never-heard-of@gmail.com</p>' });
    const leaks = gateSite(dir, LITS);
    expect(leaks.map((l) => l.kind)).toContain('email');
  });

  it('gates history.json too — it is published, so it is in scope', () => {
    // The app FETCHES this file. A gate that only reads .html would let the same
    // changelog prose through in the feed while blocking it on the page.
    const dir = site({
      'index.html': '<h1>clean</h1>',
      'history.json': JSON.stringify({ releases: [{ notes: 'Thanks to Jane for the report.' }] }),
    });
    const leaks = gateSite(dir, LITS);
    expect(leaks.map((l) => l.file)).toContain('history.json');
    expect(leaks.map((l) => l.kind)).toContain('git-name');
  });

  it('ignores files we do not publish', () => {
    const dir = site({
      'index.html': '<h1>clean</h1>',
      'notes.txt': 'this mentions /home/jdoe but is not published and is never uploaded',
    });
    expect(gateSite(dir, LITS)).toEqual([]);
  });
});
