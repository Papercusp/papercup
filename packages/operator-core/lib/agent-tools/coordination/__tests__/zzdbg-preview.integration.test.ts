import { beforeAll, describe, it } from 'vitest';
import type postgres from 'postgres';
import promoteTool from '../tools/promote';
import { PAPERCUSP_WORKSPACE_ID } from '../../../harness/papercusp-workspace';
import {
  setupPlanPgFixture,
  seedPlan,
  type PlanPgFixture,
} from '../../plans/__tests__/_pg-tool-fixture';

const PARENT_HARNESS = 'papercup';
const RUN = Math.random().toString(36).slice(2, 8);
const MIXED_SLUG = `zzz-dbg-spawn-mixed-${RUN}-2026-06-07`;
const CHILD = `zzz-dbg-prevu-child-${RUN}`;

function mixedPlan(): string {
  return `---
title: Spawn Preview Mixed Plan
slug: ${MIXED_SLUG}
created: 2026-06-07
updated: 2026-06-07
status: active
---

# Spawn Preview Mixed Plan

## Now

**State:** Test fixture.

**Next:** Preview only.

## Phase 1

- **P-001** \`todo\` Parent-side work.
- **P-002** \`todo\` Child-side work.

## Promote

\`\`\`yaml
target_harness: zzz-spawn-preview-target
waves:
  - id: stay
    features:
      - title: "Stays in the parent"
        from_items: [P-001]
  - id: extract
    spawn_child:
      slug: ${CHILD}
      template: node-cli
      goal: "Preview-only child"
    features:
      - title: "Goes to the child"
        from_items: [P-002]
        acceptance: ["child builds"]
      - title: "Also goes to the child"
\`\`\`
`;
}

let fx: PlanPgFixture;
let admin: postgres.Sql;

function makeCtx() {
  return {
    log: () => {},
    progress: () => {},
    metadata: () => {},
    signal: new AbortController().signal,
    workspaceId: 'default',
    principal: { kind: 'agent', slug: 'agent-spawn-preview-test', workspaceId: 'default' },
  } as never;
}

beforeAll(async () => {
  fx = await setupPlanPgFixture();
  admin = fx.admin;
  await seedPlan(admin, PAPERCUSP_WORKSPACE_ID, PARENT_HARNESS, MIXED_SLUG, mixedPlan());
}, 120_000);

describe('dbg', () => {
  it('captures error', async () => {
    const res = (await promoteTool.handler({ slug: MIXED_SLUG, all_waves: true, apply: false } as never, makeCtx())) as {
      content: { text: string }[];
      isError?: boolean;
    };
    console.error('ISERROR:', res.isError);
    console.error('DATA:', res.content[0].text);
    await fx.dispose();
  });
});
