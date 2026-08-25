/**
 * P-004 capture adapters — unit suite.
 *
 * Plan: ratified-mockup-implementation-validation-2026-08-24.
 *
 * The whole point of the capture adapter is REFUSAL, so most of what is worth
 * testing here is what it declines to do. Two properties get the most attention
 * because they are the ones a plausible-looking implementation gets wrong:
 *
 *  - A mismatched environment must not write an artifact at all. A refusal that
 *    still leaves a PNG on disk is a refusal someone can walk past later.
 *  - Nothing may be inferred from what was REQUESTED. Every test below drives
 *    the observed environment independently of the requested one, so an
 *    implementation that echoed its own inputs would pass nothing.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  captureImplementationTarget,
  createPageRouteCaptureAdapter,
  createStorybookCaptureAdapter,
  defaultFontSetResolver,
  defaultStateResolver,
  defaultThemeResolver,
  encodeStoryArgs,
  environmentMismatches,
  expectedDimensionsFor,
  filesystemCaptureArtifactReader,
  pageRouteUrl,
  parseFixtureArgs,
  storybookIframeUrl,
  storybookStoryUrl,
  type CaptureArtifact,
  type CaptureBrowser,
  type CaptureDeps,
  type CapturePage,
  type CaptureRequest,
  type ObservedEnvironment,
  type PageSpec,
  type ScreenshotOptions,
  type SettleOptions,
  type StateDirective,
} from './capture';
import type { CaptureEnvironment, ImplementationTarget } from './contract';
import { readPngDimensions } from './png-header';

// ─── fixtures ────────────────────────────────────────────────────────────────

const ENVIRONMENT: CaptureEnvironment = {
  viewport: { width: 800, height: 600 },
  deviceScaleFactor: 2,
  browser: 'chromium',
  theme: 'light',
  fontSet: 'system',
  state: 'default',
};

const STORY_TARGET: ImplementationTarget = {
  targetId: 'components-button--primary',
  targetKind: 'storybook-story',
  implementationRevision: 'abc123',
};

const ROUTE_TARGET: ImplementationTarget = {
  targetId: '/settings',
  targetKind: 'page-route',
  implementationRevision: 'abc123',
};

function observedFor(environment: CaptureEnvironment): ObservedEnvironment {
  return {
    viewport: { ...environment.viewport },
    devicePixelRatio: environment.deviceScaleFactor,
    prefersDark: environment.theme === 'dark',
    prefersReducedMotion: true,
    fontsReady: true,
    missingFontFamilies: [],
  };
}

interface FakeBrowserOptions {
  readonly observed?: ObservedEnvironment;
  readonly browserName?: string;
  /** One entry per screenshot attempt; the last repeats if attempts exceed it. */
  readonly artifacts?: readonly CaptureArtifact[];
  readonly throwOnGoto?: unknown;
  readonly throwOnClose?: unknown;
}

interface FakeBrowser {
  readonly browser: CaptureBrowser;
  readonly calls: {
    readonly specs: PageSpec[];
    readonly gotos: string[];
    readonly states: StateDirective[];
    readonly settles: SettleOptions[];
    readonly screenshots: ScreenshotOptions[];
    readonly attributes: { name: string; value: string }[];
    readonly closes: number[];
  };
  readonly readArtifact: (imagePath: string) => CaptureArtifact;
}

function makeFakeBrowser(options: FakeBrowserOptions = {}): FakeBrowser {
  const calls = {
    specs: [] as PageSpec[],
    gotos: [] as string[],
    states: [] as StateDirective[],
    settles: [] as SettleOptions[],
    screenshots: [] as ScreenshotOptions[],
    attributes: [] as { name: string; value: string }[],
    closes: [] as number[],
  };
  const observed = options.observed ?? observedFor(ENVIRONMENT);
  const artifacts = options.artifacts ?? [
    { ok: true, dimensions: { width: 1600, height: 1200 }, sha256: 'a'.repeat(64) },
  ];
  let readIndex = -1;

  const page: CapturePage = {
    async goto(url) {
      calls.gotos.push(url);
      if (options.throwOnGoto !== undefined) throw options.throwOnGoto;
    },
    async applyDocumentAttribute(attribute) {
      calls.attributes.push(attribute);
    },
    async applyState(directive) {
      calls.states.push(directive);
    },
    async settle(settleOptions) {
      calls.settles.push(settleOptions);
    },
    async observeEnvironment() {
      return observed;
    },
    async screenshot(screenshotOptions) {
      calls.screenshots.push(screenshotOptions);
    },
    async close() {
      calls.closes.push(1);
      if (options.throwOnClose !== undefined) throw options.throwOnClose;
    },
  };

  return {
    browser: {
      browserName: options.browserName ?? 'chromium',
      async newPage(spec) {
        calls.specs.push(spec);
        return page;
      },
    },
    calls,
    readArtifact() {
      readIndex += 1;
      return artifacts[Math.min(readIndex, artifacts.length - 1)]!;
    },
  };
}

