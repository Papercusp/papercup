/**
 * Unit coverage for the plan-agent runner's pure surface
 * (plan-agent-launch-2026-05-21, P-011 / D-004 / D-016).
 *
 * `buildPlanAgentMcpUrl`, `planAgentToolEventFilter`, and the derived
 * tool-surface constants are pure — testable without spawning an
 * agent. `runPlanAgent` / `buildPlanAgentMcpConfig` are IO (process
 * spawn, superuser-token read) and are exercised live by P-012 / P-027.
 */

import { describe, expect, it } from 'vitest';
import {
  buildPlanAgentMcpUrl,
  planAgentToolEventFilter,
  PLAN_AGENT_ALLOWED_TOOLS,
  PLAN_AGENT_NATIVE_TOOLS,
} from '../runner';

describe('buildPlanAgentMcpUrl', () => {
  it('carries the plan-run session id as ?plan_run= (D-016 contract)', () => {
    const url = buildPlanAgentMcpUrl({
      base: 'http://127.0.0.1:3055',
      workspace: 'ws-1',
      planRunSessionId: 'run-abc-123',
    });
    // The whole point of P-006: the transport reads ?plan_run= and
    // attributes the launched agent's plan writes to this run.
    expect(url).toContain('&plan_run=run-abc-123');
    expect(url).toContain('/api/mcp?superuser=1');
    expect(url).toContain('&workspace=ws-1');
  });

  it('includes &client= only when a uiClientId is supplied', () => {
    const withClient = buildPlanAgentMcpUrl({
      base: 'http://x',
      workspace: 'w',
      planRunSessionId: 's',
      uiClientId: 'tab-9',
    });
    expect(withClient).toContain('&client=tab-9');

    const withoutClient = buildPlanAgentMcpUrl({
      base: 'http://x',
      workspace: 'w',
      planRunSessionId: 's',
    });
    expect(withoutClient).not.toContain('&client=');
  });

  it('url-encodes the session id, workspace, and client params', () => {
    const url = buildPlanAgentMcpUrl({
      base: 'http://x',
      workspace: 'ws/with space',
      planRunSessionId: 'run&id=odd',
      uiClientId: 'a/b',
    });
    expect(url).toContain('&plan_run=run%26id%3Dodd');
    expect(url).toContain('&workspace=ws%2Fwith%20space');
    expect(url).toContain('&client=a%2Fb');
  });
});

describe('planAgentToolEventFilter', () => {
  it('strips the mcp__agentmcp__ prefix from MCP tool calls', () => {
    expect(planAgentToolEventFilter('mcp__agentmcp__plans:set-content')).toBe(
      'plans:set-content',
    );
    expect(planAgentToolEventFilter('mcp__agentmcp__harness:list')).toBe(
      'harness:list',
    );
  });

  it('passes native tool calls through unchanged — they are real work', () => {
    // Unlike oracle's filter (which drops non-MCP tools), a plan
    // agent's native tool use must surface in the run transcript.
    expect(planAgentToolEventFilter('Bash')).toBe('Bash');
    expect(planAgentToolEventFilter('Edit')).toBe('Edit');
  });
});

describe('PLAN_AGENT_ALLOWED_TOOLS', () => {
  it('grants the native coding tools — a plan agent does real work', () => {
    for (const t of PLAN_AGENT_NATIVE_TOOLS) {
      expect(PLAN_AGENT_ALLOWED_TOOLS).toContain(t);
    }
    expect(PLAN_AGENT_ALLOWED_TOOLS).toContain('Bash');
    expect(PLAN_AGENT_ALLOWED_TOOLS).toContain('Edit');
  });

  it('grants the plans:* write surface so plan edits are attributed', () => {
    expect(PLAN_AGENT_ALLOWED_TOOLS).toContain('mcp__agentmcp__plans:set-content');
    expect(PLAN_AGENT_ALLOWED_TOOLS).toContain('mcp__agentmcp__plans:set-status');
    expect(PLAN_AGENT_ALLOWED_TOOLS).toContain('mcp__agentmcp__plans:revisions');
  });

  it('grants the operator world-model surface (a plan is usually harness work)', () => {
    expect(PLAN_AGENT_ALLOWED_TOOLS).toContain('mcp__agentmcp__harness:list');
    expect(PLAN_AGENT_ALLOWED_TOOLS).toContain('mcp__agentmcp__search:fulltext');
  });

  it('excludes chat:ask_choice — a launched run has no live mid-run responder', () => {
    expect(PLAN_AGENT_ALLOWED_TOOLS).not.toContain('mcp__agentmcp__chat:ask_choice');
  });

  it('excludes plans:backfill-revisions — a one-time migration tool', () => {
    expect(PLAN_AGENT_ALLOWED_TOOLS).not.toContain(
      'mcp__agentmcp__plans:backfill-revisions',
    );
  });
});
