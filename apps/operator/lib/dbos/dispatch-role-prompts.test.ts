/**
 * dispatch-role-prompts.test.ts — meta-coverage: every role the orchestrator can
 * DISPATCH resolves to a runnable prompt, and the test-creating role is wired
 * end-to-end. (Plan harness-test-coverage-for-launch — meta gap surfaced by
 * "is there a test that the test-writing role actually creates tests?")
 *
 * Two layers of assurance:
 *   1. No ORPHAN dispatch verb — for each verb classifyDecision turns into a
 *      role dispatch (GENERATE_TESTS→test-writer, NEXT_TESTER→tester, NEXT_MONITOR
 *      →monitor, …), resolvePromptFile finds an existing prompt in some phase.
 *      This is the regression guard for the "verb dispatches to a role with no
 *      prompt → spawn throws" class (cf. the monitor.md scare in the DBOS plan).
 *   2. The test-creating role is wired: GENERATE_TESTS→test-writer→a real prompt
 *      that actually INSTRUCTS test generation (the deterministic proxy for "the
 *      role creates tests"; the behavioral check — does its OUTPUT contain real
 *      test files — is an LLM scenario, P-020, which needs the judge to run).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseDecision, resolvePromptFile, type PromptResolveContext } from '@papercusp/orchestrator';
import { classifyDecision } from './orchestrator-decide';

const __dirname = dirname(fileURLToPath(import.meta.url));
// apps/operator/lib/dbos → repo root is four up; prompts live under the harness pkg.
const HARNESS_DIR = resolve(__dirname, '../../../../libs/papercusp/packages/harness');

// The phases a harness can run a dispatched role in. A role resolves if it has a
// prompt in at least one of them (resolvePromptFile falls back to prompts/<role>.md).
const PHASES = ['', 'staging', 'testing', 'production'];

function resolvesInSomePhase(role: string): boolean {
  return PHASES.some((phase) => {
    const ctx: PromptResolveContext = { harnessDir: HARNESS_DIR, phase, dept: '' };
    return resolvePromptFile(ctx, role) !== null;
  });
}

// Every dispatch verb the director/orchestrator can emit (with a sample arg).
const DISPATCH_VERBS = [
  'NEXT_WORKER F-1',
  'NEXT_VALIDATOR F-1',
  'NEXT_ARCHITECT F-1 ambiguous',
  'NEXT_SCOPER F-1',
  'NEXT_TESTER VAL-1',
  'NEXT_SECURITY',
  'GENERATE_TESTS',
  'NEXT_MONITOR',
  'NEXT_CROSSCHECK F-1',
  'NEXT_UI_QA F-1',
  'NEXT_EXPERT EXP-1',
  'NEXT_FEEDBACK EXP-1.FB-1',
];

describe('every dispatchable role resolves to a prompt (no orphan dispatch verb)', () => {
  it.each(DISPATCH_VERBS)('%s → a dispatch role with an existing prompt', (verb) => {
    const action = classifyDecision(parseDecision(verb), 'F-DEFAULT');
    expect(action.kind, `${verb} should classify as a role dispatch`).toBe('dispatch');
    const role = (action as { role: string }).role;
    expect(
      resolvesInSomePhase(role),
      `dispatch verb "${verb}" routes to role "${role}", which has NO prompt in any phase — a spawn would throw`,
    ).toBe(true);
  });
});

describe('the test-creating role is wired end-to-end', () => {
  it('GENERATE_TESTS → test-writer → an existing testing-phase prompt', () => {
    const action = classifyDecision(parseDecision('GENERATE_TESTS'), 'F-1');
    expect(action).toMatchObject({ kind: 'dispatch', role: 'test-writer' });
    const path = resolvePromptFile({ harnessDir: HARNESS_DIR, phase: 'testing', dept: '' }, 'test-writer');
    expect(path).toMatch(/testing\/test-writer\.md$/);
  });

  it('NEXT_TESTER → tester → an existing prompt (testing + staging phases)', () => {
    const action = classifyDecision(parseDecision('NEXT_TESTER VAL-1'), 'F-1');
    expect(action).toMatchObject({ kind: 'dispatch', role: 'tester' });
    expect(resolvePromptFile({ harnessDir: HARNESS_DIR, phase: 'testing', dept: '' }, 'tester')).toBeTruthy();
    expect(resolvePromptFile({ harnessDir: HARNESS_DIR, phase: 'staging', dept: '' }, 'tester')).toBeTruthy();
  });

  it("the test-writer prompt actually INSTRUCTS test generation (not just any role doc)", () => {
    const path = resolvePromptFile({ harnessDir: HARNESS_DIR, phase: 'testing', dept: '' }, 'test-writer');
    const prompt = readFileSync(path!, 'utf8');
    // It must tell the agent to GENERATE + WRITE tests and report a count —
    // the deterministic proxy for "this role creates tests". If a prompt edit
    // drops the test-generation contract, this fails.
    expect(prompt).toMatch(/generate .*tests/i);
    expect(prompt).toMatch(/write/i);
    expect(prompt).toMatch(/TEST_WRITER\b/); // the "<count> generated" stdout marker
    expect(prompt).toMatch(/\.spec\.ts|test_/); // a concrete test-file convention
  });
});