function requestFor(overrides: Partial<CaptureRequest> = {}): CaptureRequest {
  return {
    target: STORY_TARGET,
    environment: ENVIRONMENT,
    mode: 'viewport',
    outputPath: '/tmp/capture.png',
    baseUrl: 'http://127.0.0.1:6006',
    ...overrides,
  };
}

function depsFor(fake: FakeBrowser, overrides: Partial<CaptureDeps> = {}): CaptureDeps {
  return { browser: fake.browser, readArtifact: fake.readArtifact, ...overrides };
}

// ─── geometry ────────────────────────────────────────────────────────────────

describe('expectedDimensionsFor', () => {
  it('scales the viewport by the device scale factor in viewport mode', () => {
    expect(expectedDimensionsFor(ENVIRONMENT, 'viewport')).toEqual({ width: 1600, height: 1200 });
  });

  it('states no expectation for a full-page capture, because the height is content-determined', () => {
    expect(expectedDimensionsFor(ENVIRONMENT, 'full-page')).toBeUndefined();
  });

  it('refuses rather than rounds when the scaled size is not whole pixels', () => {
    const fractional: CaptureEnvironment = {
      ...ENVIRONMENT,
      viewport: { width: 801, height: 600 },
      deviceScaleFactor: 1.5,
    };
    // 801 * 1.5 = 1201.5. Rounding to 1201 or 1202 would manufacture a
    // precondition that is wrong by a pixel in one direction or the other.
    expect(expectedDimensionsFor(fractional, 'viewport')).toBeUndefined();
  });

  it('accepts a fractional scale factor when it still lands on whole pixels', () => {
    const halfScale: CaptureEnvironment = {
      ...ENVIRONMENT,
      viewport: { width: 800, height: 600 },
      deviceScaleFactor: 1.5,
    };
    expect(expectedDimensionsFor(halfScale, 'viewport')).toEqual({ width: 1200, height: 900 });
  });
});

// ─── URL construction, pinned against lost-pixel itself ──────────────────────

describe('Storybook URL construction', () => {
  it("matches lost-pixel's own getIframeUrl rather than a restatement of it", async () => {
    // The claim "we reuse lost-pixel's convention" is checked against
    // lost-pixel's code. If a future upgrade changes the convention, this fails
    // here instead of silently capturing a URL its baselines do not describe.
    const lostPixel = (await import('lost-pixel/dist/crawler/storybook.js')) as {
      getIframeUrl: (url: string) => string;
    };
    for (const base of [
      'http://127.0.0.1:6006',
      'http://127.0.0.1:6006/',
      'file:///srv/storybook-static',
      'file:///srv/storybook-static/',
    ]) {
      expect(storybookIframeUrl(base)).toBe(lostPixel.getIframeUrl(base));
    }
  });

  it('builds a story URL with viewMode and no args', () => {
    expect(storybookStoryUrl({ baseUrl: 'http://x:6006', storyId: 'a--b' })).toBe(
      'http://x:6006/iframe.html?id=a--b&viewMode=story',
    );
  });

  it("encodes args with lost-pixel's key:value;key:value form", () => {
    expect(encodeStoryArgs({ size: 'large', tone: 'muted' })).toBe('size:large;tone:muted');
    expect(
      storybookStoryUrl({ baseUrl: 'http://x:6006', storyId: 'a--b', args: { size: 'large' } }),
    ).toBe('http://x:6006/iframe.html?id=a--b&viewMode=story&args=size:large');
  });

  it('omits the args parameter entirely when there are none', () => {
    expect(storybookStoryUrl({ baseUrl: 'http://x:6006', storyId: 'a--b', args: {} })).not.toContain(
      'args=',
    );
  });
});

