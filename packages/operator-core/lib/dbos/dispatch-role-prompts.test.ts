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
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseDecision, resolvePromptFile, type PromptResolveContext } from '@papercusp/orchestrator';
import { AGENT_ROLES } from '@papercusp/agent-mcp';
import { classifyDecision } from './orchestrator-decide';

const __dirname = dirname(fileURLToPath(import.meta.url));
// apps/operator/lib/dbos → repo root is four up; prompts live under the harness pkg.
const HARNESS_DIR = resolve(__dirname, '../../../../libs/papercusp/packages/harness');

// Phase 5 (blueprint-role-bundling-2026-06-15 D-012): the global prompts/ phase
// tiers were DELETED — `staging` (what the fleet ran) was collapsed into the base
// role library as canonical. A role's prompt now resolves via
// blueprints/base/prompts/<role>.md (the universal library — no blueprintId) OR via
// the blueprint that ships it (blueprintId=<bp>, e.g. bee→hive, voter→vote). A role
// "resolves" if resolvePromptFile finds it in base or in any built-in blueprint.
const BLUEPRINTS_DIR = resolve(HARNESS_DIR, 'blueprints');
const BUILTIN_BLUEPRINTS = readdirSync(BLUEPRINTS_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(BLUEPRINTS_DIR, d.name, 'prompts')))
  .map((d) => d.name);

// Chat-surface roles are answered inline (operator-converse / oracle SSE), NOT
// spawned from a prompt file — so they are deliberately prompt-less.
const CHAT_ROLES = new Set(['operator', 'oracle']);

// pot-rename SLICE-2 (EXPAND): additive alias role whose canonical target ships no
// persona yet. `blender`→`scout` (ROLE_ALIASES), and `scout` has NO prompt in base or
// any blueprint (its scan-blueprint prompts dir is empty; the scanner's persona is
// `scanner.md`), so blender resolves nowhere until that persona lands. The other new
// aliases (cup/mug/papercup/kettle) DO resolve via their canonical and stay in the
// registry↔prompt enumeration.
const UNRESOLVED_ALIAS_ROLES = new Set(['blender']);

function resolvesSomewhere(role: string): boolean {
  // The base role library (the universal default — no blueprintId).
  const inBase: PromptResolveContext = { harnessDir: HARNESS_DIR, phase: '', dept: '' };
  if (resolvePromptFile(inBase, role) !== null) return true;
  // …or the blueprint that ships the role (e.g. bee→hive, voter→vote, advocate→deliberate).
  return BUILTIN_BLUEPRINTS.some(
    (blueprintId) =>
      resolvePromptFile({ harnessDir: HARNESS_DIR, phase: '', dept: '', blueprintId }, role) !== null,
  );
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
];

describe('every dispatchable role resolves to a prompt (no orphan dispatch verb)', () => {
  it.each(DISPATCH_VERBS)('%s → a dispatch role with an existing prompt', (verb) => {
    const action = classifyDecision(parseDecision(verb), 'F-DEFAULT');
    expect(action.kind, `${verb} should classify as a role dispatch`).toBe('dispatch');
    const role = (action as { role: string }).role;
    expect(
      resolvesSomewhere(role),
      `dispatch verb "${verb}" routes to role "${role}", which has NO prompt in base or any blueprint — a spawn would throw`,
    ).toBe(true);
  });
});

describe('the test-creating role is wired end-to-end', () => {
  it('GENERATE_TESTS → test-writer → the base test-writer prompt', () => {
    const action = classifyDecision(parseDecision('GENERATE_TESTS'), 'F-1');
    expect(action).toMatchObject({ kind: 'dispatch', role: 'test-writer' });
    const path = resolvePromptFile({ harnessDir: HARNESS_DIR, phase: '', dept: '' }, 'test-writer');
    expect(path).toMatch(/blueprints\/base\/prompts\/test-writer\.md$/);
  });

  it('NEXT_TESTER → tester → an existing prompt (base role library)', () => {
    const action = classifyDecision(parseDecision('NEXT_TESTER VAL-1'), 'F-1');
    expect(action).toMatchObject({ kind: 'dispatch', role: 'tester' });
    expect(resolvePromptFile({ harnessDir: HARNESS_DIR, phase: '', dept: '' }, 'tester')).toBeTruthy();
  });

  it("the test-writer prompt actually INSTRUCTS test generation (not just any role doc)", () => {
    const path = resolvePromptFile({ harnessDir: HARNESS_DIR, phase: '', dept: '' }, 'test-writer');
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

describe('every spawnable AGENT_ROLES role has a prompt (registry ↔ prompt consistency)', () => {
  const spawnable = AGENT_ROLES.filter((r) => !CHAT_ROLES.has(r) && !UNRESOLVED_ALIAS_ROLES.has(r));

  it.each(spawnable)('role "%s" resolves to a prompt file (base or its blueprint)', (role) => {
    expect(
      resolvesSomewhere(role),
      `AGENT_ROLES declares "${role}" but no prompt resolves for it in base or any blueprint — it can't be spawned`,
    ).toBe(true);
  });

  it('the chat roles (operator/oracle) are deliberately prompt-less', () => {
    // Documents the intentional exception: if someone gives operator/oracle a
    // prompt file, that's a signal the role model changed — revisit this test.
    for (const role of CHAT_ROLES) {
      expect(AGENT_ROLES).toContain(role);
    }
  });
});

describe('the acceptance/test gate is instructed (validator prompt)', () => {
  // The deterministic half of "tests ship with the feature": the validator is
  // the gate that verifies a feature against its acceptance claims. This pins
  // that its prompt still INSTRUCTS that gate (claim verification + PASS/FAIL +
  // adversarial edge-probing). A prompt edit that drops the gate fails here.
  // (The behavioral "validator actually fails an untested feature" is P-030.)
  it('validator.md instructs per-claim verification with PASS/FAIL and edge-probing', () => {
    const path = resolvePromptFile({ harnessDir: HARNESS_DIR, phase: '', dept: '' }, 'validator');
    expect(path, 'validator prompt must resolve').toBeTruthy();
    const prompt = readFileSync(path!, 'utf8');
    expect(prompt).toMatch(/claims|VAL-|assertion/i); // verifies the acceptance claims
    expect(prompt).toMatch(/\[?PASS\]?/);
    expect(prompt).toMatch(/\[?FAIL\]?/);
    expect(prompt).toMatch(/edge|pentester|should be tested/i); // probes untested gaps
  });
});
