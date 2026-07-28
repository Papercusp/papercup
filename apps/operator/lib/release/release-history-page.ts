/**
 * The beta release-history page — static HTML, generated at cut time from the
 * release registry, served from the R2 SECRET PATH alongside the artifacts.
 * (WI-4446. Registry: release-registry.ts. Table: migration 589.)
 *
 * [owner 2026-07-12, on who it is for]
 *   "only the people we share the link with, which will be our beta testers. we
 *    will also want to collect stats on visits to make sure it isnt leaked."
 *
 * That answer decides the whole design:
 *
 * 1. UNLISTED, NOT PUBLIC. It lives under the same secret path segment as the
 *    installers — one secret, one blast radius, and the download links on it are
 *    already under that path. No index, no nav, no robots. Every link on the page
 *    is RELATIVE, so the secret is never written into the HTML.
 *
 * 2. THE ANALYTICS ARE A LEAK DETECTOR, not a vanity counter. The owner's reason
 *    is "to make sure it isnt leaked", so a hit count is useless on its own — a
 *    leak looks like traffic, and traffic is what a beta page is supposed to have.
 *    What names a leak is the REFERRER: a visit arriving from a page we never
 *    shared the link with is the signal. So the beacon captures document.referrer.
 *
 * 3. ⛔ THE BEACON NEVER SENDS THE URL. The obvious thing — PostHog's usual
 *    `$current_url` — would write the secret path into an analytics store, where
 *    it lands in dashboards, exports and support tools. The URL IS the secret;
 *    shipping a leak detector that leaks the secret is not a detail, it is the bug.
 *    We send the page NAME (`index` / `plan`) and the referrer. Never the path.
 *
 * 4. THE CONTENT RENDERS WITH JAVASCRIPT DISABLED. Markdown is rendered to HTML
 *    HERE, at generation time — not by a client-side editor. A beta tester's job
 *    on this page is to read what changed and download an installer; if that
 *    depended on fetching a script (blocked, offline, proxied, CSP'd), the page
 *    would be BLANK exactly when someone needs it. The beacon is the only script,
 *    and it is best-effort: if it never runs, the page is still whole.
 *
 *    (This is the one place I did not take the owner's suggested route verbatim —
 *    "we can use our same vditor to display the plan". Vditor is a browser editor
 *    that pulls a Lute WASM bundle at runtime; on a static page that makes the
 *    release notes a network-dependent render. Same markdown, same source of
 *    truth, rendered one layer earlier. Disclosed rather than silently swapped.)
 */

import { marked } from 'marked';
import type { ReleaseArtifact, ReleaseRow, ShippedItem, ShippedPlan } from './release-registry';
import { groupItemsByPlan } from './release-registry';
import { identityLiterals, scrubIdentity, type IdentityLiteral } from './release-content-scrub';
import { ROBOT_BG_DATA_URI } from './release-bg';
import { INSTRUCTIONS_HEADING, INSTRUCTIONS_MD } from './release-instructions';

/** A release row with the display data for its FROZEN id lists looked up. */
export interface HydratedRelease {
  row: ReleaseRow;
  items: ShippedItem[];
  plans: ShippedPlan[];
  internalCount: number;
}

export interface Analytics {
  host: string;
  projectKey: string;
}

