/**
 * Triage taxonomy + routing tests (consume-edges-2026-06-12 P-021 / D-003 / D-005).
 *
 * Pins the two P-021 contracts:
 *   1. ONE classification authority (D-003): triageIdea consumes the POLICY tier
 *      already on the ScoredItem — it never re-derives safety, and its reason
 *      cites the policy's reason verbatim.
 *   2. The D-005 taxonomy keys off scope + paths + watchdog signal class, with
 *      the product route preserved for external-target Hives.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyIdeaType,
  triageIdea,
  summarizeTriages,
  watchdogSourceOf,
  INFRA_SIGNAL_SOURCES,
  PAPERCUSP_SELF_SCOPES,
  isPapercuspSelfScope,
} from './triage';
import type { ScoredItem } from './digest';

function idea(p: Partial<ScoredItem> & { id: string }): ScoredItem {
  return {
    kind: 'bug',
    severity: 'minor',
    title: 'test idea',
    scope: 'operator',
    state: 'open',
    tier: 'auto',
    tierReason: 'no protected path/keyword → AUTO-eligible',
    score: 10,
    ageDays: 1,
    ...p,
  };
}

describe('watchdogSourceOf', () => {
  it('extracts the signal class from a watchdogKey', () => {
    expect(watchdogSourceOf('service-down:openai')).toBe('service-down');
    expect(watchdogSourceOf('red-test:apps/operator/e2e')).toBe('red-test');
  });

  it('returns empty for absent or malformed keys', () => {
    expect(watchdogSourceOf(undefined)).toBe('');
    expect(watchdogSourceOf('no-colon-here')).toBe('');
    expect(watchdogSourceOf(':leading')).toBe('');
  });
});

describe('classifyIdeaType — D-005 taxonomy', () => {
  it('classifies external-target Hive scopes as product (the per-Hive route survives)', () => {
    const result = classifyIdeaType({ scope: 'harness:sheets', title: 'fix the export button' });
    expect(result.type).toBe('product');
    expect(result.reason).toContain('harness:sheets');
  });

  it('classifies the dogfood scopes as code-bug by default (no more product/process)', () => {
    for (const scope of PAPERCUSP_SELF_SCOPES) {
      expect(classifyIdeaType({ scope, title: 'fix harness scheduler' }).type).toBe('code-bug');
    }
  });

  // ── EI-19370922358009801 regression ────────────────────────────────────────
  //
  // ⚠ THE LITERAL IS THE POINT. The loop above iterates PAPERCUSP_SELF_SCOPES, so it
  // asserts only "whatever is in the list is treated as self" — it is VACUOUS about
  // the scope the live system actually emits, and it stayed green for the entire
  // 13-day outage. `engineer_issues.scope` is DERIVED as `'harness:' || harness_slug`,
  // and the owner-directed migrations 630/631 (2026-07-19) re-slugged the workspace's
  // own issues onto `harness_slug='papercusp'`. The allowlist still read
  // `'harness:papercup'` (the pre-rename spelling), so from that moment leg 1 classed
  // EVERY dogfood idea as an external project's code → `product` → unconditional
  // `place`: ~429 consecutive decisions, gate 0 / reject 0 / gym 0.
  //
  // These cases must therefore hardcode the scope string the DB really contains,
  // independent of any exported list, or the guard can go vacuous again the same way.
  it('does NOT classify the live dogfood scope "harness:papercusp" as an external product', () => {
    const r = classifyIdeaType({ scope: 'harness:papercusp', title: 'fix harness scheduler' });
    expect(r.type).toBe('code-bug');
    expect(r.type).not.toBe('product');
  });

  it('keeps routing the dogfood scope through the FULL taxonomy, not just leg 1', () => {
    // Each of these is a lane the `product` misclassification silently swallowed:
    // an infra escalation, a prompt/gym-A-B change, and a needs-design draft all
    // became `place` because leg 1 short-circuited before they were ever reached.
    expect(classifyIdeaType({ scope: 'harness:papercusp', watchdogKey: `${INFRA_SIGNAL_SOURCES[0]}:x` }).type)
      .toBe('infra-environment');
    expect(classifyIdeaType({ scope: 'harness:papercusp', paths: ['apps/operator/prompts/su.persona.md'] }).type)
      .toBe('process-prompt');
    expect(classifyIdeaType({ scope: 'harness:papercusp', kind: 'feature', title: 'net-new thing' }).type)
      .toBe('needs-design');
  });

  it('still treats a genuinely external Pot as product (the fix does not over-reach)', () => {
    expect(classifyIdeaType({ scope: 'harness:oddsmith-hive', title: 'fix the odds table' }).type).toBe('product');
    expect(classifyIdeaType({ scope: 'harness:papercusp-public-site-pot', title: 'copy tweak' }).type).toBe('product');
  });

  it('isPapercuspSelfScope canonicalizes legacy spellings instead of enumerating them', () => {
    expect(isPapercuspSelfScope('harness:papercusp')).toBe(true);
    expect(isPapercuspSelfScope('harness:papercup')).toBe(true); // pre-rename repo name
    expect(isPapercuspSelfScope('harness:papercup-hive')).toBe(true);
    expect(isPapercuspSelfScope('operator')).toBe(true);
    expect(isPapercuspSelfScope(undefined)).toBe(true);
    expect(isPapercuspSelfScope('harness:oddsmith-hive')).toBe(false);
    // Near-miss: a DIFFERENT Pot whose slug merely starts with the platform slug.
    expect(isPapercuspSelfScope('harness:papercusp-public-site-pot')).toBe(false);
  });

  it('defaults to code-bug when scope is missing', () => {
    expect(classifyIdeaType({ title: 'something broke' }).type).toBe('code-bug');
  });

  it('classifies infra-class watchdog signals as infra-environment (D-002)', () => {
    for (const source of INFRA_SIGNAL_SOURCES) {
      const result = classifyIdeaType({ scope: 'operator', watchdogKey: `${source}:some-key` });
      expect(result.type).toBe('infra-environment');
      expect(result.reason).toContain(source);
    }
  });

  it('does NOT treat non-infra signal classes as infra', () => {
    expect(classifyIdeaType({ scope: 'operator', watchdogKey: 'red-test:e2e/foo' }).type).toBe('code-bug');
    expect(
      classifyIdeaType({ scope: 'operator', watchdogKey: 'repeated-tool-error:memory:search:structural' }).type,
    ).toBe('code-bug');
  });

  it('classifies the external rate-limit class as infra-environment (P-010)', () => {
    // The `:rate-limit` class (OpenAI embed TPM 429) is capacity, not a code bug → owner-escalate.
    const r = classifyIdeaType({ scope: 'operator', watchdogKey: 'repeated-tool-error:memory:search:rate-limit' });
    expect(r.type).toBe('infra-environment');
    expect(r.reason).toMatch(/rate-limit/);
    // The structural class of the SAME tool stays code-bug — only :rate-limit reroutes.
    expect(classifyIdeaType({ scope: 'operator', watchdogKey: 'repeated-tool-error:memory:search:structural' }).type).toBe('code-bug');
  });

  it('classifies shared-hive peer-federation-silence as infra-environment, but a sibling shared-hive kind stays code-bug (EI-20983096990125721)', () => {
    const r = classifyIdeaType({
      scope: 'operator',
      watchdogKey: 'shared-hive:peer-federation-silence:papercusp',
    });
    expect(r.type).toBe('infra-environment');
    expect(r.reason).toMatch(/peer federation silence/);
    // The source segment ("shared-hive") is shared with genuinely code-fixable sibling
    // incident kinds — only the peer-federation-silence middle segment reroutes.
    expect(
      classifyIdeaType({ scope: 'operator', watchdogKey: 'shared-hive:double-completion:papercusp' }).type,
    ).toBe('code-bug');
  });

  it('classifies environment paths as infra-environment', () => {
    expect(classifyIdeaType({ scope: 'operator', paths: ['docker-compose.yml'] }).type).toBe('infra-environment');
    expect(classifyIdeaType({ scope: 'operator', paths: ['ops/docker-compose.dev.yml'] }).type).toBe('infra-environment');
    expect(classifyIdeaType({ scope: 'operator', paths: ['deploy/papercup-staging-api.service'] }).type).toBe(
      'infra-environment',
    );
  });

  it('classifies kind=feature as needs-design (net-new earns a plans:new draft)', () => {
    const result = classifyIdeaType({ scope: 'operator', kind: 'feature', title: 'add a benchmark trend panel' });
    expect(result.type).toBe('needs-design');
  });

  it('classifies prompt-source paths as process-prompt (the gym-A/B-able class)', () => {
    expect(classifyIdeaType({ scope: 'operator', paths: ['apps/operator/prompts/queen.persona.md'] }).type).toBe(
      'process-prompt',
    );
    expect(
      classifyIdeaType({ scope: 'operator', paths: ['libs/papercusp/packages/harness/blueprints/base/prompts/worker.md'] }).type,
    ).toBe('process-prompt');
  });

  it('classifies prompt-keyword titles as process-prompt when no paths were captured', () => {
    expect(classifyIdeaType({ scope: 'operator', title: 'tighten the Queen persona wording on triage' }).type).toBe(
      'process-prompt',
    );
    expect(classifyIdeaType({ scope: 'operator', title: 'scoper system prompt over-instructs' }).type).toBe(
      'process-prompt',
    );
  });

  it('does not swallow generic uses of "prompt" into the prompt class', () => {
    expect(classifyIdeaType({ scope: 'operator', title: 'reduce permission prompts in the CLI' }).type).toBe('code-bug');
  });

  it('precedence: infra signal class beats prompt paths; needs-design beats prompt paths', () => {
    expect(
      classifyIdeaType({
        scope: 'operator',
        watchdogKey: 'service-down:postgres',
        paths: ['apps/operator/prompts/judge.md'],
      }).type,
    ).toBe('infra-environment');
    expect(
      classifyIdeaType({ scope: 'operator', kind: 'feature', paths: ['apps/operator/prompts/judge.md'] }).type,
    ).toBe('needs-design');
  });
});

describe('triageIdea — consumes the policy verdict (D-003)', () => {
  it('routes product ideas to place in the target Hive', () => {
    const result = triageIdea(idea({ id: 'p1', scope: 'harness:other', ideaType: 'product' }));
    expect(result.decision).toBe('place');
    expect(result.target).toBe('harness:other');
  });

  it('routes tier=auto code-bugs to the auto-implement lane, citing the POLICY reason', () => {
    const result = triageIdea(
      idea({ id: 'c1', ideaType: 'code-bug', tier: 'auto', tierReason: 'kind=bug is auto-eligible' }),
    );
    expect(result.decision).toBe('place');
    expect(result.target).toBe('auto-implement');
    // ONE verdict chain: the triage reason carries the policy's reason verbatim.
    expect(result.reason).toContain('kind=bug is auto-eligible');
  });

  it('routes tier=human code-bugs to the human gate, citing the POLICY reason', () => {
    const result = triageIdea(
      idea({ id: 'c2', ideaType: 'code-bug', tier: 'human', tierReason: 'touches protected path "libs/flags/x.ts"' }),
    );
    expect(result.decision).toBe('gate');
    expect(result.target).toBe('human-review');
    expect(result.reason).toContain('touches protected path');
  });

  it('routes infra-environment to owner-escalation (D-002: never auto)', () => {
    const result = triageIdea(idea({ id: 'i1', ideaType: 'infra-environment', tier: 'auto' }));
    expect(result.decision).toBe('gate');
    expect(result.target).toBe('owner-escalation');
  });

  it('routes process-prompt to the human gate (gym A/B is the Queen override, P-040)', () => {
    const result = triageIdea(idea({ id: 'pp1', ideaType: 'process-prompt' }));
    expect(result.decision).toBe('gate');
    expect(result.target).toBe('human-review');
    expect(result.reason).toContain('gym');
  });

  it('routes needs-design to a plans:new draft', () => {
    const result = triageIdea(idea({ id: 'd1', ideaType: 'needs-design' }));
    expect(result.decision).toBe('gate');
    expect(result.target).toBe('plans:new');
  });

  it('classifies on the fly when the digest did not stamp ideaType', () => {
    const result = triageIdea(idea({ id: 'f1', scope: 'harness:sheets' }));
    expect(result.decision).toBe('place');
    expect(result.target).toBe('harness:sheets');
  });
});

describe('summarizeTriages', () => {
  it('spreads a mixed backlog across MULTIPLE buckets (the EI-364 regression pin)', () => {
    const summary = summarizeTriages([
      idea({ id: '1', scope: 'harness:sheets', ideaType: 'product' }),
      idea({ id: '2', ideaType: 'code-bug', tier: 'auto' }),
      idea({ id: '3', ideaType: 'code-bug', tier: 'human', tierReason: 'protected keyword "deploy"' }),
      idea({ id: '4', ideaType: 'infra-environment' }),
      idea({ id: '5', ideaType: 'process-prompt' }),
      idea({ id: '6', ideaType: 'needs-design' }),
    ]);
    expect(summary.total).toBe(6);
    expect(summary.byType).toEqual({
      'product': 1,
      'code-bug': 2,
      'infra-environment': 1,
      'process-prompt': 1,
      'needs-design': 1,
    });
    expect(summary.byDecision.place).toBe(2); // product + auto code-bug
    expect(summary.byDecision.gate).toBe(4);
    // The structural EI-364 assertion: more than one non-zero decision bucket.
    const nonZero = Object.values(summary.byDecision).filter((n) => n > 0);
    expect(nonZero.length).toBeGreaterThan(1);
  });

  it('handles empty batch gracefully', () => {
    const summary = summarizeTriages([]);
    expect(summary.total).toBe(0);
    expect(summary.byDecision.place).toBe(0);
    expect(summary.byDecision.gate).toBe(0);
  });

  it('highlights high-priority ideas with their taxonomy class', () => {
    const summary = summarizeTriages([
      idea({ id: 'h1', score: 50, ideaType: 'code-bug', tier: 'auto', title: 'hot bug' }),
      idea({ id: 'h2', score: 45, ideaType: 'infra-environment', title: 'postgres down' }),
    ]);
    expect(summary.highlights).toHaveLength(2);
    expect(summary.highlights[0]).toContain('code-bug');
    expect(summary.highlights[1]).toContain('infra-environment');
  });
});
