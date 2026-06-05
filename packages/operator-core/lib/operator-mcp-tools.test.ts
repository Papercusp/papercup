import { describe, expect, it } from 'vitest';
import { ALL_AGENT_MCP_TOOLS } from './operator-mcp-tools';

// The allowlist is the contract between the operator's spawn config and
// the agent-mcp catalog. A typo here silently denies the LLM a tool it
// needs. Pin the load-bearing entries so a careless edit trips a test.

describe('ALL_AGENT_MCP_TOOLS', () => {
  it('is a non-empty readonly array', () => {
    expect(Array.isArray(ALL_AGENT_MCP_TOOLS)).toBe(true);
    expect(ALL_AGENT_MCP_TOOLS.length).toBeGreaterThan(10);
  });

  it('every entry uses the mcp__agentmcp__ prefix', () => {
    for (const t of ALL_AGENT_MCP_TOOLS) {
      expect(t.startsWith('mcp__agentmcp__')).toBe(true);
    }
  });

  it('contains no duplicates', () => {
    const seen = new Set(ALL_AGENT_MCP_TOOLS);
    expect(seen.size).toBe(ALL_AGENT_MCP_TOOLS.length);
  });

  it('contains the four orchestrator-spawn tools (Phase 9)', () => {
    expect(ALL_AGENT_MCP_TOOLS).toContain('mcp__agentmcp__orchestrator_spawn');
    expect(ALL_AGENT_MCP_TOOLS).toContain('mcp__agentmcp__orchestrator_poll');
    expect(ALL_AGENT_MCP_TOOLS).toContain('mcp__agentmcp__orchestrator_list_active');
    expect(ALL_AGENT_MCP_TOOLS).toContain('mcp__agentmcp__orchestrator_cancel');
  });

  it('uses underscore between server and tool (claude-code convention)', () => {
    // Claude-code converts `.` to `_` in MCP tool names; the operator
    // route's toolEventFilter strips the `mcp__agentmcp__` prefix, so
    // anything emitted by the LLM as `orchestrator.spawn` would not
    // match. Tools should be named with underscores throughout.
    for (const t of ALL_AGENT_MCP_TOOLS) {
      const tail = t.replace(/^mcp__agentmcp__/, '');
      expect(tail.includes('.')).toBe(false);
    }
  });

  it('includes the messages:write capability for send_directive flow', () => {
    expect(ALL_AGENT_MCP_TOOLS).toContain('mcp__agentmcp__messages:send');
  });

  it('includes harness:list for the proactive scanner', () => {
    expect(ALL_AGENT_MCP_TOOLS).toContain('mcp__agentmcp__harness:list');
  });
});
