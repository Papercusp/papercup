/**
 * rules.test.ts — playbook segmentation + ablation (FB-09 / P-023).
 * Pure unit: a synthetic fixture pins the segmentation contract; the REAL
 * playbook body (the exact text the su target feeds the SUT) pins that the
 * rotation pool stays non-trivial and every unit round-trips ablateRule.
 */
import { beforeAll, describe, expect, it } from 'vitest';

import { loadPlaybookBody } from '../llm-testing/targets/su';
import { ablateRule, extractAblatableRules, hashPlaybookBody, hashRuleText, normalizeRuleText } from './rules';

const FIXTURE = [
  '# Some playbook',
  '',
  '> preamble blockquote — never a rule (before the first ## section)',
  '',
  '## Working rules',
  '',
  '**Always frobnicate before you defrobnicate.** The frobnication order is',
  'load-bearing because the defrobnicator assumes warmed caches.',
  '',
  '- **Locks are ENFORCED, not advisory.** A hook claims each file;',
  '  when blocked, pivot to other work.',
  '  - nested detail line rides along',
  '- short', // too short — filtered
  '- **Never poll; await.** Register a one-shot wake on an exact event key and end your turn.',
  '',
  '```bash',
  '- **not a rule** — inside a fence',
  '```',
  '',
  '## Discipline',
  '',
  '- **Locks are ENFORCED, not advisory.** Duplicate lead in another section gets its own key.',
  '',
  '**Tests ship with the feature.** Use the canonical homes, not ad-hoc scripts;',
  'a passing typecheck is not a test.',
  '',
].join('\n');

describe('extractAblatableRules', () => {
  it('segments bold-led bullets and paragraphs under ## sections, skipping fences/preamble/fragments', () => {
    const rules = extractAblatableRules(FIXTURE);
    const keys = rules.map((r) => r.ruleKey);
    expect(keys).toEqual([
      'working-rules/always-frobnicate-before-you-defrobnicate',
      'working-rules/locks-are-enforced-not-advisory',
      'working-rules/never-poll-await',
      'discipline/locks-are-enforced-not-advisory',
      'discipline/tests-ship-with-the-feature',
    ]);
    // bullet continuation (indented + nested) rides along
    const lock = rules[1]!;
    expect(lock.text).toContain('pivot to other work');
    expect(lock.text).toContain('nested detail line');
    // paragraph extent: contiguous non-blank lines
    const tests = rules[4]!;
    expect(tests.text).toContain('a passing typecheck is not a test');
    // section attribution
    expect(rules[0]!.sectionHeading).toBe('Working rules');
    expect(rules[3]!.sectionHeading).toBe('Discipline');
  });

  it('is deterministic and content-hashed', () => {
    const a = extractAblatableRules(FIXTURE);
    const b = extractAblatableRules(FIXTURE);
    expect(a).toEqual(b);
    expect(a[0]!.contentHash).toBe(hashRuleText(a[0]!.text));
    expect(a[0]!.contentHash).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe('ablateRule', () => {
  it('removes exactly the rule unit (plus its trailing blank) and nothing else', () => {
    const rules = extractAblatableRules(FIXTURE);
    const target = rules[2]!; // never-poll-await
    const ablated = ablateRule(FIXTURE, target);
    expect(ablated).not.toContain('Never poll; await.');
    expect(ablated.length).toBeLessThan(FIXTURE.length);
    // every OTHER rule survives verbatim
    for (const other of rules.filter((r) => r.ruleKey !== target.ruleKey)) {
      expect(normalizeRuleText(ablated)).toContain(normalizeRuleText(other.text));
    }
    // and the remainder still segments cleanly (minus the one unit)
    expect(extractAblatableRules(ablated).map((r) => r.ruleKey)).toEqual(
      rules.filter((r) => r.ruleKey !== target.ruleKey).map((r) => r.ruleKey),
    );
  });

  it('throws when the body drifted from the extraction snapshot', () => {
    const rules = extractAblatableRules(FIXTURE);
    const drifted = `${FIXTURE}\n\nextra`.replace('Always frobnicate', 'Sometimes frobnicate');
    expect(() => ablateRule(drifted, rules[0]!)).toThrow(/drifted/);
  });
});

describe('the real SU playbook', () => {
  let body = '';

  beforeAll(async () => {
    body = await loadPlaybookBody();
  });

  it('yields a non-trivial rotation pool with unique keys', () => {
    const rules = extractAblatableRules(body);
    // The playbook carries ~40 bold-led hard rules; a collapse below 20 means
    // either the playbook was gutted or the segmenter regressed — both worth a
    // loud stop before a cycle burns budget measuring nothing.
    expect(rules.length).toBeGreaterThanOrEqual(20);
    expect(new Set(rules.map((r) => r.ruleKey)).size).toBe(rules.length);
  });

  it('every extracted rule ablates cleanly from the live body', () => {
    const rules = extractAblatableRules(body);
    for (const rule of rules) {
      const ablated = ablateRule(body, rule);
      expect(ablated.length).toBeLessThan(body.length);
      expect(hashPlaybookBody(ablated)).not.toBe(hashPlaybookBody(body));
    }
  });
});
