import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gateSite, main } from './gate-release-site';
import {
  HOLDING_PAGE_MARKER,
  OWNER_NAME_ENV,
  PUBLISHED_CONTACT_EMAIL,
  hasOwnerNameLiteral,
  identityLiterals,
  looksLikeAutomationIdentity,
  type IdentityLiteral,
} from './release-content-scrub';

// A stand-in owner — never the real one (putting his name in a source file to test
// for it would BE the leak, committed to git).
const FAKE_HOME = ['/home', 'jdoe'].join('/');
const GRAPHVIZ_VIRTUAL_HOME = ['/home', 'web_user'].join('/');
const LITS: IdentityLiteral[] = [
  { kind: 'home', value: FAKE_HOME },
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
  it('distinguishes the vendor video-extension registry from identity text', () => {
    const vendor = 'assets/vditor/dist/js/lute/lute.min.js';
    const formats = '["mov","avi","wmv"]';
    const literals: IdentityLiteral[] = [{ kind: 'git-name', value: 'mov' }];
    expect(gateSite(site({ [vendor]: formats }), literals)).toEqual([]);
    expect(gateSite(site({ [vendor]: `${formats}; const owner = "mov";` }), literals).length).toBeGreaterThan(0);
    expect(gateSite(site({ 'other.js': formats }), literals).length).toBeGreaterThan(0);
  });
  it('checks renderer JS/CSS and only permits the vendor virtual filesystem home', () => {
    const virtual = 'assets/vditor/dist/js/graphviz/full.render.js';
    expect(gateSite(site({ [virtual]: `FS.mkdir("${GRAPHVIZ_VIRTUAL_HOME}");` }), LITS)).toEqual([]);
    const leaks = gateSite(site({
      [virtual]: `FS.mkdir("${GRAPHVIZ_VIRTUAL_HOME}"); const build = "${FAKE_HOME}/work";`,
      'assets/project-history.js': 'const author = "Jane";',
      'assets/project-history.css': '/* contact: jane@example.invalid */',
    }), LITS);
    expect(new Set(leaks.map((leak) => leak.file))).toEqual(new Set([
      virtual, 'assets/project-history.js', 'assets/project-history.css',
    ]));
    expect(gateSite(site({ 'other.js': `"${GRAPHVIZ_VIRTUAL_HOME}"` }), LITS).length).toBeGreaterThan(0);
  });
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
      'plans/leaky.html': `<h1>A plan</h1>\n<p>Run bash ${FAKE_HOME}/.papercusp/x.sh now</p>`,
    });
    const leaks = gateSite(dir, LITS);
    expect(leaks.length).toBeGreaterThan(0);
    expect(leaks[0].file).toBe(path.join('plans', 'leaky.html'));
    expect(leaks[0].sample).toContain(FAKE_HOME);
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

// WI-6580. The holding page publishes ONE address on purpose. These tests exist
// to prove the exception stayed an exception — the gate's value is entirely in
// what it still REFUSES.
describe('gateSite — the holding page contact-email allowance is narrow', () => {
  const held = (extra = '') =>
    `<!doctype html><html><head>${HOLDING_PAGE_MARKER}</head>` +
    `<body><h1>NEXT UPDATE COMING SOON</h1>` +
    `<a href="mailto:${PUBLISHED_CONTACT_EMAIL}">Email us</a>${extra}</body></html>`;

  it('passes the holding page carrying the published contact address', () => {
    expect(gateSite(site({ 'index.html': held() }), LITS)).toEqual([]);
  });

  it('STILL fails the holding page on any OTHER address', () => {
    // The allowance is one literal, not "emails are fine on this page".
    const dir = site({ 'index.html': held('<p>or reach me at someone.else@example.com</p>') });
    const leaks = gateSite(dir, LITS);
    expect(leaks.map((l) => l.kind)).toContain('email');
  });

  it('STILL fails a NORMAL index.html carrying that same address', () => {
    // No holding marker ⇒ no allowance. This is the real regression risk: the
    // owner's address appearing in a work-item title or plan body on the live
    // releases page, which is the leak this whole rail was built for.
    const dir = site({
      'index.html': `<h1>Papercusp releases</h1><p>ping ${PUBLISHED_CONTACT_EMAIL}</p>`,
    });
    expect(gateSite(dir, LITS).map((l) => l.kind)).toContain('email');
  });

  it('STILL fails a PLAN page carrying that address, marker or not', () => {
    // A plan page cannot claim the allowance even if its body somehow contains
    // the marker text — the allowance is keyed on index.html too.
    const dir = site({
      'index.html': '<h1>clean</h1>',
      'plans/a.html': `${HOLDING_PAGE_MARKER}<p>owner: ${PUBLISHED_CONTACT_EMAIL}</p>`,
    });
    const leaks = gateSite(dir, LITS);
    expect(leaks.map((l) => l.file)).toContain('plans/a.html');
    expect(leaks.map((l) => l.kind)).toContain('email');
  });

  it('STILL fails history.json carrying that address', () => {
    const dir = site({
      'index.html': held(),
      'history.json': JSON.stringify({ releases: [{ notes: `mail ${PUBLISHED_CONTACT_EMAIL}` }] }),
    });
    expect(gateSite(dir, LITS).map((l) => l.file)).toContain('history.json');
  });

  it('STILL fails the holding page on a home path — only EMAIL is allowed', () => {
    const dir = site({ 'index.html': held('<p>built in /home/jdoe/papercusp</p>') });
    const kinds = gateSite(dir, LITS).map((l) => l.kind);
    expect(kinds).toContain('unix-home');
  });
});

