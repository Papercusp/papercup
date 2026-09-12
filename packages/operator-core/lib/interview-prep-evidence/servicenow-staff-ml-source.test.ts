// @vitest-environment jsdom

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

interface ReviewManifest {
  sourcePath: string;
  sourceSha256: string;
  answerBankPath: string;
  answerBankSha256: string;
  expectedDigests: {
    meetingTimeTextSha256: string;
    participantsTextSha256: string;
    meetingUrlSha256: string;
    interviewerQuestionHeadingSha256: string[];
  };
  manualReview: {
    result: string;
    scope: string[];
    falsifierCoverage: string[];
  };
}

const manifestPath = [
  resolve(process.cwd(), 'lib/interview-prep-evidence/servicenow-staff-ml-manual-review.json'),
  resolve(process.cwd(), 'packages/operator-core/lib/interview-prep-evidence/servicenow-staff-ml-manual-review.json'),
].find(existsSync);
if (!manifestPath) throw new Error('servicenow_staff_ml_review_manifest_not_found');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ReviewManifest;
const resolveEvidencePath = (path: string): string => (isAbsolute(path) ? path : resolve(homedir(), path));
const sourcePath = process.env.SERVICENOW_INTERVIEW_PREP_FILE ?? resolveEvidencePath(manifest.sourcePath);

const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const normalized = (value: string | null | undefined): string => value?.replace(/\s+/g, ' ').trim() ?? '';
const withoutTerminalPeriod = (value: string): string => value.replace(/\.$/, '');
const reviewedCollectionSlugs = [
  'mcp-cicd-study-faq',
  'papercusp-answer-bank',
  'rtx-hirevue-prep',
  'servicenow-staff-ml-interview-prep',
  'twg-recruiter-screen',
];
const collectionDir = dirname(sourcePath);
const buildScript = readFileSync(resolve(collectionDir, 'build-standalone.sh'), 'utf8');
const sourceBlock = buildScript.match(/SOURCES=\(([\s\S]*?)\n\)/);
if (!sourceBlock) throw new Error('interview_prep_collection_not_declared');
const collectionSlugs = [...sourceBlock[1].matchAll(/"([a-z0-9-]+)\.html"/g)].map((match) => match[1]);
const expectedCollectionTargets = collectionSlugs.map((slug) => `${slug}-standalone.html`).sort();

// Shared navigation grows independently of this reviewed role document. Reconstruct ONLY
// its original navigation for the historical hash; the current collection is checked below.
function reviewedSource(source: string): string {
  return source.replace(/<nav class="sitenav"[\s\S]*?<\/nav>/, (nav) =>
    nav.split('\n').filter((line) => {
      const target = line.match(/href="([^"]+)\.html"/);
      return line.trim() !== '' && (!target || reviewedCollectionSlugs.includes(target[1]));
    }).join('\n'),
  );
}

function reciprocalCollectionTargets(document: Document): string[] {
  return [
    ...new Set(
      [...document.querySelectorAll<HTMLAnchorElement>('a[href$="-standalone.html"]')]
        .map((link) => link.getAttribute('href'))
        .filter((href): href is string => href !== null),
    ),
  ].sort();
}

function expectExactReciprocalCollection(document: Document, label: string): void {
  const targets = reciprocalCollectionTargets(document);
  expect(targets, `${label} does not expose the exact reciprocal collection`).toEqual(expectedCollectionTargets);
  expect(targets).not.toContain('nonexistent-interview-prep-standalone.html');
}

function factValue(scope: ParentNode, label: string): string {
  const item = [...scope.querySelectorAll('li')].find((candidate) =>
    normalized(candidate.textContent).startsWith(`${label}:`),
  );
  expect(item, `missing ${label} fact`).toBeDefined();
  return withoutTerminalPeriod(normalized(item?.textContent).slice(label.length + 1).trim());
}

let html = '';

beforeAll(() => {
  html = readFileSync(sourcePath, 'utf8');
  document.body.innerHTML = html;
});

