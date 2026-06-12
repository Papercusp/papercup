/**
 * Drift-guard for the AgentBackend abstraction (agent-launch-unification
 * P-001). There are three declarations of the backend set across two
 * submodules + the operator, and the submodule boundary rules out a
 * single literal import. So each layer owns a runtime tuple (its type is
 * derived from it), and this test — which lives in apps/operator, the one
 * place that imports all three — asserts they can't silently diverge:
 *
 *   - operator        `@/lib/agent-config`           AGENT_BACKENDS              (subprocess set)
 *   - orchestrator    `@papercusp/orchestrator`      AGENT_BACKENDS              (subprocess set)
 *   - shared brains   `@papercusp/papercup-shared/agent` AGENT_BACKENDS            (subprocess + anthropic-direct)
 *                                                     SUBPROCESS_AGENT_BACKENDS  (subprocess set)
 *
 * The three SUBPROCESS sets must be identical; the brains' full set is
 * exactly the subprocess set plus the brains-only `anthropic-direct`.
 */
import { describe, it, expect } from 'vitest';
import { AGENT_BACKENDS as OPERATOR_BACKENDS } from '../agent-config';
import { AGENT_BACKENDS as ORCH_BACKENDS } from '@papercusp/orchestrator';
import {
  AGENT_BACKENDS as BRAINS_BACKENDS,
  SUBPROCESS_AGENT_BACKENDS as BRAINS_SUBPROCESS,
} from '@papercusp/papercup-shared/agent';

const sorted = (xs: readonly string[]) => [...xs].sort();

describe('AgentBackend sets stay in sync across the submodule boundary', () => {
  it('the operator + orchestrator subprocess sets are identical', () => {
    expect(sorted(OPERATOR_BACKENDS)).toEqual(sorted(ORCH_BACKENDS));
  });

  it('the brains subprocess subset matches the operator/orchestrator set', () => {
    expect(sorted(BRAINS_SUBPROCESS)).toEqual(sorted(OPERATOR_BACKENDS));
  });

  it('the brains full set is exactly the subprocess set + brains-only anthropic-direct', () => {
    expect(sorted(BRAINS_BACKENDS)).toEqual(sorted([...BRAINS_SUBPROCESS, 'anthropic-direct']));
  });

  it('codex is present everywhere (the P-001 widening landed)', () => {
    expect(OPERATOR_BACKENDS).toContain('codex');
    expect(ORCH_BACKENDS).toContain('codex');
    expect(BRAINS_SUBPROCESS).toContain('codex');
  });
});