describe('pageRouteUrl', () => {
  it.each([
    ['http://x:3055', '/settings', 'http://x:3055/settings'],
    ['http://x:3055/', '/settings', 'http://x:3055/settings'],
    ['http://x:3055', 'settings', 'http://x:3055/settings'],
    ['http://x:3055/', 'settings', 'http://x:3055/settings'],
  ])('joins %s + %s', (base, route, expected) => {
    expect(pageRouteUrl(base, route)).toBe(expected);
  });
});

describe('parseFixtureArgs', () => {
  it('parses key=value pairs', () => {
    expect(parseFixtureArgs('size=large&tone=muted')).toEqual({ size: 'large', tone: 'muted' });
  });
  it('returns undefined for an absent or unparseable fixture', () => {
    expect(parseFixtureArgs(undefined)).toBeUndefined();
    expect(parseFixtureArgs('')).toBeUndefined();
    expect(parseFixtureArgs('novalue')).toBeUndefined();
  });
  it('keeps values containing = intact', () => {
    expect(parseFixtureArgs('token=a=b')).toEqual({ token: 'a=b' });
  });
});

// ─── the default resolvers refuse what they do not know ──────────────────────

describe('default resolvers', () => {
  it('maps light and dark, and refuses an unregistered theme', () => {
    expect(defaultThemeResolver('light')).toEqual({ colorScheme: 'light' });
    expect(defaultThemeResolver('dark')).toEqual({ colorScheme: 'dark' });
    expect(defaultThemeResolver('midnight')).toBeUndefined();
  });

  it('treats system as a declared absence of font requirements, not an unchecked one', () => {
    expect(defaultFontSetResolver('system')).toEqual([]);
    expect(defaultFontSetResolver('brand-2026')).toBeUndefined();
  });

  it('knows only the default interaction state', () => {
    expect(defaultStateResolver('default')).toEqual({ kind: 'none' });
    expect(defaultStateResolver('hover')).toBeUndefined();
  });
});

// ─── environment verification ────────────────────────────────────────────────

