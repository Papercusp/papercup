import { describe, expect, it } from 'vitest';
import {
  ALL_AGENT_MCP_TOOLS,
  SANITIZED_TOOL_NAME_COLLISIONS,
  canonicalToolName,
} from './operator-mcp-tools';

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

  it('contains the fleet spawn primitives (Brief 4 — replaced the dead orchestrator_* plugin tools)', () => {
    expect(ALL_AGENT_MCP_TOOLS).toContain('mcp__agentmcp__cup:spawn');
    expect(ALL_AGENT_MCP_TOOLS).toContain('mcp__agentmcp__fleet:tree');
    expect(ALL_AGENT_MCP_TOOLS).toContain('mcp__agentmcp__fleet:cancel');
    // The plugin-era names must NOT come back — they were dead on this
    // surface (the plugin loader never ran on standalone agent-mcp).
    for (const t of ALL_AGENT_MCP_TOOLS) {
      expect(t).not.toMatch(/orchestrator_(spawn|poll|list_active|cancel)/);
    }
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

// WI-4949: Claude Code sanitizes the colon out of an MCP tool name before the
// model sees it, so a tool_call arrives as `chat_ask_choice`. The card
// registry, the converse ask_choice gates and turn-answer are all keyed on the
// canonical `chat:ask_choice` — when ingest persisted the sanitized name the
// card silently never rendered and the owner saw "Pick one." with no options.
describe('canonicalToolName (un-sanitizes what the model emitted)', () => {
  it('restores the colon for the ask_choice card tool, prefixed or bare', () => {
    expect(canonicalToolName('mcp__agentmcp__chat_ask_choice')).toBe('chat:ask_choice');
    expect(canonicalToolName('chat_ask_choice')).toBe('chat:ask_choice');
  });

  it('is idempotent — an already-canonical name is unchanged', () => {
    expect(canonicalToolName('chat:ask_choice')).toBe('chat:ask_choice');
    expect(canonicalToolName('mcp__agentmcp__chat:ask_choice')).toBe('chat:ask_choice');
  });

  it('does NOT over-replace underscores that are part of the name', () => {
    // The corruption a blind replace(/_/g, ':') would introduce — underscores
    // appear in the group (decision_ledger) AND the verb (policy_get); only the
    // real separator may become a colon.
    expect(canonicalToolName('decision_ledger_list')).toBe('decision_ledger:list');
    expect(canonicalToolName('autonomy_policy_get')).toBe('autonomy:policy_get');
    expect(canonicalToolName('knowledge_packs_install')).toBe('knowledge_packs:install');
  });

  it('round-trips every colon-named tool through the sanitize the model sees', () => {
    for (const fullName of ALL_AGENT_MCP_TOOLS) {
      const canonical = fullName.replace(/^mcp__agentmcp__/, '');
      if (!canonical.includes(':')) continue;
      // toClaudeName's mangle (converse-prompt.ts) → back to canonical.
      expect(canonicalToolName(canonical.replace(/:/g, '_'))).toBe(canonical);
    }
  });

  it('passes through an unknown / non-agent-MCP tool unchanged', () => {
    expect(canonicalToolName('Read')).toBe('Read');
    expect(canonicalToolName('some_unknown_tool')).toBe('some_unknown_tool');
  });

  it('has no ambiguous sanitized collisions (a colliding new tool must red HERE)', () => {
    expect(SANITIZED_TOOL_NAME_COLLISIONS).toEqual([]);
  });
});
