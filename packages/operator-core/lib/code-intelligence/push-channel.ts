/** P-034/D-016: one code-intelligence leg at the existing PostToolBatch sink. */
import { randomUUID } from 'node:crypto';
import { pinModuleState } from '@papercusp/module-singleton';
import { withWorkspace } from '@papercusp/db-org';
import { FLAGS, type FlagKey } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { withBoundedTimeout } from '../bounded-timeout';
import { loadHarnessRegistry } from '../harness-registry';
import { operatorHomeHarnessSlug } from '../harness/operator-home-harness';
import { peekPushSnapshot, safeSnapshotPath, type PushSnapshot } from './push-snapshot';

export const CODE_INTEL_PUSH_TURN_CHARS = 1_500;
export const CODE_INTEL_PUSH_WALL_MS = 250;
export const PUSH_LEG_FLAGS = {
  grep: FLAGS.CODE_INTEL_PUSH_GREP, 'first-touch': FLAGS.CODE_INTEL_PUSH_FIRST_TOUCH,
  interface: FLAGS.CODE_INTEL_PUSH_INTERFACE, incident: FLAGS.CODE_INTEL_PUSH_INCIDENT,
  completion: FLAGS.CODE_INTEL_PUSH_COMPLETION, intent: FLAGS.CODE_INTEL_PUSH_INTENT,
} as const;
export type PushLegId = keyof typeof PUSH_LEG_FLAGS;
export interface PushCall { tool?: string; toolInput?: unknown; toolResponse?: unknown }
export interface PushInput {
  owner: string; workspace: string; harness?: string; client?: string;
  calls: readonly PushCall[];
}
export interface PushFact {
  leg: PushLegId;
  /** Identifies the fact, not the request; compaction makes it eligible again. */
  subject: string;
  text: string;
  citedPaths: readonly string[];
  suggestedCall?: string;
}
export type PushLeg = (input: PushInput, snapshot: PushSnapshot) => readonly PushFact[];
const state = pinModuleState('@papercusp/operator-core.code-intel-push-legs', () => ({ legs: new Map<PushLegId, PushLeg>() }));
export function registerCodeIntelPushLeg(id: PushLegId, leg: PushLeg): void { state.legs.set(id, leg); }

export interface PushChannelDeps {
  snapshot(input: PushInput): Promise<PushSnapshot | null>;
  enabled(flag: FlagKey): Promise<boolean>;
  legs(): ReadonlyMap<PushLegId, PushLeg>;
  commit(input: PushInput, snapshot: PushSnapshot, facts: readonly PushFact[], requestBudget: number, signal: AbortSignal): Promise<string>;
}

