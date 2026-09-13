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
    expect(ALL_AGENT_MCP_TOOLS).toContain('mcp__agentmcp__fleet:tree');
    expect(ALL_AGENT_MCP_TOOLS).toContain('mcp__agentmcp__fleet:cancel');
    // The plugin-era names must NOT come back — they were dead on this
    // surface (the plugin loader never ran on standalone agent-mcp).
    for (const t of ALL_AGENT_MCP_TOOLS) {
      expect(t).not.toMatch(/orchestrator_(spawn|poll|list_active|cancel)/);
    }
  });

  // The Mug/Kettle/cup nursery tier retired 2026-08-12 (P-059,
  // retire-mug-kettle-su-only-2026-08-09). The cup-spawn entry was dropped from
  // ALL_AGENT_MCP_TOOLS because naming an UNREGISTERED tool in an allowlist is a
  // promise to the chat surface that it is callable — it red-pinned two unrelated
  // invariants at once (tool-auth-gating's "every allowedTool resolves in the core
  // registry" and tools-md-sync's "every allowedTool has a catalog entry"). This
  // assertion USED to be a presence check in the test above; inverting it into a
  // regression guard — the same shape as the work-item mail retirement below — means
  // a re-introduction fails loudly HERE, next to the reason, instead of surfacing as
  // two mystery reds elsewhere. Do NOT "fix" a missing-spawn-tool symptom by re-adding
  // it: the supported fan-out is a FLEET (`fleet:launch-on-plan`), and re-registering
  // would resurrect a tier the owner deliberately switched off.
  //
  // Safe to write the prefixed name HERE (unlike in operator-mcp-tools.ts, where a
  // mere mention in a COMMENT re-adds the tool): tools-md-sync harvests the allowlist
  // from `allowedToolsSource: operator-mcp-tools.ts` only, and nothing reads this file.
  it('does NOT expose the retired cup-spawn nursery verb', () => {
    expect(ALL_AGENT_MCP_TOOLS).not.toContain('mcp__agentmcp__cup:spawn');
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

  // The work-item mail surface was retired 2026-07-26 (WI-6097,
  // retire-work-item-mail-surface-2026-07-26). Inverted from a presence check
  // into a regression guard so a re-introduction fails loudly here.
  it('does NOT expose the retired work-item mail surface', () => {
    for (const verb of ['send', 'inbox', 'outbox', 'dismiss']) {
      expect(ALL_AGENT_MCP_TOOLS).not.toContain(`mcp__agentmcp__messages:${verb}`);
    }
  });

  it('includes harness:list for the proactive scanner', () => {
    expect(ALL_AGENT_MCP_TOOLS).toContain('mcp__agentmcp__harness:list');
  });

  it('includes scorecards:get for evidence-first audit fallback', () => {
    expect(ALL_AGENT_MCP_TOOLS).toContain('mcp__agentmcp__scorecards:get');
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
