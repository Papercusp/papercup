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

const PLATFORM_LABELS: Record<string, string> = {
  'linux-x86_64': 'Linux (x86_64)',
  'darwin-universal': 'macOS (Apple Silicon + Intel)',
  'darwin-aarch64': 'macOS (Apple Silicon)',
  'darwin-x86_64': 'macOS (Intel)',
  'windows-x86_64': 'Windows (x86_64)',
};

function platformLabel(p: string): string {
  return PLATFORM_LABELS[p] ?? p;
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

const STYLES = `
:root {
  --bg: #ffffff; --fg: #1a1a1a; --muted: #6b7280; --line: #e5e7eb;
  --accent: #2563eb; --card: #f9fafb; --code: #f3f4f6;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f1115; --fg: #e6e8eb; --muted: #9aa3af; --line: #262b33;
    --accent: #6ea8fe; --card: #161a21; --code: #1c2129;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; padding: 2rem 1.25rem 5rem; background: var(--bg); color: var(--fg);
  font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
}
main { max-width: 52rem; margin: 0 auto; }
h1 { font-size: 1.75rem; margin: 0 0 .25rem; letter-spacing: -.02em; }
h2 { font-size: 1.3rem; margin: 0; letter-spacing: -.01em; }
a { color: var(--accent); }
.sub { color: var(--muted); font-size: .9rem; margin: 0 0 2.5rem; }
.rel { border: 1px solid var(--line); border-radius: 10px; padding: 1.25rem 1.5rem; margin: 0 0 1.5rem; background: var(--card); }
.rel-head { display: flex; align-items: baseline; gap: .6rem; flex-wrap: wrap; margin-bottom: .35rem; }
.tag { font-size: .72rem; text-transform: uppercase; letter-spacing: .05em; padding: .12rem .45rem; border-radius: 4px; border: 1px solid var(--line); color: var(--muted); }
.tag.current { border-color: var(--accent); color: var(--accent); }
.meta { color: var(--muted); font-size: .85rem; margin-bottom: 1rem; }
.meta code { background: var(--code); padding: .1rem .35rem; border-radius: 4px; font-size: .85em; }
.changelog { margin: 1rem 0; }
.changelog :first-child { margin-top: 0; }
.changelog h1, .changelog h2, .changelog h3 { font-size: 1.05rem; margin: 1.2rem 0 .4rem; }
table.dl { width: 100%; border-collapse: collapse; margin: .75rem 0 0; font-size: .9rem; }
table.dl th { text-align: left; color: var(--muted); font-weight: 500; font-size: .8rem; padding: .35rem .5rem .35rem 0; border-bottom: 1px solid var(--line); }
table.dl td { padding: .45rem .5rem .45rem 0; border-bottom: 1px solid var(--line); vertical-align: top; }
table.dl td.sha { color: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .72rem; word-break: break-all; }
details { margin-top: .85rem; border-top: 1px solid var(--line); padding-top: .75rem; }
summary { cursor: pointer; font-weight: 500; font-size: .92rem; }
summary::marker { color: var(--muted); }
ul.items { list-style: none; padding: 0; margin: .6rem 0 0; }
ul.items li { padding: .25rem 0; font-size: .89rem; border-bottom: 1px dotted var(--line); }
ul.items li:last-child { border-bottom: 0; }
.wid { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .8rem; color: var(--muted); margin-right: .5rem; }
.plan-group { margin: 1rem 0 0; }
.plan-group > h4 { margin: 0 0 .1rem; font-size: .93rem; font-weight: 600; }
.plan-group > .n { color: var(--muted); font-size: .8rem; margin: 0 0 .3rem; }
.empty { color: var(--muted); font-style: italic; }
.back { display: inline-block; margin-bottom: 1.5rem; font-size: .9rem; }
.prose { margin-top: 1rem; }
.prose pre { background: var(--code); padding: .85rem 1rem; border-radius: 8px; overflow-x: auto; }
.prose code { background: var(--code); padding: .1rem .35rem; border-radius: 4px; font-size: .88em; }
.prose pre code { background: none; padding: 0; }
.prose table { border-collapse: collapse; width: 100%; display: block; overflow-x: auto; }
.prose td, .prose th { border: 1px solid var(--line); padding: .35rem .6rem; }
.prose img { max-width: 100%; }
footer { color: var(--muted); font-size: .8rem; margin-top: 3rem; text-align: center; }
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
<!-- Unlisted beta page. Not indexed, not linked from anywhere public. -->
<meta name="robots" content="noindex, nofollow, noarchive">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
<style>${STYLES}</style>
</head>
<body>
<main>
${body}
</main>
${beacon}
</body>
</html>
`;
  return scrubIdentity(html, redact);
}