describe('environmentMismatches', () => {
  const base = {
    requested: ENVIRONMENT,
    observed: observedFor(ENVIRONMENT),
    browserName: 'chromium',
    themeApplication: { colorScheme: 'light' as const },
  };

  it('is empty when the achieved environment matches', () => {
    expect(environmentMismatches(base)).toEqual([]);
  });

  it('reports a viewport mismatch', () => {
    const result = environmentMismatches({
      ...base,
      observed: { ...base.observed, viewport: { width: 799, height: 600 } },
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toContain('viewport');
    expect(result[0]).toContain('799x600');
  });

  it('reports a device-scale mismatch, which is invisible in the viewport reading', () => {
    const result = environmentMismatches({
      ...base,
      observed: { ...base.observed, devicePixelRatio: 1 },
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toContain('device scale factor');
  });

  it('reports a browser mismatch', () => {
    expect(environmentMismatches({ ...base, browserName: 'firefox' })[0]).toContain('browser');
  });

  it('reports a colour-scheme mismatch against the resolved theme', () => {
    const result = environmentMismatches({
      ...base,
      requested: { ...ENVIRONMENT, theme: 'dark' },
      themeApplication: { colorScheme: 'dark' },
      observed: { ...base.observed, prefersDark: false },
    });
    expect(result[0]).toContain("theme 'dark'");
    expect(result[0]).toContain('page reports light');
  });

  it('reports a theme attribute that never landed', () => {
    const result = environmentMismatches({
      ...base,
      themeApplication: {
        colorScheme: 'light',
        documentAttribute: { name: 'data-theme', value: 'light' },
      },
      observed: { ...base.observed, documentAttributeValue: null },
    });
    expect(result[0]).toContain('data-theme');
    expect(result[0]).toContain('no such attribute');
  });

  it('reports silent font substitution, naming the families', () => {
    const result = environmentMismatches({
      ...base,
      requested: { ...ENVIRONMENT, fontSet: 'brand' },
      observed: { ...base.observed, missingFontFamilies: ['Inter', 'Iosevka'] },
    });
    expect(result[0]).toContain('Inter, Iosevka');
    expect(result[0]).toContain('substituted silently');
  });

  it('reports fonts that never finished loading', () => {
    expect(
      environmentMismatches({ ...base, observed: { ...base.observed, fontsReady: false } })[0],
    ).toContain('document.fonts');
  });

  it('reports motion that was never reduced', () => {
    expect(
      environmentMismatches({
        ...base,
        observed: { ...base.observed, prefersReducedMotion: false },
      })[0],
    ).toContain('reduced motion');
  });

  it('reports EVERY mismatch at once, so one fix pass can address them all', () => {
    const result = environmentMismatches({
      ...base,
      browserName: 'webkit',
      observed: {
        ...base.observed,
        viewport: { width: 1, height: 1 },
        devicePixelRatio: 1,
        prefersReducedMotion: false,
        missingFontFamilies: ['Inter'],
      },
    });
    expect(result.length).toBeGreaterThanOrEqual(5);
  });
});

// ─── refusals that happen before a browser is opened ─────────────────────────

describe('pre-flight refusals', () => {
  it.each([
    [
      'a non-PNG output path',
      requestFor({ outputPath: '/tmp/capture.jpg' }),
      /must be a \.png/,
    ],
    [
      'a non-integer viewport width',
      requestFor({ environment: { ...ENVIRONMENT, viewport: { width: 800.5, height: 600 } } }),
      /viewport width/,
    ],
    [
      'a zero viewport height',
      requestFor({ environment: { ...ENVIRONMENT, viewport: { width: 800, height: 0 } } }),
      /viewport height/,
    ],
    [
      'a non-positive device scale factor',
      requestFor({ environment: { ...ENVIRONMENT, deviceScaleFactor: 0 } }),
      /device scale factor/,
    ],
    [
      'an unregistered theme',
      requestFor({ environment: { ...ENVIRONMENT, theme: 'midnight' } }),
      /no registered browser mapping/,
    ],
    [
      'an unregistered font set',
      requestFor({ environment: { ...ENVIRONMENT, fontSet: 'brand-2026' } }),
      /not registered/,
    ],
    [
      'an unregistered interaction state',
      requestFor({ environment: { ...ENVIRONMENT, state: 'hover' } }),
      /interaction state 'hover' is not registered/,
    ],
    [
      'a viewport and scale that do not land on whole pixels',
      requestFor({
        environment: {
          ...ENVIRONMENT,
          viewport: { width: 801, height: 600 },
          deviceScaleFactor: 1.5,
        },
      }),
      /does not produce whole pixels/,
    ],
  ])('refuses %s as unsupported-input', async (_label, request, pattern) => {
    const fake = makeFakeBrowser();
    const outcome = await captureImplementationTarget(request, 'http://x', depsFor(fake));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.invalidReason).toBe('unsupported-input');
    expect(outcome.detail).toMatch(pattern);
    // The decisive assertion: no browser was opened at all.
    expect(fake.calls.specs).toHaveLength(0);
  });

  it('allows a fractional device scale in full-page mode, where no pixel expectation is stated', async () => {
    const fake = makeFakeBrowser({
      artifacts: [{ ok: true, dimensions: { width: 1201, height: 4000 }, sha256: 'z'.repeat(64) }],
      observed: {
        ...observedFor(ENVIRONMENT),
        devicePixelRatio: 1.5,
        viewport: { width: 801, height: 600 },
      },
    });
    const outcome = await captureImplementationTarget(
      requestFor({
        mode: 'full-page',
        stabilityRetries: 0,
        environment: {
          ...ENVIRONMENT,
          viewport: { width: 801, height: 600 },
          deviceScaleFactor: 1.5,
        },
      }),
      'http://x',
      depsFor(fake),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('unreachable');
    expect(outcome.expectedDimensions).toBeUndefined();
  });
});

// ─── the capture path ────────────────────────────────────────────────────────

describe('captureImplementationTarget', () => {
  it('captures, and reports the OBSERVED environment plus the contracted dimensions', async () => {
    const fake = makeFakeBrowser();
    const outcome = await captureImplementationTarget(
      requestFor({ stabilityRetries: 0 }),
      'http://x/iframe.html?id=a--b',
      depsFor(fake),
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('unreachable');
    expect(outcome.imagePath).toBe('/tmp/capture.png');
    expect(outcome.url).toBe('http://x/iframe.html?id=a--b');
    expect(outcome.dimensions).toEqual({ width: 1600, height: 1200 });
    expect(outcome.expectedDimensions).toEqual({ width: 1600, height: 1200 });
    expect(outcome.observed.devicePixelRatio).toBe(2);
    expect(outcome.stabilityAttempts).toBe(0);
  });

  it('pins the whole environment at context creation and always requests reduced motion', async () => {
    // deviceScaleFactor, colorScheme and reducedMotion are context-creation
    // options in Playwright and cannot be changed afterwards, so getting them
    // into the spec is the only chance to get them right.
    const inspectable = makeFakeBrowser({
      observed: { ...observedFor(ENVIRONMENT), prefersDark: true },
    });
    const outcome = await captureImplementationTarget(
      requestFor({ stabilityRetries: 0, environment: { ...ENVIRONMENT, theme: 'dark' } }),
      'http://x',
      depsFor(inspectable),
    );
    expect(outcome.ok).toBe(true);
    expect(inspectable.calls.specs[0]).toEqual({
      viewport: { width: 800, height: 600 },
      deviceScaleFactor: 2,
      colorScheme: 'dark',
      reducedMotion: 'reduce',
    });
  });

  it('drives the interaction state and settles before observing', async () => {
    const fake = makeFakeBrowser();
    await captureImplementationTarget(
      requestFor({ stabilityRetries: 0, networkIdleTimeoutMs: 1234 }),
      'http://x',
      depsFor(fake),
    );
    expect(fake.calls.states).toEqual([{ kind: 'none' }]);
    expect(fake.calls.settles[0]).toEqual({
      networkIdleTimeoutMs: 1234,
      requiredFontFamilies: [],
    });
  });

  it('applies a theme attribute when the resolved theme needs one', async () => {
    const fake = makeFakeBrowser({
      observed: { ...observedFor(ENVIRONMENT), documentAttributeValue: 'light' },
    });
    const outcome = await captureImplementationTarget(
      requestFor({ stabilityRetries: 0 }),
      'http://x',
      depsFor(fake, {
        themeResolver: () => ({
          colorScheme: 'light',
          documentAttribute: { name: 'data-theme', value: 'light' },
        }),
      }),
    );
    expect(outcome.ok).toBe(true);
    expect(fake.calls.attributes).toEqual([{ name: 'data-theme', value: 'light' }]);
  });

  it('REFUSES a mismatched environment WITHOUT writing an artifact', async () => {
    const fake = makeFakeBrowser({
      observed: { ...observedFor(ENVIRONMENT), devicePixelRatio: 1 },
    });
    const outcome = await captureImplementationTarget(
      requestFor(),
      'http://x',
      depsFor(fake),
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.invalidReason).toBe('environment-mismatch');
    expect(outcome.detail).toContain('device scale factor');
    expect(outcome.url).toBe('http://x');
    // This is the assertion that matters. A refusal that still wrote a PNG
    // leaves an artifact someone can later mistake for evidence.
    expect(fake.calls.screenshots).toHaveLength(0);
  });

  it('refuses when the produced image does not match the contracted geometry', async () => {
    const fake = makeFakeBrowser({
      artifacts: [{ ok: true, dimensions: { width: 1600, height: 1199 }, sha256: 'b'.repeat(64) }],
    });
    const outcome = await captureImplementationTarget(
      requestFor({ stabilityRetries: 0 }),
      'http://x',
      depsFor(fake),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.invalidReason).toBe('dimension-mismatch');
    expect(outcome.detail).toContain('capture-vs-contract');
    expect(outcome.detail).toContain('1600x1199');
  });

  it('never applies the geometry check in full-page mode', async () => {
    const fake = makeFakeBrowser({
      artifacts: [{ ok: true, dimensions: { width: 1600, height: 9999 }, sha256: 'c'.repeat(64) }],
    });
    const outcome = await captureImplementationTarget(
      requestFor({ mode: 'full-page', stabilityRetries: 0 }),
      'http://x',
      depsFor(fake),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('unreachable');
    expect(outcome.dimensions.height).toBe(9999);
    expect(outcome.expectedDimensions).toBeUndefined();
    expect(fake.calls.screenshots[0]?.fullPage).toBe(true);
  });

  it('accepts a capture that reproduces itself, reporting how many attempts it took', async () => {
    const stable = { ok: true as const, dimensions: { width: 1600, height: 1200 }, sha256: 'd'.repeat(64) };
    const fake = makeFakeBrowser({ artifacts: [stable, stable] });
    const outcome = await captureImplementationTarget(requestFor(), 'http://x', depsFor(fake));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('unreachable');
    expect(outcome.stabilityAttempts).toBe(1);
    expect(fake.calls.screenshots).toHaveLength(2);
  });

  it('refuses a capture that never reproduces itself', async () => {
    const fake = makeFakeBrowser({
      artifacts: [
        { ok: true, dimensions: { width: 1600, height: 1200 }, sha256: '1'.repeat(64) },
        { ok: true, dimensions: { width: 1600, height: 1200 }, sha256: '2'.repeat(64) },
        { ok: true, dimensions: { width: 1600, height: 1200 }, sha256: '3'.repeat(64) },
      ],
    });
    const outcome = await captureImplementationTarget(requestFor(), 'http://x', depsFor(fake));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.invalidReason).toBe('capture-failed');
    expect(outcome.detail).toContain('never reproduced itself');
    expect(fake.calls.screenshots).toHaveLength(3);
  });

  it('takes exactly one shot when the stability check is disabled', async () => {
    const fake = makeFakeBrowser({
      artifacts: [
        { ok: true, dimensions: { width: 1600, height: 1200 }, sha256: '1'.repeat(64) },
        { ok: true, dimensions: { width: 1600, height: 1200 }, sha256: '2'.repeat(64) },
      ],
    });
    const outcome = await captureImplementationTarget(
      requestFor({ stabilityRetries: 0 }),
      'http://x',
      depsFor(fake),
    );
    expect(outcome.ok).toBe(true);
    expect(fake.calls.screenshots).toHaveLength(1);
  });

  it('maps an unreadable artifact to capture-failed', async () => {
    const fake = makeFakeBrowser({ artifacts: [{ ok: false, detail: 'not a PNG' }] });
    const outcome = await captureImplementationTarget(requestFor(), 'http://x', depsFor(fake));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.invalidReason).toBe('capture-failed');
    expect(outcome.detail).toBe('not a PNG');
  });

  it('maps a navigation throw to capture-failed and still closes the page', async () => {
    const fake = makeFakeBrowser({ throwOnGoto: new Error('net::ERR_CONNECTION_REFUSED') });
    const outcome = await captureImplementationTarget(requestFor(), 'http://x', depsFor(fake));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.invalidReason).toBe('capture-failed');
    expect(outcome.detail).toContain('ERR_CONNECTION_REFUSED');
    expect(fake.calls.closes).toHaveLength(1);
  });

  it('survives a thrown value whose own message getter throws', async () => {
    // The P-005 lesson, re-tested at this seam: an error formatter on a
    // catch-everything path is handed the value that was already misbehaving.
    const hostile = new Error('x');
    Object.defineProperty(hostile, 'message', {
      get() {
        throw new Error('message getter exploded');
      },
    });
    const fake = makeFakeBrowser({ throwOnGoto: hostile });
    const outcome = await captureImplementationTarget(requestFor(), 'http://x', depsFor(fake));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.invalidReason).toBe('capture-failed');
    expect(outcome.detail).toContain('could not be described');
  });

  it('does not let a page that will not close invalidate a successful capture', async () => {
    const fake = makeFakeBrowser({ throwOnClose: new Error('target closed') });
    const outcome = await captureImplementationTarget(
      requestFor({ stabilityRetries: 0 }),
      'http://x',
      depsFor(fake),
    );
    expect(outcome.ok).toBe(true);
    expect(fake.calls.closes).toHaveLength(1);
  });
});

// ─── the two adapters ────────────────────────────────────────────────────────

describe('capture adapters', () => {
  it('builds a Storybook URL from the story id and turns the fixture into args', async () => {
    const fake = makeFakeBrowser();
    const adapter = createStorybookCaptureAdapter(depsFor(fake));
    await adapter.capture(
      requestFor({
        stabilityRetries: 0,
        environment: { ...ENVIRONMENT, fixture: 'size=large&tone=muted' },
      }),
    );
    expect(fake.calls.gotos[0]).toBe(
      'http://127.0.0.1:6006/iframe.html?id=components-button--primary&viewMode=story&args=size:large;tone:muted',
    );
  });

  it('routes a page-route target to a joined origin', async () => {
    const fake = makeFakeBrowser();
    const adapter = createPageRouteCaptureAdapter(depsFor(fake));
    await adapter.capture(
      requestFor({
        stabilityRetries: 0,
        target: ROUTE_TARGET,
        baseUrl: 'http://127.0.0.1:3055',
        mode: 'full-page',
      }),
    );
    expect(fake.calls.gotos[0]).toBe('http://127.0.0.1:3055/settings');
  });

  it('each adapter refuses the other adapter’s target kind', async () => {
    const fake = makeFakeBrowser();
    const storybook = await createStorybookCaptureAdapter(depsFor(fake)).capture(
      requestFor({ target: ROUTE_TARGET }),
    );
    expect(storybook.ok).toBe(false);
    if (storybook.ok) throw new Error('unreachable');
    expect(storybook.invalidReason).toBe('unsupported-input');
    expect(storybook.detail).toContain('page-route adapter');

    const route = await createPageRouteCaptureAdapter(depsFor(fake)).capture(
      requestFor({ target: STORY_TARGET }),
    );
    expect(route.ok).toBe(false);
    if (route.ok) throw new Error('unreachable');
    expect(route.detail).toContain('Storybook adapter');
    expect(fake.calls.specs).toHaveLength(0);
  });

  it('declares the target kinds it handles, with no overlap between the two', () => {
    const fake = makeFakeBrowser();
    const storybook = createStorybookCaptureAdapter(depsFor(fake));
    const route = createPageRouteCaptureAdapter(depsFor(fake));
    const overlap = storybook.targetKinds.filter((k) => route.targetKinds.includes(k));
    expect(overlap).toEqual([]);
    expect([...storybook.targetKinds, ...route.targetKinds].sort()).toEqual([
      'component',
      'page-route',
      'storybook-story',
    ]);
  });
});

// ─── the filesystem artifact reader ──────────────────────────────────────────

describe('filesystemCaptureArtifactReader', () => {
  it('reads dimensions and a stable digest from a real PNG', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pc-capture-'));
    try {
      const file = path.join(dir, 'shot.png');
      const png = makePngBytes(7, 3);
      writeFileSync(file, png);

      const first = filesystemCaptureArtifactReader(file);
      const second = filesystemCaptureArtifactReader(file);
      expect(first.ok).toBe(true);
      if (!first.ok || !second.ok) throw new Error('unreachable');
      expect(first.dimensions).toEqual({ width: 7, height: 3 });
      // Cross-check against the module that actually owns PNG parsing.
      expect(readPngDimensions(png)).toEqual(first.dimensions);
      expect(first.sha256).toBe(second.sha256);
      expect(first.sha256).toHaveLength(64);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('distinguishes a missing file from a corrupt one', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pc-capture-'));
    try {
      const missing = filesystemCaptureArtifactReader(path.join(dir, 'nope.png'));
      expect(missing.ok).toBe(false);
      if (missing.ok) throw new Error('unreachable');
      expect(missing.detail).toContain('could not be read');

      const corruptPath = path.join(dir, 'corrupt.png');
      writeFileSync(corruptPath, Buffer.from('this is not a png at all'));
      const corrupt = filesystemCaptureArtifactReader(corruptPath);
      expect(corrupt.ok).toBe(false);
      if (corrupt.ok) throw new Error('unreachable');
      expect(corrupt.detail).toContain('not a readable PNG');
      // The two failures have different owners — a capture pipeline bug and a
      // corrupt artifact are not the same incident.
      expect(corrupt.detail).not.toContain('could not be read');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** Minimal valid PNG signature + IHDR, enough for the header reader. */
function makePngBytes(width: number, height: number): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(13, 0);
  const type = Buffer.from('IHDR', 'ascii');
  const data = Buffer.alloc(13);
  data.writeUInt32BE(width, 0);
  data.writeUInt32BE(height, 4);
  data[8] = 8;
  data[9] = 6;
  return Buffer.concat([signature, length, type, data, Buffer.alloc(4)]);
}
