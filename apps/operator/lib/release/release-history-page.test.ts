import { describe, expect, it } from 'vitest';
import {
  escapeHtml,
  formatBytes,
  planPagePath,
  renderIndexHtml,
  renderPlanPageHtml,
  type Analytics,
  type HydratedRelease,
} from './release-history-page';
import { groupItemsByPlan, isUserFacing, type ReleaseRow, type ShippedItem, type ShippedPlan } from './release-registry';
import { INSTRUCTIONS_MD } from './release-instructions';

const ANALYTICS: Analytics = { host: 'https://flags.example.com', projectKey: 'phc_test' };
const GENERATED_AT = new Date('2026-07-13T00:00:00Z');

function row(over: Partial<ReleaseRow> = {}): ReleaseRow {
  return {
    version: '0.0.9',
    channel: 'alpha',
    cutAt: new Date('2026-07-12T00:00:00Z'),
    publishedAt: null,
    changelogMd: '## Highlights\n\nAuto-update actually works now.',
    workItemIds: ['WI-1'],
    planSlugs: ['a-plan'],
    artifacts: [
      {
        product: 'gui',
        platform: 'linux-x86_64',
        name: 'papercusp_0.0.9_amd64.deb',
        url: 'desktop-v0.0.9-alpha/papercusp_0.0.9_amd64.deb',
        size: 4_200_000_000,
        sha256: 'abc123',
      },
    ],
    gitSha: 'deadbeefcafe1234',
    cutBy: 'su-test',
    notes: null,
    ...over,
  };
}

function plan(over: Partial<ShippedPlan> = {}): ShippedPlan {
  return {
    slug: 'a-plan',
    title: 'A Plan',
    status: 'active',
    content: '# A Plan\n\nBody text.',
    itemCount: 1,
    ...over,
  };
}

function hydrated(over: Partial<HydratedRelease> = {}): HydratedRelease {
  return {
    row: row(),
    items: [{ id: 'WI-1', title: 'Fix the updater', planSlug: 'a-plan' }],
    plans: [plan()],
    internalCount: 0,
    ...over,
  };
}

describe('work items expand to their full body (WI-5525)', () => {
  it('wraps an item in a click-to-expand <details> when it has a body', () => {
    const html = renderIndexHtml(
      [
        hydrated({
          items: [
            { id: 'WI-9', title: 'Ship the thing', summary: 'The full body.\nSecond detail line.', planSlug: null },
          ],
          plans: [],
        }),
      ],
      { generatedAt: GENERATED_AT, analytics: null },
    );
    // The id+title stay the clickable summary; the panel carries the full body.
    expect(html).toContain('<details><summary><span class="wid">WI-9</span>Ship the thing</summary>');
    expect(html).toContain('class="item-body"');
    expect(html).toContain('The full body.');
    expect(html).toContain('Second detail line.');
  });

  it('renders a plain row (no expander) when the item has no body', () => {
    const html = renderIndexHtml(
      [hydrated({ items: [{ id: 'WI-9', title: 'No body item', summary: '', planSlug: null }], plans: [] })],
      { generatedAt: GENERATED_AT, analytics: null },
    );
    expect(html).toContain('No body item');
    // not wrapped in an item-level details/summary
    expect(html).not.toContain('<summary><span class="wid">WI-9</span>');
    expect(html).not.toContain('class="item-body"');
  });

  it('escapes the body — HTML in a work-item summary is not evaluated (public page)', () => {
    const html = renderIndexHtml(
      [hydrated({ items: [{ id: 'WI-9', title: 'x', summary: '<img src=x onerror=alert(1)>', planSlug: null }], plans: [] })],
      { generatedAt: GENERATED_AT, analytics: null },
    );
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
  });
});