export interface PageOptions {
  generatedAt: Date;
  /** Omit/null to generate a page with no beacon at all (local preview, tests). */
  analytics?: Analytics | null;
  /**
   * This box's identity, redacted out of every page. DEFAULTS to resolving the
   * real machine — a caller cannot accidentally publish un-scrubbed pages by
   * forgetting to pass it (WI-4389's lesson: the loader belongs in the producer).
   * Tests pass explicit literals; pass `[]` to deliberately disable.
   */
  redact?: IdentityLiteral[];
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Markdown → HTML, at GENERATION time. Content is ours (agent changelog, our own
 *  plan bodies from our own Postgres), never third-party input. */
export function renderMarkdown(md: string): string {
  return marked.parse(md, { async: false, gfm: true, breaks: false }) as string;
}

/**
 * Drop a plan's YAML frontmatter before it is rendered.
 *
 * It is METADATA, and on a public page it is both noise and a leak. Noise: the
 * title is already the <h1>, and `status: draft` / `created:` / `slug:` mean
 * nothing to a beta tester. Leak: `owner:` is a human's EMAIL ADDRESS — and it is
 * how two of the owner's personal gmail addresses reached a page bound for beta
 * testers (neither was this box's git identity, so no enumerated literal matched;
 * the scrub's shape-based email pattern is the backstop, this is the fix).
 *
 * Markdown does not treat frontmatter as metadata — `marked` sees the closing
 * `---` as a setext underline and renders the whole block as a HEADING, so it
 * arrives not merely present but as the loudest text on the page.
 */
export function stripFrontmatter(md: string): string {
  const m = /^﻿?---\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/.exec(md);
  return m ? md.slice(m[0].length) : md;
}

/**
 * A plan's body almost always opens with `# <the plan title>` — and the page already
 * renders that title as its own `<h1>`. Left alone, every plan page states its title
 * twice, in two different sizes, which reads as a rendering bug.
 *
 * Only an EXACT title match is removed. A first heading that says something else is
 * real content and stays: silently eating the opening line of a plan body because it
 * merely looked title-ish would be a worse bug than the duplication it fixes.
 */
export function stripDuplicateTitle(md: string, title: string): string {
  const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();
  const m = /^[ \t]*#[ \t]+(.+?)[ \t]*(\r?\n|$)/.exec(md);
  if (!m || norm(m[1]) !== norm(title)) return md;
  return md.slice(m[0].length).replace(/^\s*\r?\n/, '');
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)} KB`;
  return `${n} B`;
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** `plans/<slug>.html`, relative — never absolute (the base path is the secret). */
export function planPagePath(slug: string): string {
  return `plans/${slug.replace(/[^a-zA-Z0-9._-]/g, '-')}.html`;
}

/**
 * The beacon. A single fetch to PostHog's anonymous capture endpoint — no
 * posthog-js, no CDN, no cookie. The `phc_*` key is a public anonymous-capture
 * credential (it cannot read events back), which is what makes it safe to bake
 * into a static page.
 *
 * `keepalive` so the POST survives the user clicking a download link immediately.
 * Every failure is swallowed: analytics must never be able to break the page.
 */
function beaconScript(a: Analytics, page: string, version: string | null): string {
  const props = JSON.stringify({ page, version });
  return `<script>
(function () {
  try {
    var props = ${props};
    // The referrer is the WHOLE POINT: a visit from a page we never shared the
    // link with is how a leak announces itself. Empty = typed/bookmarked/direct.
    props.referrer = document.referrer || '(direct)';
    props.screen = screen.width + 'x' + screen.height;
    props.lang = navigator.language;
    // NOTE: we deliberately send NO url and NO path of any kind — not the page
    // location, not the analytics library's usual current-url property, nothing.
    // The URL is the shared secret; sending it would copy that secret into the
    // analytics store. See the module header (point 3). A test greps this file
    // for the forbidden tokens, so do not reintroduce one even in a comment.
    fetch(${JSON.stringify(a.host)} + '/e/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      keepalive: true,
      body: JSON.stringify({
        api_key: ${JSON.stringify(a.projectKey)},
        event: 'release_history_viewed',
        properties: Object.assign(
          { distinct_id: 'anon-' + Math.random().toString(36).slice(2) },
          props
        ),
        timestamp: new Date().toISOString(),
      }),
    }).catch(function () {});
  } catch (e) {}
})();
</script>`;
}

/**
 * The papercusp.com theme, lifted from the live site so a beta tester who clicks
 * through from the product lands somewhere that looks like the same company.
 *
 * DARK, matching the site. papercusp.com now ships a single dark theme by default
 * (html[data-theme="dark"], --bg:#07101d) sitting over a static "robot" flow-field —
 * the same backdrop the marketing site wears, minus the video/animation
 * (ROBOT_BG_DATA_URI, inlined below so the page stays self-contained). This file used
 * to be light-only, back when the site genuinely had no dark variant; it does now, so
 * we mirror it. Matching a single-theme site means adopting its single theme — if the
 * site's palette moves, move these tokens with it rather than inventing a second look.
 */
const STYLES = `
:root {
  --bg: #07101d; --bg-2: #0b1626; --bg-3: #0e1d31;
  --surface: rgba(18, 38, 63, .45); --surface-2: rgba(12, 26, 44, .7);
  --border: rgba(96, 168, 214, .18); --border-strong: rgba(96, 168, 214, .34);
  --fg: #e7f7ff; --fg-dim: #c3dcec; --muted: #8ea9c0;
  --accent: #38bdf8; --accent-2: #5eead4; --accent-deep: #0ea5e9;
  --glow: rgba(56, 189, 248, .22); --grid: rgba(120, 180, 220, .05);
  --shadow: 0 24px 60px -30px rgba(0, 0, 0, .7);
  --radius: 8px;
  --sans: system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  --mono: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, "Liberation Mono", monospace;
  color-scheme: dark;
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  position: relative;
  margin: 0; padding: 3.5rem 1.25rem 6rem; min-height: 100vh;
  color: var(--fg); font: 16px/1.65 var(--sans);
  background: var(--bg);
}
/* The static robot backdrop, pinned as its OWN fixed layer rather than a
   background-attachment:fixed on <body>. Deliberate: these pages are long (a plan page
   runs thousands of words) and background-attachment:fixed seams at the fold on tall
   pages, whereas a fixed element composites once and never seams. z-index:-1 drops it
   behind the grid (body::before, z-0) and the content (main, z-1). It is decorative and
   aria-hidden; if the data URI ever fails to paint, the solid --bg underneath is the
   same colour, so the page is unharmed. */