function renderArtifacts(artifacts: ReleaseArtifact[]): string {
  const real = artifacts.filter((a) => !a.name.endsWith('.sig'));
  const gui = real.filter((a) => a.product !== 'server');
  const server = real.filter((a) => a.product === 'server');
  if (real.length === 0) {
    return `<p class="empty">No downloadable artifacts recorded for this release.</p>`;
  }

  // The Server build is a real published artifact, and it is NOT what a beta
  // tester wants — they want the GUI installer. It gets a footnote, not a row in
  // the main table, and specifically not silence: dropping it entirely would make
  // this page's account of what shipped quietly incomplete, which is the same
  // class of half-truth as a manifest that advertises a file that isn't there.
  const serverNote =
    server.length > 0
      ? `\n<p class="n">Also published: ${server
          .map(
            (a) =>
              `<a href="${escapeHtml(a.url)}">${escapeHtml(a.name)}</a> (${escapeHtml(formatBytes(a.size))})`,
          )
          .join(', ')} — the headless server build. If you're testing the app, you want the installer above.</p>`
      : '';

  if (gui.length === 0) {
    return `<p class="empty">No installer was recorded for this release.</p>${serverNote}`;
  }

  const rows = gui
    .map(
      (a) => `      <tr>
        <td>${escapeHtml(platformLabel(a.platform))}</td>
        <td><a href="${escapeHtml(a.url)}">${escapeHtml(a.name)}</a></td>
        <td>${escapeHtml(formatBytes(a.size))}</td>
        <td class="sha">${escapeHtml(a.sha256 || '—')}</td>
      </tr>`,
    )
    .join('\n');
  return `<table class="dl">
  <thead><tr><th>Platform</th><th>Download</th><th>Size</th><th>SHA-256</th></tr></thead>
  <tbody>
${rows}
  </tbody>
</table>${serverNote}`;
}

function renderItemList(items: ShippedItem[]): string {
  return `<ul class="items">
${items
  .map(
    (i) =>
      `      <li><span class="wid">${escapeHtml(i.id)}</span>${escapeHtml(i.title)}</li>`,
  )
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
  const body =
    releases.length === 0
      ? `<h1>Papercusp releases</h1>
<p class="sub">No releases have been recorded yet.</p>`
      : `<h1>Papercusp releases</h1>
<p class="sub">Beta builds for testers. This page is unlisted — please don't share the link.</p>
${releases.map((r, i) => renderRelease(r, i === 0)).join('\n')}`;

  const footer = `<footer>Generated ${formatDate(opts.generatedAt)} · unlisted beta page</footer>`;
  const beacon = opts.analytics
    ? beaconScript(opts.analytics, 'index', releases[0]?.row.version ?? null)
    : '';
  return shell('Papercusp releases', `${body}\n${footer}`, beacon, opts.redact ?? identityLiterals());
}

/** One plan, rendered — the owner's "display the plan" surface. */
export function renderPlanPageHtml(
  plan: ShippedPlan,
  opts: PageOptions & { version: string },
): string {
  const md = stripFrontmatter(plan.content).trim();
  const content = md
    ? `<div class="prose">${renderMarkdown(md)}</div>`
    : `<p class="empty">This plan has no written content.</p>`;

  const body = `<a class="back" href="../index.html">← All releases</a>
<h1>${escapeHtml(plan.title)}</h1>
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