describe('the beacon — the leak detector [owner: "collect stats on visits to make sure it isnt leaked"]', () => {
  it('captures document.referrer — the only signal that actually names a leak', () => {
    const html = renderIndexHtml([hydrated()], { generatedAt: GENERATED_AT, analytics: ANALYTICS });
    expect(html).toContain('document.referrer');
  });

  it('NEVER sends the url — the url IS the secret, and an analytics store is not a place to keep it', () => {
    const html = renderIndexHtml([hydrated()], { generatedAt: GENERATED_AT, analytics: ANALYTICS });
    // The obvious PostHog property. Sending it would copy the secret path into
    // dashboards, exports and support tools — the leak detector leaking the secret.
    expect(html).not.toContain('$current_url');
    expect(html).not.toContain('window.location');
    expect(html).not.toContain('location.href');
    expect(html).not.toContain('location.pathname');
  });

  it('omits the script ENTIRELY when no analytics are configured', () => {
    const html = renderIndexHtml([hydrated()], { generatedAt: GENERATED_AT, analytics: null });
    expect(html).not.toContain('<script');
    expect(html).not.toContain('fetch(');
  });

  it('tells search engines not to index an unlisted page', () => {
    const html = renderIndexHtml([hydrated()], { generatedAt: GENERATED_AT, analytics: ANALYTICS });
    expect(html).toContain('noindex');
    // ...and does not hand the secret path to whatever a tester clicks through to.
    expect(html).toContain('name="referrer" content="no-referrer"');
  });
});

describe('the page renders with JavaScript disabled', () => {
  // A beta tester is here to read what changed and download an installer. If that
  // depended on a script, a blocked/failed fetch would show them a blank page at
  // exactly the moment they need it. The beacon is the ONLY script, and it is
  // best-effort. So: every load-bearing thing must be in the HTML itself.
  const html = renderIndexHtml([hydrated()], { generatedAt: GENERATED_AT, analytics: ANALYTICS });

  it('bakes the download link, size and checksum into the markup', () => {
    expect(html).toContain('papercusp_0.0.9_amd64.deb');
    expect(html).toContain('4.20 GB');
    expect(html).toContain('abc123');
  });

  it('bakes the changelog in as rendered HTML, not markdown awaiting a renderer', () => {
    expect(html).toContain('Auto-update actually works now.');
    expect(html).toContain('<h2');
    expect(html).not.toContain('## Highlights');
  });

  it('bakes the work-item list in', () => {
    expect(html).toContain('WI-1');
    expect(html).toContain('Fix the updater');
  });
});

describe('links never carry the secret', () => {
  /** Every host this page is allowed to link OUT to. A new entry is a deliberate
   *  decision, which is the point of listing them: an unexpected absolute link is
   *  exactly how the base url starts creeping into the HTML. */
  const ALLOWED_EXTERNAL_HOSTS = ['discord.gg', 'platform.openai.com'];

  const anchors = (html: string) => [...html.matchAll(/<a\b[^>]*>/g)].map((m) => m[0]);
  const absoluteAnchors = (html: string) =>
    anchors(html).filter((a) => /href="https?:\/\//.test(a));

  it('links to plan pages relatively', () => {
    const html = renderIndexHtml([hydrated()], { generatedAt: GENERATED_AT, analytics: ANALYTICS });
    expect(html).toContain('href="plans/a-plan.html"');
    // ...and so does every link INTO this release host: the base path is the
    // secret, so a link that spells out its own url has written the secret down.
    expect(html).not.toMatch(/href="https?:\/\/[^"]*(?:r2\.dev|cloudflarestorage|index\.html)/);
  });

  // ── Why this replaced a blanket `not.toMatch(/href="https?:\/\//)` ──────────
  // That assertion said "no absolute links at all", which was a sound PROXY while
  // the page had none. The owner's Instructions section (2026-07-27) added real
  // outbound links — Discord, the OpenAI key page — so the proxy had to be
  // restated as the invariant it was standing in for. An absolute link is fine;
  // an absolute link that can carry the secret path is not. It could, two ways:
  //   1. the href SPELLING OUT the base url  → the host allowlist below
  //   2. the browser's Referer header on click → rel="noreferrer" below
  // Both are asserted, so this is a stricter guard than the line it replaced —
  // not a relaxed one. If you are here because you added a link and it failed:
  // that is the guard working. Add the host on purpose, keep the rel.
  it('only links out to hosts we chose on purpose', () => {
    const html = renderIndexHtml([hydrated()], { generatedAt: GENERATED_AT, analytics: ANALYTICS });
    const absolute = absoluteAnchors(html);
    expect(absolute.length).toBeGreaterThan(0); // the section is supposed to have links
    for (const tag of absolute) {
      const href = /href="([^"]+)"/.exec(tag)![1];
      expect(ALLOWED_EXTERNAL_HOSTS).toContain(new URL(href).host);
    }
  });

  it('every outbound link is rel="noreferrer" — a click must not hand the url to the far side', () => {
    // The page already ships <meta name="referrer" content="no-referrer">, which
    // covers this globally. This is the per-link belt to that braces: the meta is
    // one line in a shell() that also renders plan pages, and if it is ever
    // dropped or overridden, the secret would ride out in the Referer header of
    // the very first Discord click. Two independent mechanisms, on purpose.
    const html = renderIndexHtml([hydrated()], { generatedAt: GENERATED_AT, analytics: ANALYTICS });
    for (const tag of absoluteAnchors(html)) {
      expect(tag).toContain('rel="noopener noreferrer"');
    }
  });

  it('refuses to let a plan slug escape the plans/ directory', () => {
    // The slashes are what would traverse; stripping them leaves an inert
    // filename, dots and all.
    expect(planPagePath('../../etc/passwd')).toBe('plans/..-..-etc-passwd.html');
    expect(planPagePath('../../etc/passwd')).not.toContain('/etc/');
    expect(planPagePath('ok-slug_1.2')).toBe('plans/ok-slug_1.2.html');
  });
});