.bgfx {
  position: fixed; inset: 0; z-index: -1; pointer-events: none; overflow: hidden;
  background:
    radial-gradient(1100px 620px at 82% -10%, var(--glow), transparent 60%),
    radial-gradient(900px 520px at 6% 2%, rgba(94, 234, 212, .10), transparent 62%),
    url("${ROBOT_BG_DATA_URI}") center top / cover no-repeat,
    var(--bg);
}
/* the faint engineering grid papercusp.com sits on, faded out down the page */
body::before {
  content: ""; position: absolute; inset: 0; pointer-events: none; z-index: 0;
  background-image:
    linear-gradient(var(--grid) 1px, transparent 1px),
    linear-gradient(90deg, var(--grid) 1px, transparent 1px);
  background-size: 44px 44px;
  /* fade in PIXELS, not %: a % fade would stretch the grid halfway down a
     3,000-word plan page instead of keeping it a masthead texture. */
  -webkit-mask-image: linear-gradient(180deg, #000 0, rgba(0, 0, 0, .55) 340px, transparent 760px);
  mask-image: linear-gradient(180deg, #000 0, rgba(0, 0, 0, .55) 340px, transparent 760px);
}
main { position: relative; z-index: 1; max-width: 56rem; margin: 0 auto; }
h1 {
  font-size: clamp(2.1rem, 5vw, 3.25rem); line-height: 1.08; margin: 0 0 .5rem;
  letter-spacing: -.03em; font-weight: 650;
  background: linear-gradient(135deg, var(--fg) 0%, var(--accent-deep) 100%);
  -webkit-background-clip: text; background-clip: text; color: transparent;
}
/* a plan TITLE is a sentence, not a wordmark — "Papercusp releases" carries a 52px
   hero; "Desktop auto-update fully operational (manifest fixes → proxy → 2-cut E2E
   on win/mac/linux VMs)" at that size is three lines of shouting. */
h1.plan-title { font-size: clamp(1.7rem, 3.2vw, 2.15rem); line-height: 1.2; }
h2 { font-size: 1.45rem; margin: 0; letter-spacing: -.02em; font-weight: 640; }
a { color: var(--accent-deep); text-decoration-color: rgba(2, 132, 199, .35); text-underline-offset: 2px; }
a:hover { color: var(--accent); }
.sub { color: var(--muted); font-size: .95rem; margin: 0 0 3rem; max-width: 42rem; }
.rel {
  border: 1px solid var(--border); border-radius: 16px;
  padding: 1.6rem 1.75rem; margin: 0 0 1.75rem;
  background: var(--surface); box-shadow: var(--shadow);
  -webkit-backdrop-filter: blur(14px) saturate(140%);
  backdrop-filter: blur(14px) saturate(140%);
}
.rel-head { display: flex; align-items: center; gap: .6rem; flex-wrap: wrap; margin-bottom: .4rem; }
.tag {
  font-size: .68rem; text-transform: uppercase; letter-spacing: .08em; font-weight: 600;
  padding: .18rem .5rem; border-radius: 999px;
  border: 1px solid var(--border-strong); color: var(--muted); background: var(--surface-2);
}
.tag.current { border-color: transparent; color: #fff; background: linear-gradient(135deg, var(--accent) 0%, var(--accent-2) 100%); }
.meta { color: var(--muted); font-size: .85rem; margin-bottom: 1.25rem; }
.meta code { font-family: var(--mono); background: var(--surface-2); border: 1px solid var(--border); padding: .1rem .4rem; border-radius: 5px; font-size: .85em; }
.changelog { margin: 1.35rem 0 0; color: var(--fg-dim); }
.changelog :first-child { margin-top: 0; }
.changelog h1, .changelog h2, .changelog h3 {
  font-size: 1.05rem; margin: 1.35rem 0 .45rem; color: var(--fg);
  letter-spacing: -.01em; font-weight: 640;
  background: none; -webkit-background-clip: border-box; background-clip: border-box;
}
h3.dl-group { font-size: .95rem; margin: 1.4rem 0 .5rem; color: var(--fg-dim); font-weight: 640; letter-spacing: -.01em; }
table.dl { width: 100%; border-collapse: collapse; margin: 0; font-size: .9rem; }
table.dl th {
  text-align: left; color: var(--muted); font-weight: 600; font-size: .72rem;
  text-transform: uppercase; letter-spacing: .06em;
  padding: .4rem .75rem .4rem 0; border-bottom: 1px solid var(--border-strong);
}
table.dl td { padding: .6rem .75rem .6rem 0; border-bottom: 1px solid var(--border); vertical-align: middle; }
table.dl tr:last-child td { border-bottom: 0; }
table.dl td a { font-weight: 550; }
table.dl td.sha { color: var(--muted); font-family: var(--mono); font-size: .7rem; word-break: break-all; }
/* Per-platform download sections (owner ask 2026-07-19): each platform is its own
   section; within it the app and Server are labelled sub-tables of the same shape. */
.platform-section { margin: 1.5rem 0 0; }
h3.platform-h { font-size: 1.02rem; margin: 0 0 .35rem; color: var(--fg); font-weight: 680; letter-spacing: -.01em; border-bottom: 1px solid var(--border-strong); padding-bottom: .3rem; }
h4.component-h { font-size: .74rem; margin: .85rem 0 .25rem; color: var(--fg-dim); font-weight: 640; text-transform: uppercase; letter-spacing: .04em; }
p.n { color: var(--muted); font-size: .8rem; margin: .5rem 0 0; line-height: 1.45; }
p.warn { color: #e6a23c; font-size: .82rem; margin: .55rem 0 0; font-weight: 520; line-height: 1.45; }
details {
  margin-top: 1.35rem; border-top: 1px solid var(--border); padding-top: 1rem;
}
summary { cursor: pointer; font-weight: 600; font-size: .92rem; color: var(--accent-deep); }
summary:hover { color: var(--accent); }
summary::marker { color: var(--accent); }
ul.items { list-style: none; padding: 0; margin: .6rem 0 0; }
ul.items li { padding: .35rem 0; font-size: .89rem; color: var(--fg-dim); border-bottom: 1px solid var(--grid); }
ul.items li:last-child { border-bottom: 0; }
.wid { font-family: var(--mono); font-size: .76rem; color: var(--accent-2); margin-right: .55rem; }
/* Per-item click-to-expand (WI-5525). Scope OVER the top-level details/summary
   rules above so a nested item expander keeps the compact item look, not the big
   section-header look. */
ul.items li details { margin-top: 0; border-top: 0; padding-top: 0; }
ul.items li summary { font-weight: inherit; font-size: inherit; color: inherit; list-style: none; cursor: pointer; }
ul.items li summary:hover { color: var(--fg); }
ul.items li summary::-webkit-details-marker { display: none; }
ul.items li summary::marker { content: ""; }
ul.items li summary::before { content: "▸"; color: var(--muted); display: inline-block; width: 1em; margin-right: .1rem; transition: transform .12s ease; }
ul.items li details[open] summary::before { transform: rotate(90deg); }
ul.items li .item-body { margin: .45rem 0 .35rem 1.1em; padding: .55rem .75rem; white-space: pre-wrap; overflow-wrap: anywhere; font-size: .82rem; line-height: 1.5; color: var(--muted); background: rgba(255,255,255,.02); border-left: 2px solid var(--border); border-radius: 4px; max-height: 24rem; overflow: auto; }
.plan-group { margin: 1.25rem 0 0; }
.plan-group > h4 { margin: 0 0 .1rem; font-size: .95rem; font-weight: 640; letter-spacing: -.01em; }
.plan-group > .n { color: var(--muted); font-size: .78rem; margin: 0 0 .35rem; }
.empty { color: var(--muted); font-style: italic; }
.back { display: inline-block; margin-bottom: 1.75rem; font-size: .88rem; font-weight: 550; }
.prose { margin-top: 1.5rem; color: var(--fg-dim); }
.prose h1, .prose h2, .prose h3, .prose h4 {
  color: var(--fg); letter-spacing: -.02em;
  background: none; -webkit-background-clip: border-box; background-clip: border-box;
}
.prose h1 { font-size: 1.6rem; }
.prose h2 { font-size: 1.3rem; margin-top: 2rem; }
/* The Instructions section nests three levels deep (section h2 → topic h3 →
   sub-topic h4), so h3/h4 need explicit sizes: the UA defaults render h4 SMALLER
   than the body text it introduces, which reads as a caption, not a heading. */
.prose h3 { font-size: 1.1rem; margin: 2.1rem 0 .5rem; font-weight: 660; }
.prose h4 { font-size: .95rem; margin: 1.5rem 0 .4rem; font-weight: 640; color: var(--fg-dim); }
.prose li { margin: .3rem 0; }
.prose li > ul { margin: .35rem 0; }
.prose kbd {
  font-family: var(--mono); font-size: .78em; padding: .08rem .35rem;
  border: 1px solid var(--border-strong); border-bottom-width: 2px; border-radius: 4px;
  background: var(--surface-2); color: var(--fg-dim); white-space: nowrap;
}
.prose pre {
  background: var(--surface-2); border: 1px solid var(--border);
  padding: .9rem 1.1rem; border-radius: var(--radius); overflow-x: auto;
  font-family: var(--mono); font-size: .84rem;
}
.prose code { font-family: var(--mono); background: var(--surface-2); border: 1px solid var(--border); padding: .1rem .35rem; border-radius: 5px; font-size: .86em; }
.prose pre code { background: none; border: 0; padding: 0; }
.prose blockquote { margin: 1rem 0; padding: .1rem 0 .1rem 1rem; border-left: 3px solid var(--accent); color: var(--muted); }
.prose table { border-collapse: collapse; width: 100%; display: block; overflow-x: auto; font-size: .88rem; }
.prose td, .prose th { border: 1px solid var(--border); padding: .45rem .7rem; }
.prose th { background: var(--surface-2); }
.prose img { max-width: 100%; border-radius: var(--radius); }
footer { color: var(--muted); font-size: .78rem; margin-top: 3.5rem; text-align: center; }
`;

/**
 * The single point where a page becomes bytes — and therefore the ONE place the
 * identity scrub belongs.
 *
 * Scrubbing at each call site (item titles here, plan bodies there, changelog
 * over there) means the next person who adds a field to the page silently adds a
 * leak. The content is written by agents on the owner's own box: a work-item title
 * quoting a shell command carries his home path, a plan's decision log carries his
 * name. So we scrub the FINISHED HTML, once, on the way out. Nothing renders
 * except through here.
 */
function shell(title: string, body: string, beacon: string, redact: IdentityLiteral[]): string {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#07101d">
<!-- Unlisted beta page. Not indexed, not linked from anywhere public. -->
<meta name="robots" content="noindex, nofollow, noarchive">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
<style>${STYLES}</style>
</head>
<body>
<div class="bgfx" aria-hidden="true"></div>
<main>
${body}
</main>
${beacon}
</body>
</html>
`;
  return scrubIdentity(html, redact);
}

/** High-level platform sections for a release's downloads, in display order
 *  (owner ask 2026-07-19: a separate section per platform). `Mobile` folds the
 *  phone builds together; `platforms` lists the ReleaseArtifact platform strings
 *  that belong to each section. */
const PLATFORM_SECTIONS: ReadonlyArray<{ label: string; platforms: string[]; desktop: boolean }> = [
  { label: 'Linux', platforms: ['linux-x86_64'], desktop: true },
  { label: 'macOS', platforms: ['darwin-universal'], desktop: true },
  { label: 'Windows', platforms: ['windows-x86_64'], desktop: true },
  { label: 'Mobile', platforms: ['android-universal', 'ios-arm64'], desktop: false },
];

/** One download table (Download / Size / SHA-256) for a set of artifacts. Used
 *  IDENTICALLY for the app (GUI) and the Server within a platform section — the
 *  Server is a first-class table, never a prose link (owner ask 2026-07-19). The
 *  platform is the section header and the component is a sub-header, so neither is
 *  a table column here. */
function renderDownloadTable(list: ReleaseArtifact[]): string {
  if (list.length === 0) return '';
  const rows = list
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(
      (a) => `      <tr>
        <td><a href="${escapeHtml(a.url)}">${escapeHtml(a.name)}</a></td>
        <td>${escapeHtml(formatBytes(a.size))}</td>
        <td class="sha">${escapeHtml(a.sha256 || '—')}</td>
      </tr>`,
    )
    .join('\n');
  return `<table class="dl">
  <thead><tr><th>Download</th><th>Size</th><th>SHA-256</th></tr></thead>
  <tbody>
${rows}
  </tbody>
</table>`;
}

/** The GUI↔Server requirement note for ONE desktop platform section. Linux GUI is
 *  self-contained (Server optional); mac/Windows GUI REQUIRES the Server. If a
 *  mac/Win section has a GUI but NO Server, warn loudly rather than let a tester
 *  install a build that can't start. */
function platformRequirementNote(
  label: string,
  hasGui: boolean,
  hasServer: boolean,
): string {
  if (!hasGui) return '';
  if (label === 'Linux') {
    return hasServer
      ? `\n<p class="n">The app runs on its own on Linux — it includes its own backend. <strong>Papercusp Server</strong> is optional here (only to keep agents running with the app closed).</p>`
      : '';
  }
  // macOS / Windows — the GUI has no built-in backend.
  return hasServer
    ? `\n<p class="n"><strong>Install both.</strong> On ${escapeHtml(label)} the app needs <strong>Papercusp Server</strong> running alongside it — install the app <em>and</em> the Server below.</p>`
    : `\n<p class="warn">⚠ On ${escapeHtml(label)} the app also needs <strong>Papercusp Server</strong> to run — it isn't in this release yet, so this build can't start on its own.</p>`;
}

/** One platform's section: a heading, then the app downloads and (when present)
 *  the Server downloads, each as its own labelled table of the SAME shape. */
function renderPlatformSection(label: string, desktop: boolean, list: ReleaseArtifact[]): string {
  const app = list.filter((a) => a.product === 'gui' || a.product === 'mobile');
  const server = list.filter((a) => a.product === 'server');
  // Only label the App/Server sub-sections when BOTH are present — a platform with
  // just one component doesn't need the distinction.
  const labelComponents = app.length > 0 && server.length > 0;
  const parts: string[] = [`<h3 class="platform-h">${escapeHtml(label)}</h3>`];
  if (app.length > 0) {
    if (labelComponents) parts.push(`<h4 class="component-h">App</h4>`);
    parts.push(renderDownloadTable(app));
  }
  if (server.length > 0) {
    if (labelComponents) parts.push(`<h4 class="component-h">Papercusp Server</h4>`);
    parts.push(renderDownloadTable(server));
  }
  if (desktop) parts.push(platformRequirementNote(label, app.length > 0, server.length > 0));
  return `<section class="platform-section">\n${parts.filter(Boolean).join('\n')}\n</section>`;
}

/**
 * A release's downloads, as a separate high-level SECTION per platform (owner ask
 * 2026-07-19), each grouping that platform's app + Server into their own tables of
 * the same shape. This structure carries the GUI↔Server requirement inline:
 *   • Linux  — the GUI self-hosts its own backend (Server optional).
 *   • macOS + Windows — the GUI has NO built-in backend; it needs the separate
 *              Papercusp Server or it fatals — so install BOTH.
 * Mobile is its own section. An unrecognized platform is never dropped — it falls
 * into an "Other" section so the page's account of the release stays complete.
 */
function renderArtifacts(artifacts: ReleaseArtifact[]): string {
  const real = artifacts.filter((a) => !a.name.endsWith('.sig'));
  if (real.length === 0) {
    return `<p class="empty">No downloadable artifacts recorded for this release.</p>`;
  }

  const known = new Set(PLATFORM_SECTIONS.flatMap((s) => s.platforms));
  const sections: string[] = [];
  for (const sec of PLATFORM_SECTIONS) {
    const list = real.filter((a) => sec.platforms.includes(a.platform));
    if (list.length > 0) sections.push(renderPlatformSection(sec.label, sec.desktop, list));
  }
  const other = real.filter((a) => !known.has(a.platform));
  if (other.length > 0) sections.push(renderPlatformSection('Other', true, other));

  return sections.join('\n');
}

function renderItemList(items: ShippedItem[]): string {
  return `<ul class="items">
${items
  .map((i) => {
    const head = `<span class="wid">${escapeHtml(i.id)}</span>${escapeHtml(i.title)}`;
    const body = (i.summary ?? '').trim();
    // No body → a plain row (unchanged look). With a body → a click-to-expand
    // <details> (WI-5525): summary is the id+title row (same look), the panel is
    // the full item text. Body is ESCAPED + white-space:pre-wrap — faithful and
    // XSS-safe (no markdown eval); identity is scrubbed with the whole page in
    // shell(). Pure HTML, no JS — works on the static R2 page.
    if (!body) return `      <li>${head}</li>`;
    return `      <li><details><summary>${head}</summary><div class="item-body">${escapeHtml(body)}</div></details></li>`;
  })
  .join('\n')}
    </ul>`;
}

function renderWork(rel: HydratedRelease): string {
  if (rel.items.length === 0 && rel.internalCount === 0) return '';

  const groups = groupItemsByPlan(rel.items, rel.plans);
  const planCount = groups.filter((g) => g.plan !== null).length;

  const body = groups
    .map((g) => {
      // No plan STATUS on the public page: `draft` / `ready` / `shipped` is our
      // internal workflow state, it says nothing to a tester, and on a page listing
      // what SHIPPED, "plan draft" reads as a contradiction rather than as metadata.
      const heading = g.plan
        ? `<h4><a href="${escapeHtml(planPagePath(g.plan.slug))}">${escapeHtml(g.plan.title)}</a></h4>
      <p class="n">${g.items.length} item${g.items.length === 1 ? '' : 's'}</p>`
        : `<h4>Not part of a plan</h4>
      <p class="n">${g.items.length} item${g.items.length === 1 ? '' : 's'}</p>`;
      return `    <div class="plan-group">
      ${heading}
      ${renderItemList(g.items)}
    </div>`;
    })
    .join('\n');

  // The internal count is stated, never listed: EI-* items are the agents fixing
  // their own tooling. Hiding them silently would make "the full list" a lie;
  // listing 700 of them would bury the 1,000 that matter.
  const internal =
    rel.internalCount > 0
      ? `\n    <p class="n">Plus ${rel.internalCount} internal engineering-tooling fixes (not listed — they change how the agents work, not the product).</p>`
      : '';

  return `  <details>
    <summary>${rel.items.length} work item${rel.items.length === 1 ? '' : 's'} across ${planCount} plan${planCount === 1 ? '' : 's'}</summary>
${body}${internal}
  </details>`;
}

/**
 * Every link in the Instructions section opens in a new tab.
 *
 * Not a nicety: the page IS the release. A tester who clicks the Discord link
 * mid-setup and navigates away has lost the download tables and the rest of the
 * instructions, and the only way back is the secret URL — which they got in a
 * message they now have to go find. `noopener noreferrer` comes along because
 * `target="_blank"` without it hands the opened page a live `window.opener`
 * handle on this one.
 *
 * Applied to the RENDERED html rather than written into the markdown so the
 * content stays plain markdown that anyone can edit without remembering to
 * repeat the attributes (and so a link added later can't quietly miss them).
 * Scoped to `http(s)` — the release links elsewhere on the page are relative on
 * purpose (the base path is the secret) and must keep navigating in place.
 */
function openLinksInNewTab(html: string): string {
  return html.replace(/<a href="(https?:\/\/)/g, '<a target="_blank" rel="noopener noreferrer" href="$1');
}

/**
 * The owner's "Instructions" section — the beta-tester onboarding notes, ABOVE
 * the downloads [owner 2026-07-27].
 *
 * The order is the whole point. The section opens by saying the GUI is not the
 * part that is ready — `psu` is — and that only lands if it is read BEFORE the
 * installer is downloaded. Underneath the downloads it would be an apology; on
 * top it is an instruction.
 *
 * Rendered from markdown HERE, at generation time, like everything else on this
 * page: a tester with JavaScript disabled (or a blocked CDN) must still get the
 * setup steps. Content lives in release-instructions.ts.
 */
function renderInstructions(): string {
  return `<section class="rel instructions">
  <div class="rel-head">
    <h2>${escapeHtml(INSTRUCTIONS_HEADING)}</h2>
  </div>
  <div class="prose">${openLinksInNewTab(renderMarkdown(INSTRUCTIONS_MD))}</div>
</section>`;
}

/**
 * Order: downloads BEFORE the changelog. A beta tester came here to get the
 * installer; making them scroll past the release notes to reach it is backwards.
 * It also keeps the prose honest — 0.0.8's changelog says "download the installer
 * above", which was a lie when the table rendered underneath it.
 */
function renderRelease(rel: HydratedRelease, isCurrent: boolean): string {
  const { row } = rel;
  const meta: string[] = [`Cut ${formatDate(row.cutAt)}`];
  if (row.publishedAt) meta.push(`published ${formatDate(row.publishedAt)}`);
  if (row.gitSha) meta.push(`<code>${escapeHtml(row.gitSha.slice(0, 12))}</code>`);

  const changelog = row.changelogMd?.trim()
    ? `<div class="changelog">${renderMarkdown(row.changelogMd)}</div>`
    : `<p class="empty">No changelog was written for this release.</p>`;

  return `<section class="rel">
  <div class="rel-head">
    <h2>${escapeHtml(row.version)}</h2>
    <span class="tag">${escapeHtml(row.channel)}</span>
    ${isCurrent ? '<span class="tag current">latest</span>' : ''}
  </div>
  <p class="meta">${meta.join(' · ')}</p>
  ${renderArtifacts(row.artifacts)}
  ${changelog}
${renderWork(rel)}
</section>`;
}

/** The whole history — every release, newest first. */
export function renderIndexHtml(releases: HydratedRelease[], opts: PageOptions): string {
  // The Instructions section renders on EVERY index, including an empty one.
  // It is the page's standing "how to get started", not a property of a release
  // — gating it on the registry having rows would mean the one page where a
  // reader has the least context is the page that explains the least.
  const body =
    releases.length === 0
      ? `<h1>Papercusp releases</h1>
<p class="sub">No releases have been recorded yet.</p>
${renderInstructions()}`
      : `<h1>Papercusp releases</h1>
<p class="sub">Beta builds for testers. This page is unlisted — please don't share the link.</p>
${renderInstructions()}
${releases.map((r, i) => renderRelease(r, i === 0)).join('\n')}`;

  const footer = `<footer>Generated ${formatDate(opts.generatedAt)} · unlisted beta page</footer>`;
  const beacon = opts.analytics
    ? beaconScript(opts.analytics, 'index', releases[0]?.row.version ?? null)
    : '';
  return shell('Papercusp releases', `${body}\n${footer}`, beacon, opts.redact ?? identityLiterals());
}

/**
 * `history.json` — the same release history, for the APP to read.
 *
 * ⚠ This exists because the obvious implementation of the in-app Update Center is
 * wrong. The registry lives in `harness_shared.releases` in OUR Postgres; a beta
 * tester's installed app has its own, empty database. A route that reads the
 * registry directly therefore works perfectly on the machine that cut the release
 * and shows an empty history to every actual user — the "works on my box" bug, in
 * a place nobody would look for it, because the code has no branch that can fail.
 *
 * So the history travels the SAME rail as the updater's manifest: a static file on
 * the release host, published next to `latest.json`, fetched over HTTPS. One
 * source of truth (the registry), two published projections (this and the page).
 *
 * It goes through the identity scrub for the same reason the page does — these are
 * bytes leaving this box for a human outside it, and the changelog is agent-written
 * prose from our own database, which is precisely the content we learned not to
 * trust.
 */
export function renderHistoryJson(releases: HydratedRelease[], opts: PageOptions): string {
  const json = {
    generated_at: opts.generatedAt.toISOString(),
    releases: releases.map((r) => ({
      tag: `desktop-v${r.row.version}${r.row.channel === 'stable' ? '' : `-${r.row.channel}`}`,
      version: r.row.version,
      channel: r.row.channel,
      notes: r.row.changelogMd ?? '',
      pub_date: (r.row.publishedAt ?? r.row.cutAt).toISOString(),
      prerelease: r.row.channel !== 'stable',
      artifacts: r.row.artifacts
        .filter((a) => !a.name.endsWith('.sig'))
        .map((a) => ({
          product: a.product,
          platform: a.platform,
          name: a.name,
          // RELATIVE, like everywhere else — the base path is the secret, and the
          // app already knows it (it is baked in as the update base URL).
          url: a.url,
          size: a.size,
          sha256: a.sha256,
        })),
    })),
  };
  return scrubIdentity(JSON.stringify(json, null, 2), opts.redact ?? identityLiterals());
}

/** One plan, rendered — the owner's "display the plan" surface. */
export function renderPlanPageHtml(
  plan: ShippedPlan,
  opts: PageOptions & { version: string },
): string {
  const md = stripDuplicateTitle(stripFrontmatter(plan.content).trim(), plan.title).trim();
  const content = md
    ? `<div class="prose">${renderMarkdown(md)}</div>`
    : `<p class="empty">This plan has no written content.</p>`;

  const body = `<a class="back" href="../index.html">← All releases</a>
<h1 class="plan-title">${escapeHtml(plan.title)}</h1>
<p class="sub">${plan.itemCount} work item${plan.itemCount === 1 ? '' : 's'} shipped in ${escapeHtml(opts.version)}</p>
${content}`;

  const beacon = opts.analytics ? beaconScript(opts.analytics, 'plan', opts.version) : '';
  return shell(
    `${plan.title} — Papercusp`,
    body,
    beacon,
    opts.redact ?? identityLiterals(),
  );
}