describe('ServiceNow Staff ML interview-prep source contract', () => {
  it('pins the reviewed role content while allowing maintained shared navigation to grow', () => {
    expect(sha256(reviewedSource(html))).toBe(manifest.sourceSha256);
    expect(manifest.manualReview.result).toBe('pass');
    expect(manifest.manualReview.scope.length).toBeGreaterThanOrEqual(6);
    expect(manifest.manualReview.falsifierCoverage.length).toBeGreaterThanOrEqual(4);
  });

  it('retains content-change detection and resolves the independently maintained answer bank', () => {
    const mutated = html.replace('744000146824899', 'JB0074818');
    expect(mutated).not.toBe(html);
    expect(sha256(reviewedSource(mutated))).not.toBe(manifest.sourceSha256);
    // The answer bank received factual corrections after this role page shipped. Its
    // historical review digest is provenance, not a freeze on that reusable dependency.
    const answerBank = new DOMParser().parseFromString(
      readFileSync(resolveEvidencePath(manifest.answerBankPath), 'utf8'), 'text/html',
    );
    expect(answerBank.querySelector('h1')?.textContent?.trim()).toBeTruthy();
    const links = [...document.querySelectorAll<HTMLAnchorElement>('a[href^="papercusp-answer-bank.html"]')];
    expect(links.length).toBeGreaterThanOrEqual(3);
    for (const link of links) {
      if (link.hash) expect(answerBank.getElementById(decodeURIComponent(link.hash.slice(1)))).not.toBeNull();
    }
  });

  it('keeps every generated standalone page discoverable from the full collection', () => {
    expect(collectionSlugs).toEqual(expect.arrayContaining(reviewedCollectionSlugs));
    expect(new Set(collectionSlugs).size).toBe(collectionSlugs.length);

    for (const slug of collectionSlugs) {
      expect(buildScript, `build omits ${slug}.html`).toContain(`"${slug}.html"`);
      const standalonePath = resolve(collectionDir, `${slug}-standalone.html`);
      expect(existsSync(standalonePath), `missing ${standalonePath}`).toBe(true);
      const standalone = new DOMParser().parseFromString(readFileSync(standalonePath, 'utf8'), 'text/html');

      expect(standalone.compatMode, `${slug} rendered in quirks mode`).toBe('CSS1Compat');
      expect(standalone.querySelector('meta[name="viewport"]'), `${slug} lacks viewport metadata`).not.toBeNull();
      expectExactReciprocalCollection(standalone, slug);
    }
  });

  it('kills missing-link and extra-link reciprocal collection mutants', () => {
    const baselineHtml = readFileSync(
      resolve(dirname(sourcePath), 'servicenow-staff-ml-interview-prep-standalone.html'),
      'utf8',
    );
    const baseline = new DOMParser().parseFromString(baselineHtml, 'text/html');
    expect(() => expectExactReciprocalCollection(baseline, 'baseline')).not.toThrow();

    const missingLinkMutant = new DOMParser().parseFromString(baselineHtml, 'text/html');
    const removedLink = missingLinkMutant.querySelector<HTMLAnchorElement>(
      `a[href="${expectedCollectionTargets[0]}"]`,
    );
    expect(removedLink).not.toBeNull();
    removedLink?.remove();
    expect(() => expectExactReciprocalCollection(missingLinkMutant, 'missing-link mutant')).toThrow();

    const extraLinkMutant = new DOMParser().parseFromString(baselineHtml, 'text/html');
    const extraLink = extraLinkMutant.createElement('a');
    extraLink.href = 'nonexistent-interview-prep-standalone.html';
    extraLinkMutant.body.append(extraLink);
    expect(() => expectExactReciprocalCollection(extraLinkMutant, 'extra-link mutant')).toThrow();
  });

  it('preserves supplied meeting details without exposing them in the tracked test', () => {
    const meetingCard = document.querySelector<HTMLElement>('.join-card');
    const ownerFacts = [...document.querySelectorAll<HTMLElement>('#sources article')].find((article) =>
      article.querySelector('.badge.owner'),
    );
    const meetingLink = meetingCard?.querySelector<HTMLAnchorElement>('a.button[href]');

    expect(meetingCard).not.toBeNull();
    expect(ownerFacts).toBeDefined();
    expect(sha256(normalized(meetingCard?.querySelector('strong')?.textContent))).toBe(
      manifest.expectedDigests.meetingTimeTextSha256,
    );
    expect(sha256(factValue(ownerFacts!, 'Participants'))).toBe(manifest.expectedDigests.participantsTextSha256);
    expect(sha256(factValue(ownerFacts!, 'Time'))).toBe(manifest.expectedDigests.meetingTimeTextSha256);
    expect(sha256(meetingLink?.href ?? '')).toBe(manifest.expectedDigests.meetingUrlSha256);
    expect(meetingLink?.target).toBe('_blank');
    expect(meetingLink?.rel.split(/\s+/)).toContain('noreferrer');
  });

  it('keeps the interview date unknown and the confirmed role provenance internally consistent', () => {
    const dateFact = [...document.querySelectorAll<HTMLElement>('.facts .fact')].find(
      (fact) => normalized(fact.querySelector('dt')?.textContent) === 'Date',
    );
    const meetingCard = document.querySelector<HTMLElement>('.join-card');
    const ownerFacts = [...document.querySelectorAll<HTMLElement>('#sources article')].find((article) =>
      article.querySelector('.badge.owner'),
    );
    const thirdDrillTitle = normalized(document.querySelectorAll('#drills details.drill > summary')[2]?.textContent);

    expect(normalized(dateFact?.querySelector('dd')?.textContent)).toBe('Not supplied');
    expect(normalized(meetingCard?.textContent)).toContain('Date was not included in the supplied calendar text.');
    expect(meetingCard?.querySelector('time, [datetime]')).toBeNull();
    expect(ownerFacts).toBeDefined();
    expect(normalized(ownerFacts?.textContent)).toContain('744000146824899');
    expect(normalized(ownerFacts?.textContent)).toMatch(/owner has (?:now )?confirmed/i);
    expect(normalized(document.body.textContent)).not.toContain('JB0074818');
    expect(normalized(document.body.textContent)).not.toMatch(/likely match, not a confirmed fact/i);
    expect(thirdDrillTitle).not.toMatch(/^3\. Where should the Harness stop and MCP begin\?/);
  });

  it('kills a superseded-requisition provenance mutant', () => {
    const mutantHtml = html.replaceAll('744000146824899', 'JB0074818');
    expect(mutantHtml).not.toBe(html);
    const mutant = new DOMParser().parseFromString(mutantHtml, 'text/html');
    const ownerFacts = [...mutant.querySelectorAll<HTMLElement>('#sources article')].find((article) =>
      article.querySelector('.badge.owner'),
    );

    expect(ownerFacts).toBeDefined();
    expect(() => {
      expect(normalized(ownerFacts?.textContent)).toContain('744000146824899');
      expect(normalized(ownerFacts?.textContent)).not.toContain('JB0074818');
    }).toThrow();
  });

  it('contains the role map, technical drills, motivation scripts, and separate question banks', () => {
    const matrixRows = document.querySelectorAll('#coverage table.matrix tbody tr');
    const drills = document.querySelectorAll('#drills details.drill');
    const motivationScripts = [...document.querySelectorAll<HTMLElement>('#why .script .say')];
    const questionCards = [...document.querySelectorAll<HTMLElement>('#questions .question-grid > article.card')];
    const questionHeadingDigests = questionCards.map((card) => sha256(normalized(card.querySelector('.rank')?.textContent)));

    expect(matrixRows.length).toBeGreaterThanOrEqual(12);
    expect(drills.length).toBeGreaterThanOrEqual(10);
    expect(motivationScripts).toHaveLength(2);
    for (const script of motivationScripts) {
      expect(normalized(script.textContent)).toMatch(/ServiceNow/);
      expect(normalized(script.textContent)).toMatch(/(?:agent|runtime|CPQ)/i);
    }
    expect(questionCards).toHaveLength(2);
    expect(questionHeadingDigests).toEqual(manifest.expectedDigests.interviewerQuestionHeadingSha256);
    expect(questionCards[0]?.querySelectorAll('ol.question-list > li').length).toBeGreaterThanOrEqual(10);
    expect(questionCards[1]?.querySelectorAll('ol.question-list > li').length).toBeGreaterThanOrEqual(7);
  });

  it('links personal stories to the answer bank and rejects invented-experience markers', () => {
    const answerBankLinks = [...document.querySelectorAll<HTMLAnchorElement>('a[href="papercusp-answer-bank.html"]')];
    const firstPersonDrafts = normalized(
      [...document.querySelectorAll<HTMLElement>('#opener .say, #why .say')]
        .map((element) => element.textContent)
        .join(' '),
    );
    const opener = normalized(document.querySelector('#opener')?.textContent);

    expect(answerBankLinks.length).toBeGreaterThanOrEqual(3);
    expect(opener).toMatch(/keep only claims you can prove/i);
    expect(opener).toMatch(/Do not invent scale, latency, revenue, or team-size numbers/i);
    expect(firstPersonDrafts).not.toMatch(/\bI (?:built|led|shipped|reduced|increased|saved|managed)\b/i);
    expect(firstPersonDrafts).not.toMatch(/(?:\$\s?\d|\b\d+(?:\.\d+)?%)/);
  });

  it('keeps source-fragment navigation and link security structurally sound', () => {
    const ids = [...document.querySelectorAll<HTMLElement>('[id]')].map((element) => element.id);
    const internalLinks = [...document.querySelectorAll<HTMLAnchorElement>('a[href^="#"]')];
    const externalBlankLinks = [...document.querySelectorAll<HTMLAnchorElement>('a[href^="http"][target="_blank"]')];

    expect(document.querySelectorAll('main#main > section').length).toBeGreaterThanOrEqual(10);
    expect(new Set(ids).size).toBe(ids.length);
    for (const link of internalLinks) {
      expect(document.getElementById(decodeURIComponent(link.hash.slice(1))), `unresolved ${link.hash}`).not.toBeNull();
    }
    for (const link of externalBlankLinks) {
      expect(link.rel.split(/\s+/), `${link.href} lacks noreferrer`).toContain('noreferrer');
    }
    expect(document.querySelector('script')).toBeNull();
    expect(html).not.toMatch(/\b(?:TODO|TBD|FIXME)\b/);
  });
});
