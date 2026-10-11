/**
 * Flagship Slack mention → plan run → thread response binding (P-008). The reply
 * itself is the provider-neutral `chat:reply { planRunId }` (capability-verbs/chat.ts),
 * posted through the source's installed chat package
 * (cupboard-distributable-integrations-2026-10-10 D-019).
 */
import type postgres from 'postgres';
import { ensureFlagshipPlan, type FlagshipPlanEnsureResult } from './flagship-plan';
import { ensureExternalTriggerBinding, type CreatedExternalTriggerBinding } from './admin';
import type { ExternalTriggerSourceRow } from './source-store';

export const SLACK_RESPOND_IN_THREAD_HARNESS = 'papercusp';
export const SLACK_RESPOND_IN_THREAD_PLAN = 'slack-respond-in-thread-2026-08-22';
export const SLACK_RESPOND_IN_THREAD_EVENT = 'ext:slack:mention';

export const SLACK_RESPOND_IN_THREAD_PLAN_CONTENT = `---
title: Slack mention — respond in thread
slug: ${SLACK_RESPOND_IN_THREAD_PLAN}
status: ready
created: 2026-08-22
updated: 2026-09-04
---

# Slack mention — respond in thread

## Now

**State:** Ready built-in template. Each Slack mention creates one isolated event run.

**Next:** Read the triggering mention, write a concise answer, and post it to the originating thread.

## Background

\`plan_run.inputs.trigger\` carries only the routing envelope — the mention itself is
deliberately NOT embedded there. Read it with \`triggers:read-payload\`, passing this
run's numeric id. The response tool accepts only that same id; it resolves the source,
channel, thread, and bot credential server-side so a worker cannot redirect the reply
elsewhere.

## Requirements

**R-1 — Reply in the originating thread.**
\`\`\`requirement
{"intent":{"request":"Each Slack mention yields one reply posted to the thread it was made in.","constraints":["Resolve channel, thread and bot credential server-side from the trigger plan run.","Never post to a caller-supplied channel."],"sourceRefs":["P-001","D-001","D-002"]},"acceptance":{"condition":"A run of this template posts exactly one reply to the originating Slack thread through chat:reply with the run's planRunId.","falsifier":"A run completes with no reply, posts a second reply for the same run, or posts outside the originating thread.","requiredScope":["tree"],"evidencePlane":"tree"},"verification":{"method":"Fire a slack mention event through the binding engine, then read the run and the reply tool's recorded result.","check":{"kind":"instrument","instrumentKey":"none"},"replication":"Run packages/operator-core/lib/capability-verbs/chat.test.ts (chat:reply { planRunId } exactly-once)."}}
\`\`\`

## Design

### Bar-to-work map for this plan

| bar | implementing plan items | evidence plane |
|---|---|---|
| R-1 | P-001 | tree |

## Phase 1 — Respond

- **P-001** \`todo\` Call \`triggers:read-payload\` with \`planRunId=payload.plan_run.runId\` to read the triggering mention, draft a concise response, then call \`chat:reply\` with that same \`planRunId\` and the response text (it posts through the source's installed chat package, cupboard-distributable-integrations-2026-10-10#D-019). Complete only after the tool reports \`posted:true\` or \`alreadyPosted:true\`.

## Decisions

### D-001 — Bind replies to a trigger plan run, never caller-supplied Slack coordinates
Date: 2026-08-22
The reply tool resolves channel and thread from the durable trigger run. Its public input is only planRunId plus text, preventing arbitrary-channel posting and keeping credentials server-side.

### D-002 — The mention is referenced, not embedded
Date: 2026-09-04
A plan run's inputs land in a federated work-item payload, so embedding the message text there would replicate private workspace content to admitted hive members. The engine now passes the routing envelope only, and the agent pulls the mention server-side by planRunId.
`;

export const SLACK_RESPOND_IN_THREAD_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['trigger'],
  properties: {
    trigger: {
      type: 'object',
      additionalProperties: true,
      // `payload` is deliberately absent: the engine projects it out of plan-run
      // inputs (WI-2143575) because those inputs federate. Requiring it here
      // would refuse every launch. The agent reads it via `triggers:read-payload`.
      required: ['key', 'source', 'event', 'sourceId', 'externalId', 'dedupeKey'],
      properties: {
        key: { const: SLACK_RESPOND_IN_THREAD_EVENT },
        source: { const: 'slack' },
        event: { const: 'mention' },
        sourceId: { type: 'string', minLength: 1 },
        externalId: { type: 'string', minLength: 1 },
        dedupeKey: { type: 'string', minLength: 1 },
      },
    },
  },
} as const;

export type SlackFlagshipPlanEnsureResult = FlagshipPlanEnsureResult;

/**
 * Create the immutable built-in plan once, using the canonical markdown-derived
 * plan index writer so plan_items and harness_plans.items cannot drift.
 */
export async function ensureSlackRespondInThreadPlan(
  sql: postgres.Sql,
  workspaceId: string,
): Promise<SlackFlagshipPlanEnsureResult> {
  return ensureFlagshipPlan(sql, workspaceId, {
    harnessSlug: SLACK_RESPOND_IN_THREAD_HARNESS,
    planSlug: SLACK_RESPOND_IN_THREAD_PLAN,
    content: SLACK_RESPOND_IN_THREAD_PLAN_CONTENT,
    inputSchema: SLACK_RESPOND_IN_THREAD_INPUT_SCHEMA,
  });
}

export interface SlackFlagshipBindingResult {
  plan: SlackFlagshipPlanEnsureResult;
  binding: CreatedExternalTriggerBinding;
}

/** Install the built-in template and its one disarmed, reconnect-idempotent binding. */
export async function ensureSlackRespondInThreadBinding(
  sql: postgres.Sql,
  workspaceId: string,
  source: ExternalTriggerSourceRow,
  createdBy?: string | null,
  deps: {
    ensurePlan?: typeof ensureSlackRespondInThreadPlan;
    ensureBinding?: typeof ensureExternalTriggerBinding;
  } = {},
): Promise<SlackFlagshipBindingResult> {
  if (source.workspaceId !== workspaceId || source.kind !== 'slack') {
    throw new Error('slack_flagship_source_invalid');
  }
  const plan = await (deps.ensurePlan ?? ensureSlackRespondInThreadPlan)(sql, workspaceId);
  const binding = await (deps.ensureBinding ?? ensureExternalTriggerBinding)(sql, workspaceId, {
    sourceId: source.id,
    planHarnessSlug: SLACK_RESPOND_IN_THREAD_HARNESS,
    planSlug: SLACK_RESPOND_IN_THREAD_PLAN,
    eventPattern: SLACK_RESPOND_IN_THREAD_EVENT,
    createdBy,
  });
  return { plan, binding };
}