/**
 * EI-20583328178472869 — the gate certified a page it could not inspect.
 *
 * `git config user.name` became the git-sync bot, so the owner-name literal stopped
 * resolving to a person. The scrub then redacted the name 0 times AND the gate printed
 * "[gate] CLEAN, exit 0". The failure was not that the check broke — it was that breaking
 * it produced the SAME VERDICT as passing it. So these assert the EXIT CODE, not the text.
 */
describe('main — a gate that cannot see the owner must REFUSE, not certify', () => {
  const clean = () =>
    site({ 'index.html': '<h1>Papercusp releases</h1><p>Download the installer.</p>' });

  // The refusal path writes to stderr on purpose (an operator has to SEE why publishing
  // stopped), and this suite fails any test that touches console.error — so capture it
  // and assert on it rather than merely silencing it.
  let errs: string[];
  beforeEach(() => {
    errs = [];
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
      errs.push(a.join(' '));
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it('exits 2 (cannot check) when NO owner-name literal resolves', () => {
    // The exact shape of the bug: machine literals resolve fine, the NAME does not.
    const blind: IdentityLiteral[] = [
      { kind: 'home', value: '/home/jdoe' },
      { kind: 'user', value: 'jdoe' },
    ];
    expect(main([clean()], blind)).toBe(2);
  });

  it('tells the operator HOW to proceed, naming the env var — a refusal with no exit is a wall', () => {
    main([clean()], [{ kind: 'user', value: 'jdoe' }]);
    expect(errs.join('\n')).toContain(OWNER_NAME_ENV);
  });

  it('exits 2 when a name literal is present but EMPTY — blank is not a name', () => {
    expect(main([clean()], [{ kind: 'git-name', value: '   ' }])).toBe(2);
  });

  it('still exits 0 on a clean site once an owner name IS known', () => {
    // CALIBRATION. Without this, both refusals above would also pass if `main` simply
    // always returned 2 — a gate that refuses everything is as useless as one that
    // certifies everything, and it looks far more rigorous.
    expect(main([clean()], LITS)).toBe(0);
  });

  it('keeps 1 (found leaks) DISTINCT from 2 (could not check)', () => {
    // A caller's `|| exit` cannot tell a blind gate from a clean one if these collide.
    const leaky = site({ 'index.html': '<p>built by Jane on /home/jdoe</p>' });
    expect(main([leaky], LITS)).toBe(1);
  });
});

describe('looksLikeAutomationIdentity — a bot name is not an owner name', () => {
  // NOTE: deliberately NOT this box's real bot name, even though it is the one that caused
  // the bug. The identity lint derives its literals from `git config user.name` — which IS
  // that bot right now — so writing it here would red the green-checkpoint identity leg and
  // freeze `main` for the whole fleet. `<product>-agent` exercises the identical regex
  // branch (the `-agent` suffix) without embedding the box's identity in shipped source.
  it.each(['acme-agent', 'github-actions[bot]', 'ci', 'build-bot', 'renovate[bot]'])(
    'treats %s as automation',
    (name) => expect(looksLikeAutomationIdentity(name)).toBe(true),
  );

  // The false-positive direction matters just as much: misclassifying a PERSON as a bot
  // would drop their name from the literals and fail the publish closed forever.
  it.each(['Jane', 'Jane Doe', 'Ada Lovelace', 'jdoe'])(
    'does NOT misclassify the person %s as automation',
    (name) => expect(looksLikeAutomationIdentity(name)).toBe(false),
  );
});

describe('identityLiterals — an explicit owner name overrides the box', () => {
  const saved = process.env[OWNER_NAME_ENV];
  afterAll(() => {
    if (saved === undefined) delete process.env[OWNER_NAME_ENV];
    else process.env[OWNER_NAME_ENV] = saved;
  });

  it('takes the env name as the owner-name literal, and that satisfies the gate', () => {
    // Also the answer to "would failing closed block a legitimate CI/container publish?"
    // No — automation sets this and proceeds. The gate demands an answer, not a human.
    process.env[OWNER_NAME_ENV] = 'Jane';
    const lits = identityLiterals();
    expect(lits.filter((l) => l.kind === 'git-name').map((l) => l.value)).toEqual(['Jane']);
    expect(hasOwnerNameLiteral(lits)).toBe(true);
  });
});