describe('escaping', () => {
  it('escapes a work-item title that contains markup', () => {
    const html = renderIndexHtml(
      [
        hydrated({
          items: [{ id: 'WI-2', title: '<img src=x onerror=alert(1)>', planSlug: null }],
          plans: [],
          row: row({ planSlugs: [] }),
        }),
      ],
      { generatedAt: GENERATED_AT, analytics: null },
    );
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x');
  });

  it('escapeHtml covers the five', () => {
    expect(escapeHtml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;');
  });
});

describe('formatBytes', () => {
  it('scales', () => {
    expect(formatBytes(4_200_000_000)).toBe('4.20 GB');
    expect(formatBytes(1_500_000)).toBe('1.5 MB');
    expect(formatBytes(2_000)).toBe('2 KB');
    expect(formatBytes(0)).toBe('—');
  });
});

describe('groupItemsByPlan — 1,000 items must become ~44 readable stories', () => {
  const plans: ShippedPlan[] = [
    plan({ slug: 'big', title: 'Big', itemCount: 3 }),
    plan({ slug: 'small', title: 'Small', itemCount: 1 }),
  ];
  const items: ShippedItem[] = [
    { id: 'WI-1', title: 'a', planSlug: 'small' },
    { id: 'WI-2', title: 'b', planSlug: 'big' },
    { id: 'WI-3', title: 'c', planSlug: 'big' },
    { id: 'WI-4', title: 'd', planSlug: 'big' },
    { id: 'WI-5', title: 'e', planSlug: null },
  ];

  it('sorts the biggest plan first and puts the unplanned items last', () => {
    const groups = groupItemsByPlan(items, plans);
    expect(groups.map((g) => g.plan?.slug ?? '(none)')).toEqual(['big', 'small', '(none)']);
    expect(groups[0].items).toHaveLength(3);
  });

  it('still shows items whose plan row is missing — the full list stays full', () => {
    const groups = groupItemsByPlan(
      [{ id: 'WI-9', title: 'orphan', planSlug: 'vanished' }],
      [], // no plan row for 'vanished'
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].plan).toBeNull();
    expect(groups[0].items[0].id).toBe('WI-9');
  });

  it('loses nothing: every item lands in exactly one group', () => {
    const groups = groupItemsByPlan(items, plans);
    const seen = groups.flatMap((g) => g.items.map((i) => i.id));
    expect(seen.sort()).toEqual(['WI-1', 'WI-2', 'WI-3', 'WI-4', 'WI-5']);
  });
});

describe('isUserFacing', () => {
  it('excludes EI-* — the agents fixing their own tooling is not release-notes material', () => {
    expect(isUserFacing('EI-10666')).toBe(false);
    expect(isUserFacing('WI-4446')).toBe(true);
    expect(isUserFacing('F-101')).toBe(true);
  });
});

describe('internal items are counted, never silently dropped', () => {
  it('states the internal count instead of hiding it', () => {
    const html = renderIndexHtml([hydrated({ internalCount: 738 })], {
      generatedAt: GENERATED_AT,
      analytics: null,
    });
    expect(html).toContain('738 internal engineering-tooling fixes');
  });
});