/** One transaction serializes both the turn ceiling and session dedupe across cluster workers. */
export async function commitPushFacts(input: PushInput, snapshot: PushSnapshot, facts: readonly PushFact[],
  requestBudget: number, signal: AbortSignal): Promise<string> {
  return withWorkspace(input.workspace, async tx => {
    // The hook must not leave a slow query behind after its response deadline.
    await tx`SELECT set_config('lock_timeout', '100ms', true), set_config('statement_timeout', '150ms', true)`;
    await tx`INSERT INTO harness_shared.identity_hook_turns (workspace_id, owner_id, turn_id)
      VALUES (${input.workspace}, ${input.owner}, ${randomUUID()}) ON CONFLICT DO NOTHING`;
    const turns = await tx<{ turn_id: string }[]>`SELECT turn_id FROM harness_shared.identity_hook_turns
      WHERE workspace_id = ${input.workspace} AND owner_id = ${input.owner} FOR UPDATE`;
    const turn = turns[0]?.turn_id;
    if (!turn || signal.aborted) return '';
    const epochs = await tx<{ epoch: number }[]>`SELECT epoch FROM harness_shared.memory_session_epochs WHERE session_id = ${input.owner}`;
    const epoch = Number(epochs[0]?.epoch ?? 0);
    const spent = await tx<{ chars: number }[]>`SELECT COALESCE(SUM(chars), 0)::int AS chars FROM harness_shared.code_intel_pushes
      WHERE workspace_id = ${input.workspace} AND owner_id = ${input.owner} AND turn_id = ${turn}`;
    let left = Math.min(requestBudget, CODE_INTEL_PUSH_TURN_CHARS - Number(spent[0]?.chars ?? 0));
    const text: string[] = [];
    for (const fact of facts) {
      const block = formatPushFact(fact, snapshot);
      const chars = block.length + 2;
      if (signal.aborted) throw new Error('code-intel push cancelled');
      if (chars > left) continue; // Never cut a qualifier or citation off a fact.
      const inserted = await tx<{ id: number }[]>`INSERT INTO harness_shared.code_intel_pushes
        (workspace_id, owner_id, epoch, turn_id, leg, subject, snapshot_commit, snapshot_generated_at, cited_paths, suggested_call, chars, client)
        VALUES (${input.workspace}, ${input.owner}, ${epoch}, ${turn}, ${fact.leg}, ${fact.subject}, ${snapshot.commit},
          ${snapshot.generatedAt}::timestamptz, ${[...fact.citedPaths]}::text[], ${fact.suggestedCall ?? null}, ${chars}, ${input.client ?? null})
        ON CONFLICT (workspace_id, owner_id, epoch, leg, subject) DO NOTHING RETURNING id`;
      if (inserted.length) { text.push(block); left -= chars; }
    }
    if (signal.aborted) throw new Error('code-intel push cancelled');
    return text.join('\n\n');
  });
}

export function formatPushFact(fact: PushFact, snapshot: PushSnapshot): string {
  return `## Code intelligence (${fact.leg})\nSnapshot ${snapshot.commit.slice(0, 12)} · ${snapshot.generatedAt}\n${fact.text}`;
}

const defaults: PushChannelDeps = {
  snapshot: async input => {
    // Only the registered home repository currently has the maintained producer.
    // Never use the operator's snapshot for a different harness/workspace.
    const home = operatorHomeHarnessSlug();
    if (input.harness !== home) return null;
    const registry = await loadHarnessRegistry(input.workspace);
    if (!registry.projects.some(project => project.slug === home && project.path)) return null;
    return peekPushSnapshot('papercusp');
  },
  enabled: flag => getFlag(flag, 'system'),
  legs: () => state.legs,
  commit: commitPushFacts,
};

/** A failed optional push never drops memory, worn rules, or the failure hint. */
export async function codeIntelPushText(input: PushInput, memoryChars = 0, deps: PushChannelDeps = defaults): Promise<string> {
  if (!input.owner || !input.workspace || !input.calls.length || !deps.legs().size) return '';
  const requestBudget = Math.max(0, CODE_INTEL_PUSH_TURN_CHARS - Math.max(0, memoryChars));
  if (!requestBudget) return '';
  const result = await withBoundedTimeout(async signal => {
    const snapshot = await deps.snapshot(input);
    if (!snapshot || signal.aborted) return '';
    const facts: PushFact[] = [];
    for (const [id, leg] of deps.legs()) {
      if (signal.aborted || !await deps.enabled(PUSH_LEG_FLAGS[id])) continue;
      try {
        for (const fact of leg(input, snapshot)) {
          if (fact.leg === id && fact.subject.length <= 1000 && fact.subject.trim() && fact.text.trim()
            && fact.citedPaths.every(safeSnapshotPath)
            && formatPushFact(fact, snapshot).length + 2 <= requestBudget) facts.push(fact);
          if (facts.length >= 12) break;
        }
      } catch (error) { console.warn(`[code-intel-push] ${id} failed:`, String(error).slice(0, 200)); }
      if (facts.length >= 12) break;
    }
    return facts.length && !signal.aborted ? deps.commit(input, snapshot, facts, requestBudget, signal) : '';
  }, { timeoutMs: CODE_INTEL_PUSH_WALL_MS, fallback: '', label: 'code-intel-push' });
  return result.value;
}
