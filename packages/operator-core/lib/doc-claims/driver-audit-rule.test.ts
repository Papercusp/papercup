/**
 * R-13 (expensive-verification-loops-2026-09-29): the domain-neutral base persona
 * every agent receives states the "two different failures, then audit the harness"
 * rule. See `driver-audit-rule.ts` for why. The fixture controls keep the judge
 * honest: once the live assertion is green it stops being evidence the judge can fail.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { judgeDriverAuditRule } from './driver-audit-rule';

// lib/doc-claims → lib → operator-core → packages → <repo root>
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const BASE_PERSONA = resolve(
  ROOT,
  'libs/papercusp/packages/harness/blueprints/base/prompts/agent-base-preamble.md',
);

describe('judgeDriverAuditRule — controls', () => {
  it('accepts a paragraph carrying trigger, action and timing together', () => {
    const v = judgeDriverAuditRule(
      'Intro.\n\nWhen a slow check has failed twice with different causes, stop and audit the harness before the next attempt.\n',
    );
    expect(v.ok).toBe(true);
    expect(v.paragraph).toMatch(/audit the harness/);
  });

  it('refuses the rule scattered across paragraphs', () => {
    const v = judgeDriverAuditRule(
      'If a check failed twice with different causes, note it.\n\nAudit the harness sometimes.\n\nThink before the next attempt.',
    );
    expect(v.ok).toBe(false);
    expect(v.missing.length).toBeGreaterThan(0);
  });

  it('names the missing part: no harness audit', () => {
    const v = judgeDriverAuditRule('After two failures with different causes, just re-run it before the next attempt.');
    expect(v.ok).toBe(false);
    expect(v.missing).toEqual(['action']);
  });

  it('names the missing part: same-cause trigger is not the rule', () => {
    const v = judgeDriverAuditRule('After two failures, audit the harness before the next attempt.');
    expect(v.ok).toBe(false);
    expect(v.missing).toEqual(['trigger']);
  });

  it('refuses an empty subject', () => {
    expect(judgeDriverAuditRule('').ok).toBe(false);
  });
});

describe('the base persona states the driver audit rule (R-13)', () => {
  it('agent-base-preamble.md carries the rule in one paragraph', () => {
    const text = readFileSync(BASE_PERSONA, 'utf8');
    const v = judgeDriverAuditRule(text);
    expect(v.missing, `base persona is missing: ${v.missing.join(', ')}`).toEqual([]);
    expect(v.ok).toBe(true);
    // The rule must name the mechanical backstop so agents know it is enforced.
    expect(v.paragraph).toMatch(/refused until an audit note/);
  });
});
