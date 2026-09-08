// @vitest-environment jsdom

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
const sourcePath = process.env.SERVICENOW_INTERVIEW_PREP_FILE ?? manifest.sourcePath;

const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const normalized = (value: string | null | undefined): string => value?.replace(/\s+/g, ' ').trim() ?? '';
const withoutTerminalPeriod = (value: string): string => value.replace(/\.$/, '');

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
  it('pins the exact reviewed source and answer-bank snapshots', () => {
    expect(sha256(html)).toBe(manifest.sourceSha256);
    expect(sha256(readFileSync(manifest.answerBankPath))).toBe(manifest.answerBankSha256);
    expect(manifest.manualReview.result).toBe('pass');
    expect(manifest.manualReview.scope).toHaveLength(6);
    expect(manifest.manualReview.falsifierCoverage).toHaveLength(4);
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

  it('keeps the interview date explicitly unknown and the role match explicitly inferred', () => {
    const dateFact = [...document.querySelectorAll<HTMLElement>('.facts .fact')].find(
      (fact) => normalized(fact.querySelector('dt')?.textContent) === 'Date',
    );
    const meetingCard = document.querySelector<HTMLElement>('.join-card');
    const roleInference = document.querySelector<HTMLElement>('#thesis .note.warn');

    expect(normalized(dateFact?.querySelector('dd')?.textContent)).toBe('Not supplied');
    expect(normalized(meetingCard?.textContent)).toContain('Date was not included in the supplied calendar text.');
    expect(meetingCard?.querySelector('time, [datetime]')).toBeNull();
    expect(normalized(roleInference?.textContent)).toContain('JB0074818');
    expect(normalized(roleInference?.textContent)).toMatch(/likely match, not a confirmed fact/i);
  });

  it('contains the role map, technical drills, motivation scripts, and separate question banks', () => {
    const matrixRows = document.querySelectorAll('#coverage table.matrix tbody tr');
    const drills = document.querySelectorAll('#drills details.drill');
    const motivationScripts = [...document.querySelectorAll<HTMLElement>('#why .script .say')];
    const questionCards = [...document.querySelectorAll<HTMLElement>('#questions .question-grid > article.card')];
    const questionHeadingDigests = questionCards.map((card) => sha256(normalized(card.querySelector('.rank')?.textContent)));

    expect(matrixRows).toHaveLength(12);
    expect(drills).toHaveLength(10);
    expect(motivationScripts).toHaveLength(2);
    for (const script of motivationScripts) {
      expect(normalized(script.textContent)).toMatch(/ServiceNow/);
      expect(normalized(script.textContent)).toMatch(/(?:agent|runtime|CPQ)/i);
    }
    expect(questionCards).toHaveLength(2);
    expect(questionHeadingDigests).toEqual(manifest.expectedDigests.interviewerQuestionHeadingSha256);
    expect(questionCards.map((card) => card.querySelectorAll('ol.question-list > li').length)).toEqual([10, 7]);
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

    expect(document.querySelectorAll('main#main > section')).toHaveLength(10);
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
