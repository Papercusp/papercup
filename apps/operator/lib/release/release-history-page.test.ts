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
  it('links to plan pages relatively', () => {
    const html = renderIndexHtml([hydrated()], { generatedAt: GENERATED_AT, analytics: ANALYTICS });
    expect(html).toContain('href="plans/a-plan.html"');
    expect(html).not.toMatch(/href="https?:\/\//);
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

  it('keeps the installer in the table and the server build as a footnote', () => {
    const html = renderIndexHtml([withServer], { generatedAt: GENERATED_AT, analytics: null });
    // The GUI installer is what a tester came for — it stays in the download table.
    expect(html).toContain('<table class="dl">');
    expect(html).toContain('gui_0.0.9_amd64.deb');
    // The Server build shipped too. Omitting it entirely would make this page's
    // account of the release quietly incomplete.
    expect(html).toContain('server_0.0.9_amd64.deb');
    expect(html).toContain('headless server build');
  });
});
