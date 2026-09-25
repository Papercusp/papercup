/**
 * Replay-safe DBOS consumer bridge for the canonical work-item completion event.
 *
 * This is called INSIDE a DBOS workflow. It reads the existing work-item row and
 * event_key_fires latch; DBOS.sleep is the durable wait between observations.
 * Reads are deliberately not checkpointed as DBOS steps: after a workflow
 * replay, the current business state (including reopen) must be re-read.
 * The event is an executor signal; the work item remains the outcome authority.
 */
import { runWithWorkspace } from '../workspace-als';
import { getWorkItem, isSettledWorkItemState, type WorkItem } from '../work-items';
import { ALL_SUCCESSFUL_STATUSES } from '../work-item-blocking';
import { completionEventIntentIdOf } from '../work-items-events';
import { getKeyFireLatch } from '../events/await/store';
import type { KeyFireRow } from '../events/await/types';

export interface WorkItemEventWaitInput {
  itemId: string;
  harnessSlug: string;
  workspaceId: string;
  /** Absolute deadline persists across a DBOS replay; a relative timeout would reset. */
  deadlineAt: string;
  pollMs?: number;
}

export type WorkItemEventWaitResult =
  | {
      kind: 'settled';
      itemId: string;
      state: string;
      successful: boolean;
      source: 'completion-event' | 'current-state';
      completionIntentId: string | null;
    }
  | { kind: 'pending'; itemId: string; lastState: string | null; reason: 'deadline' };

export interface WorkItemEventWaitDeps {
  readItem?: (input: WorkItemEventWaitInput) => Promise<WorkItem | null>;
  readLatch?: (eventKey: string) => Promise<KeyFireRow | null>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

function latchedIntent(latch: KeyFireRow | null): string | null {
  const payload = latch?.lastPayload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const token = (payload as Record<string, unknown>).completionIntentId;
  return typeof token === 'string' && token.length > 0 ? token : null;
}

function hasValidatedSuccess(item: WorkItem): boolean {
  if (!ALL_SUCCESSFUL_STATUSES.has(item.state) ||
      (item.completionAuthority !== 'committed' && item.completionAuthority !== 'validated')) return false;
  const payload = item.payload && typeof item.payload === 'object' && !Array.isArray(item.payload)
    ? item.payload as Record<string, unknown> : null;
  if (!payload || !Object.prototype.hasOwnProperty.call(payload, 'blueprintOperation')) return true;
  const pin = payload.blueprintOperation;
  const result = payload.blueprintResult;
  if (!pin || typeof pin !== 'object' || Array.isArray(pin) ||
      !result || typeof result !== 'object' || Array.isArray(result)) return false;
  const accepted = pin as Record<string, unknown>;
  const completed = result as Record<string, unknown>;
  return accepted.kind === 'blueprint-operation' &&
    completed.operationId === accepted.operationId &&
    completed.specificationRevision === accepted.specificationRevision &&
    typeof completed.evidenceRef === 'string' && completed.evidenceRef.trim().length > 0 &&
    Object.prototype.hasOwnProperty.call(completed, 'output');
}

async function defaultReadItem(input: WorkItemEventWaitInput): Promise<WorkItem | null> {
  return runWithWorkspace(input.workspaceId, () => getWorkItem(input.itemId, input.harnessSlug));
}

async function defaultSleep(ms: number): Promise<void> {
  const { DBOS } = await import('@dbos-inc/dbos-sdk');
  await DBOS.sleep(ms);
}

/** Await a published completion or an already-settled current item.
 * A pending completion intent requires its matching latched event before
 * success; a late consumer of an acknowledged/legacy item reads terminal
 * state immediately. A reopen invalidates the earlier result before return. */
export async function awaitWorkItemCompletionEvent(
  input: WorkItemEventWaitInput,
  deps: WorkItemEventWaitDeps = {},
): Promise<WorkItemEventWaitResult> {
  if (!input.itemId || !input.harnessSlug || !input.workspaceId) throw new Error('work-item event wait needs exact scope');
  const deadline = Date.parse(input.deadlineAt);
  if (!Number.isFinite(deadline)) throw new Error('work-item event wait needs an absolute deadlineAt');
  const pollMs = input.pollMs ?? 10_000;
  if (!Number.isInteger(pollMs) || pollMs < 100 || pollMs > 60_000) throw new Error('pollMs must be 100..60000');

  const readItem = deps.readItem ?? defaultReadItem;
  const readLatch = deps.readLatch ?? getKeyFireLatch;
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;
  let lastState: string | null = null;
  for (;;) {
    const item = await readItem(input);
    if (item && item.harness !== input.harnessSlug) throw new Error('work-item event wait read outside harness');
    lastState = item?.state ?? null;
    if (item && isSettledWorkItemState(item.state)) {
      const pendingIntent = completionEventIntentIdOf(item);
      const latch = pendingIntent ? await readLatch(`work-item:done:${input.itemId}`) : null;
      if (!pendingIntent || latchedIntent(latch) === pendingIntent) {
        // A reopen can win between the state and latch reads. The final live
        // read fences that old completion before the consumer resumes.
        const current = await readItem(input);
        const currentIntent = current ? completionEventIntentIdOf(current) : null;
        if (current && current.harness === input.harnessSlug && isSettledWorkItemState(current.state) &&
            (!currentIntent || currentIntent === pendingIntent)) {
          return {
            kind: 'settled', itemId: input.itemId, state: current.state,
            successful: hasValidatedSuccess(current),
            source: pendingIntent ? 'completion-event' : 'current-state',
            completionIntentId: pendingIntent,
          };
        }
        lastState = current?.state ?? null;
      }
    }
    const remaining = deadline - now();
    if (remaining <= 0) return { kind: 'pending', itemId: input.itemId, lastState, reason: 'deadline' };
    await sleep(Math.min(pollMs, remaining));
  }
}
