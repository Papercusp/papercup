/**
 * EI-21527168552259156 — the Slack setup runbook must stay executable as the
 * provider-token routes evolve. The original defect was a doc that prescribed
 * bare curl while both routes deliberately rejected unverified-loopback.
 *
 * The fixture controls are load-bearing: once the live claim goes green they
 * stop proving that the detector can see drift. Keep controls for both axes —
 * the route trust contract and each prescribed curl header.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import routes from '../endpoint-route/routes/admin/external-triggers';
import {
  judgeSlackSetupDoc,
  SLACK_SETUP_ROUTES,
  SLACK_SETUP_TRUST,
  SUPERUSER_CURL_HEADER,
  type SlackRouteTrust,
} from './slack-external-trigger-setup';

// lib/doc-claims → lib → operator-core → packages → <repo root>
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const DOC = join(ROOT, 'apps/operator-docs/src/content/docs/reference/slack-external-trigger-setup.mdx');

type RouteLike = {
  path?: string;
  auth?: { trust?: readonly string[] };
};

function liveSlackRoutes(): SlackRouteTrust[] {
  return (routes as readonly RouteLike[])
    .filter((route) => route.path && SLACK_SETUP_ROUTES.includes(route.path as (typeof SLACK_SETUP_ROUTES)[number]))
    .map((route) => ({ path: route.path!, trust: [...(route.auth?.trust ?? [])] }));
}

function removeHeaderFromSection(markdown: string, heading: string): string {
  const sectionStart = markdown.indexOf(heading);
  if (sectionStart < 0) throw new Error(`missing fixture heading: ${heading}`);
  return markdown.slice(0, sectionStart) + markdown.slice(sectionStart).replace(SUPERUSER_CURL_HEADER, '');
}

describe('Slack external-trigger setup doc claims', () => {
  const source = readFileSync(DOC, 'utf8');
  const liveRoutes = liveSlackRoutes();

  describe('fixture controls (the detector must be able to FAIL)', () => {
    it('catches a future route widening that makes the runbook claim stale', () => {
      const widened = liveRoutes.map((route) => ({
        ...route,
        trust: [...route.trust, 'unverified-loopback'],
      }));
      const verdict = judgeSlackSetupDoc(source, widened);
      expect(verdict.ok).toBe(false);
      expect(verdict.violations.join('\n')).toMatch(/auth\.trust/);
    });

    it('catches the runbook trust claim widening without a matching route contract', () => {
      const widenedDoc = source.replace(
        "auth: { trust: ['verified', 'trusted'] }",
        "auth: { trust: ['verified', 'trusted', 'unverified-loopback'] }",
      );
      const verdict = judgeSlackSetupDoc(widenedDoc, liveRoutes);
      expect(verdict.ok).toBe(false);
      expect(verdict.violations.join('\n')).toMatch(/auth\.trust/);
    });

    it('catches the manifest curl losing its bearer header', () => {
      const broken = removeHeaderFromSection(source, '## 1.');
      const verdict = judgeSlackSetupDoc(broken, liveRoutes);
      expect(verdict.ok).toBe(false);
      expect(verdict.violations.join('\n')).toMatch(/section 1 curl/);
    });

    it('catches the connect curl losing its bearer header', () => {
      const broken = removeHeaderFromSection(source, '## 3.');
      const verdict = judgeSlackSetupDoc(broken, liveRoutes);
      expect(verdict.ok).toBe(false);
      expect(verdict.violations.join('\n')).toMatch(/section 3 curl/);
    });

    it('REFUSES a short/empty read instead of reporting it clean', () => {
      expect(() => judgeSlackSetupDoc('', liveRoutes)).toThrow(/Refusing to judge/);
      expect(() => judgeSlackSetupDoc('curl /admin/triggers/slack/manifest', liveRoutes)).toThrow(
        /Refusing to judge/,
      );
    });
  });

  describe('the live claim', () => {
    it('positive control: the canonical runbook was actually read', () => {
      expect(source.length).toBeGreaterThan(2_000);
      expect(source).toContain('/admin/triggers/slack/manifest');
      expect(source).toContain('/admin/triggers/slack/connect');
    });

    it('keeps both live Slack routes on the deliberate verified/trusted contract', () => {
      expect(liveRoutes).toEqual([
        { path: '/admin/triggers/slack/manifest', trust: [...SLACK_SETUP_TRUST] },
        { path: '/admin/triggers/slack/connect', trust: [...SLACK_SETUP_TRUST] },
      ]);
    });

    it('keeps the runbook trust claim and both setup commands aligned with live code', () => {
      const verdict = judgeSlackSetupDoc(source, liveRoutes);
      expect(verdict.violations).toEqual([]);
      expect(verdict.ok).toBe(true);
      expect(verdict.docTrust).toEqual([...SLACK_SETUP_TRUST]);
      expect(verdict.checkedRoutes).toEqual([...SLACK_SETUP_ROUTES]);
      expect(source).toContain(SUPERUSER_CURL_HEADER);
    });
  });
});