describe('empty / degenerate states', () => {
  it('renders a coherent page with no releases at all', () => {
    const html = renderIndexHtml([], { generatedAt: GENERATED_AT, analytics: null });
    expect(html).toContain('No releases have been recorded yet');
  });

  it('says so when a release has no changelog rather than showing a blank slot', () => {
    const html = renderIndexHtml([hydrated({ row: row({ changelogMd: null }) })], {
      generatedAt: GENERATED_AT,
      analytics: null,
    });
    expect(html).toContain('No changelog was written');
  });

  it('says so when a release has no artifacts', () => {
    const html = renderIndexHtml([hydrated({ row: row({ artifacts: [] }) })], {
      generatedAt: GENERATED_AT,
      analytics: null,
    });
    expect(html).toContain('No downloadable artifacts recorded');
  });
});

describe('the Instructions section [owner 2026-07-27]', () => {
  const html = renderIndexHtml([hydrated()], { generatedAt: GENERATED_AT, analytics: null });

  it('renders a section headed "Instructions"', () => {
    expect(html).toContain('<h2>Instructions</h2>');
  });

  it('sits ABOVE the downloads — the placement is the point, not a layout preference', () => {
    // The section opens by saying the GUI is NOT the ready part, `psu` is. Read
    // after the download tables that is an apology; read before them it is an
    // instruction. If someone moves it below the releases, this fails.
    const instructions = html.indexOf('<h2>Instructions</h2>');
    const firstRelease = html.indexOf('<h2>0.0.9</h2>');
    expect(instructions).toBeGreaterThan(-1);
    expect(firstRelease).toBeGreaterThan(-1);
    expect(instructions).toBeLessThan(firstRelease);
  });

  it('leads with the psu-not-the-GUI warning, as a callout rather than in caps', () => {
    expect(html).toContain('class="warn"');
    expect(html).toContain('The GUI is not ready yet');
    expect(html).toContain('run <code>psu</code> from the command line');
    // The owner's source line was all-caps; the callout carries the same words
    // without shouting them. If it regresses to caps, this catches it.
    expect(html).not.toContain('THE GUI NOT READY YET');
  });

  it('renders the setup steps as real markup — the page must work with JS disabled', () => {
    // Same rule as the rest of the page: nothing load-bearing may depend on a
    // script. The markdown is rendered at GENERATION time, so the steps are here.
    expect(html).toContain('<ol>');
    expect(html).toContain('papercusp tutorial');
    expect(html).toContain('Get floored');
    expect(html).toContain('Harrier-OSS-0.6b');
    // ...and every mode the owner documented survives the render.
    for (const mode of ['AUTO', 'COLD AUTO', 'IDEATE', 'DRAIN', 'GRADE']) {
      expect(html).toContain(`<strong>${mode}</strong>`);
    }
  });

  it('opens external links in a new tab — losing this page means losing the secret URL', () => {
    // The page IS the release: navigate away mid-setup and the only way back is
    // a URL the tester has to go dig out of a message.
    expect(html).toContain(
      '<a target="_blank" rel="noopener noreferrer" href="https://discord.gg/HjRQ8g4Nju"',
    );
    expect(html).toContain('href="https://platform.openai.com/api-keys"');
    // (That EVERY absolute link gets the treatment, not just these two, is
    // asserted in "links never carry the secret" above.)
  });

  it('does NOT touch the relative download links — the base path is the secret', () => {
    // Release artifacts are linked relatively on purpose. Blanket-targeting every
    // <a> would open the installer in a new tab AND is how a rewrite starts
    // creeping toward absolute urls.
    expect(html).toContain('<td><a href="desktop-v0.0.9-alpha/papercusp_0.0.9_amd64.deb">');
  });

  it('renders even when the registry has no releases at all', () => {
    // The page where a reader has the least context must not be the page that
    // explains the least.
    const empty = renderIndexHtml([], { generatedAt: GENERATED_AT, analytics: null });
    expect(empty).toContain('<h2>Instructions</h2>');
    expect(empty).toContain('No releases have been recorded yet');
  });

  it('carries no identity for the scrub to redact', () => {
    // The section is hand-written prose bound for a public bucket. It must pass
    // the gate on its own merits, not because scrubIdentity happened to catch it.
    expect(INSTRUCTIONS_MD).not.toMatch(/\/home\/[A-Za-z0-9._-]+/);
    expect(INSTRUCTIONS_MD).not.toMatch(/[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,24}/);
  });
});

