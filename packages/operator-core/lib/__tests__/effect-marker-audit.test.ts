/**
 * effect-marker-audit.test.ts — B-CX-EFFECT (code-execution-tool-orchestration).
 *
 * The code-execution dry-run/confirm gate (B-CX-2A) gates ONLY tool calls whose def is
 * `effect: 'write'` — in dryRun a write-effect call is recorded, not executed; outside
 * dryRun it can prompt for confirm. A mutator mis-inferred as `'read'` therefore EXECUTES
 * during a "preview", which is exactly the unsafety this guards.
 *
 * `effect` is inferred from the capability (a `:write/:admin/:delete/:manage/:execute`
 * suffix OR the central WRITE_CAPABILITIES set in libs/generic/tooldef/src/define-tool.ts),
 * overridable per tool with an explicit `effect`. This test enumerates known mutators
 * across every tool family over the REAL registered catalog and asserts NONE infer 'read'.
 *
 * Adding a mutating tool whose capability doesn't already imply write? Either give it an
 * explicit `effect: 'write'`, or (if the capability is a dedicated mutator with no read
 * sibling) add the capability to WRITE_CAPABILITIES — then list the tool here.
 */
import { describe, it, expect } from 'vitest';
import '../agent-tools/index'; // side-effect: register the full operator-core agent-tool catalog
import { lookupByMcpName } from '@papercusp/tooldef';

// (1) Mutators whose capability does NOT end in a write-suffix — the dangerous class this
// audit fixed. Each resolves to 'write' via the central WRITE_CAPABILITIES set OR an
// explicit per-tool override (the two `*:read`-capability file-writers).
const NON_SUFFIX_MUTATORS = [
  'operator:converse', // operator:converse — brain turn (spawns, spend, mem0)
  'turn:interrupt', // turn:interrupt — ends a peer's turn
  'ui:dispatch', // ui:dispatch — performs a UI intent in a browser tab
  'tui:dispatch', // tui:dispatch — performs a control intent against a pui workbench
  'activity:report', // activity:report — inserts an agent-activity row
  'capability:fetch', // capability:net — outbound HTTP (can POST/PUT/DELETE)
  'capability:bash',
  'capability:write',
  'capability:edit',
  'capability:git',
  'capability:computer',
  'processes:kill',
  'learning_packs:export', // capability memory:read + explicit effect:'write' (writes pack files)
  'plans:export', // capability plans:read + explicit effect:'write' (toDir writes .md files)
];

// (2) Representative write-suffix mutators across families — the brief's named candidates
// (cup:spawn, pot:wake, deploy:*, plans:* writes, …) plus a broad sweep, pinned so a
// future capability rename can't silently flip them back to 'read'.
const SUFFIX_MUTATORS = [
  'cup:spawn', 'fleet:cancel', 'fleet:place_batch', 'fleet:drain',
  'pot:wake', 'pot:declare-wake', 'pot:create', 'pot:dissolve', 'pot:set-steering',
  'deploy:harness', 'deploy:hive',
  'accounts:register', 'instance:boot', 'experiment:run', 'harness:create',
  'plans:new', 'plans:set-now', 'plans:set-status', 'plans:promote', 'plans:launch', 'plans:set-content',
  'work_items:create', 'work_items:set_state', 'work_items:claim', 'work_items:complete',
  'plan_items:claim', 'plan_items:convert',
  'coord:send', 'coord:escalate', 'coord:handoff', 'coord:declare-intent', 'events:emit', 'watch:create',
  'messages:send', 'messages:dismiss',
  'memory:remember', 'memory:forget',
  'topics:create', 'agent_chats:create',
  'backup:restore', 'storage:prune', 'autoloop:control', 'discovery:set_hive',
  'flags:set', 'trust:add',
  'autonomy:policy_set', 'autonomy:record_disposition',
  'locks:acquire', 'db:migrate',
];

const ALL_MUTATORS = [...new Set([...NON_SUFFIX_MUTATORS, ...SUFFIX_MUTATORS])];

describe('effect-marker audit (B-CX-EFFECT): known mutators are effect:write', () => {
  it.each(ALL_MUTATORS)("'%s' is registered and marked effect:'write'", (name) => {
    const tool = lookupByMcpName(name);
    expect(tool, `mutator '${name}' is not registered — fix its name or its catalog import`).toBeDefined();
    expect(
      tool?.effect,
      `'${name}' must be effect:'write' so the code-execution dry-run/confirm gate covers it`,
    ).toBe('write');
  });

  // Control: genuine readers must STAY 'read'. Guards against an over-broad flip (which
  // would gate everything) AND proves the effect field is actually populated, not defaulted.
  it.each(['coord:inbox', 'work_items:list', 'plans:get', 'memory:search', 'work_items:get'])(
    "reader '%s' stays effect:'read'",
    (name) => {
      const tool = lookupByMcpName(name);
      expect(tool, `reader '${name}' not registered`).toBeDefined();
      expect(tool?.effect).toBe('read');
    },
  );
});