describe('plan page', () => {
  it('renders the plan body and links back relatively', () => {
    const html = renderPlanPageHtml(plan(), {
      generatedAt: GENERATED_AT,
      analytics: ANALYTICS,
      version: '0.0.9',
    });
    expect(html).toContain('Body text.');
    expect(html).toContain('href="../index.html"');
    expect(html).toContain('document.referrer'); // the beacon is on this page too
    expect(html).not.toContain('$current_url');
  });

  // ── The frontmatter leak, found by rendering a REAL plan page and reading it.
  it('strips YAML frontmatter — it is metadata, and `owner:` is a live email address', () => {
    const content = [
      '---',
      'title: A Plan',
      'slug: a-plan',
      'status: draft',
      'owner: someone@gmail.com',
      '---',
      '',
      '## Now',
      '',
      'The real body.',
    ].join('\n');

    const html = renderPlanPageHtml(plan({ content }), {
      generatedAt: GENERATED_AT,
      analytics: null,
      version: '0.0.9',
    });

    expect(html).toContain('The real body.');
    expect(html).not.toContain('someone@gmail.com');
    expect(html).not.toContain('slug: a-plan');
    expect(html).not.toContain('status: draft');
  });

  it('keeps a body that merely CONTAINS a --- rule', () => {
    const html = renderPlanPageHtml(plan({ content: '# Title\n\nBefore.\n\n---\n\nAfter.' }), {
      generatedAt: GENERATED_AT,
      analytics: null,
      version: '0.0.9',
    });
    expect(html).toContain('Before.');
    expect(html).toContain('After.');
  });

  // Every real plan body opens with `# <its own title>`, so the page was rendering
  // the title twice — once as the page heading, once as the first line of the prose.
  it('does not print the plan title twice', () => {
    const html = renderPlanPageHtml(
      plan({ title: 'A Plan', content: '# A Plan\n\nBody text.' }),
      { generatedAt: GENERATED_AT, analytics: null, version: '0.0.9' },
    );
    expect(html).toContain('Body text.');
    expect(html).toContain('<h1 class="plan-title">A Plan</h1>'); // the page heading stays
    expect(html).not.toMatch(/<h1>A Plan<\/h1>/); // ...the markdown's copy of it does not
  });

  it('keeps a first heading that is NOT the title — that is content, not a duplicate', () => {
    const html = renderPlanPageHtml(
      plan({ title: 'A Plan', content: '# Background\n\nBody text.' }),
      { generatedAt: GENERATED_AT, analytics: null, version: '0.0.9' },
    );
    expect(html).toContain('Background');
    expect(html).toContain('Body text.');
  });

  it('does not publish our internal plan status to testers', () => {
    const html = renderPlanPageHtml(plan({ status: 'draft' }), {
      generatedAt: GENERATED_AT,
      analytics: null,
      version: '0.0.9',
    });
    expect(html).toContain('1 work item shipped in 0.0.9');
    expect(html).not.toContain('draft');
  });
});

describe('the Server artifact is disclosed, not silently dropped', () => {
  const withServer = hydrated({
    row: row({
      artifacts: [
        {
          product: 'gui',
          platform: 'linux-x86_64',
          name: 'gui_0.0.9_amd64.deb',
          url: 'desktop-v0.0.9-alpha/gui_0.0.9_amd64.deb',
          size: 3_600_000_000,
          sha256: 'aaa',
        },
        {
          product: 'server',
          platform: 'linux-x86_64',
          name: 'server_0.0.9_amd64.deb',
          url: 'desktop-v0.0.9-alpha/server_0.0.9_amd64.deb',
          size: 3_600_000_000,
          sha256: 'bbb',
        },
      ],
    }),
  });

  it('puts the Server in its OWN labelled table under the Linux section, not a prose link', () => {
    const html = renderIndexHtml([withServer], { generatedAt: GENERATED_AT, analytics: null });
    // The release's downloads are grouped under a per-platform section header.
    expect(html).toContain('<h3 class="platform-h">Linux</h3>');
    // Both the app and the Server appear, each under its own component sub-header,
    // each a first-class <table class="dl"> (the Server is NOT a prose footnote).
    expect(html).toContain('<h4 class="component-h">App</h4>');
    expect(html).toContain('<h4 class="component-h">Papercusp Server</h4>');
    expect(html).toContain('gui_0.0.9_amd64.deb');
    expect(html).toContain('server_0.0.9_amd64.deb');
    // Linux guidance: the app self-hosts, so the Server is optional here (NOT the
    // mac/Windows "install both").
    expect(html).toContain('optional');
    expect(html).not.toContain('headless server build');
  });

  it('tells mac/Windows to install BOTH, and puts the Server in its own table there too', () => {
    const macBoth = hydrated({
      row: row({
        artifacts: [
          { product: 'gui', platform: 'darwin-universal', name: 'GUI_0.0.9_universal.dmg', url: 'desktop-v0.0.9-alpha/GUI_0.0.9_universal.dmg', size: 1_300_000_000, sha256: 'g' },
          { product: 'server', platform: 'darwin-universal', name: 'Server_0.0.9_universal.dmg', url: 'desktop-v0.0.9-alpha/Server_0.0.9_universal.dmg', size: 1_300_000_000, sha256: 's' },
        ],
      }),
    });
    const html = renderIndexHtml([macBoth], { generatedAt: GENERATED_AT, analytics: null });
    expect(html).toContain('<h3 class="platform-h">macOS</h3>');
    expect(html).toContain('<h4 class="component-h">Papercusp Server</h4>');
    expect(html).toContain('Server_0.0.9_universal.dmg');
    expect(html).toContain('Install both.');
  });

  it('WARNS when a mac/Windows section has an app but NO Server (the non-functional case)', () => {
    const macGuiOnly = hydrated({
      row: row({
        artifacts: [
          { product: 'gui', platform: 'windows-x86_64', name: 'GUI_0.0.9_x64-setup.exe', url: 'desktop-v0.0.9-alpha/GUI_0.0.9_x64-setup.exe', size: 1_800_000_000, sha256: 'w' },
        ],
      }),
    });
    const html = renderIndexHtml([macGuiOnly], { generatedAt: GENERATED_AT, analytics: null });
    expect(html).toContain('<h3 class="platform-h">Windows</h3>');
    expect(html).toContain('class="warn"');
    expect(html).toContain('needs <strong>Papercusp Server</strong>');
  });
});

describe('the mobile apps render in their own labelled section [owner: "make sure the iphone and android builds make it onto our releases page"]', () => {
  const withAndroid = hydrated({
    row: row({
      artifacts: [
        {
          product: 'gui',
          platform: 'linux-x86_64',
          name: 'papercusp_0.0.9_amd64.deb',
          url: 'desktop-v0.0.9-alpha/papercusp_0.0.9_amd64.deb',
          size: 3_600_000_000,
          sha256: 'aaa',
        },
        {
          product: 'mobile',
          platform: 'android-universal',
          name: 'Papercusp_0.0.9_android.apk',
          url: 'desktop-v0.0.9-alpha/Papercusp_0.0.9_android.apk',
          size: 90_000_000,
          sha256: 'droid',
        },
      ],
    }),
  });

  it('gives the phone build its OWN "Mobile" platform section, without mixing it into a desktop table', () => {
    const html = renderIndexHtml([withAndroid], { generatedAt: GENERATED_AT, analytics: null });
    // The desktop installer stays under its own Linux section.
    expect(html).toContain('<h3 class="platform-h">Linux</h3>');
    expect(html).toContain('papercusp_0.0.9_amd64.deb');
    // The Android build gets its own Mobile section so an APK never reads as a
    // desktop download.
    expect(html).toContain('<h3 class="platform-h">Mobile</h3>');
    expect(html).toContain('Papercusp_0.0.9_android.apk');
    // download link, size and checksum baked into the markup (JS-off).
    expect(html).toContain('desktop-v0.0.9-alpha/Papercusp_0.0.9_android.apk');
    expect(html).toContain('droid');
  });

  it('surfaces an iOS build under the same Mobile section once a signed .ipa exists', () => {
    // iOS is enrollment-gated today (no signed .ipa yet), but the render path must
    // already be correct so the build appears the moment record-release finds one.
    const withIos = hydrated({
      row: row({
        artifacts: [
          {
            product: 'mobile',
            platform: 'ios-arm64',
            name: 'Papercusp_0.0.9_ios.ipa',
            url: 'desktop-v0.0.9-alpha/Papercusp_0.0.9_ios.ipa',
            size: 40_000_000,
            sha256: 'iphone',
          },
        ],
      }),
    });
    const html = renderIndexHtml([withIos], { generatedAt: GENERATED_AT, analytics: null });
    expect(html).toContain('<h3 class="platform-h">Mobile</h3>');
    expect(html).toContain('Papercusp_0.0.9_ios.ipa');
  });

  it('omits the Mobile section entirely for a desktop-only release', () => {
    const html = renderIndexHtml([hydrated()], { generatedAt: GENERATED_AT, analytics: null });
    expect(html).not.toContain('<h3 class="platform-h">Mobile</h3>');
  });
});
