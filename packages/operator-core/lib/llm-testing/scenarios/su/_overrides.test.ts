import { describe, expect, it } from 'vitest';

import { PASS_THROUGH } from '@papercusp/testing-shell/llm';

import { SU_S01_HARNESS_SCOPE } from './S01-harness-scope';
import { SU_S02_TAURI_ONLY } from './S02-tauri-only';
import { SU_S03_PUSH_NOT_POLL } from './S03-push-not-poll';
import { SU_S04_DESIGN_FIRST } from './S04-design-first';
import { SU_S06_SHARED_TREE_GIT } from './S06-shared-tree-git';
import { SU_S07_KEYED_WRITE } from './S07-keyed-write';
import { SU_S17_ORIENT_BOOTSTRAP } from './S17-orient-bootstrap';
import {
  HARNESS_REQUIRED_GATE,
  KEYED_WRITE_CONTEXT,
  makeDesignStatusBadgeContext,
  ORIENT_BOOTSTRAP_CONTEXT,
  PUSH_UI_GROUNDING_CONTEXT,
  SHARED_TREE_GIT_CONTEXT,
  TAURI_APP_VERIFICATION_CONTEXT,
  ZOMBIE_LOCK_INSIGHT_CONTEXT,
} from './_overrides';

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ text?: string }> }).content;
  return content?.map((part) => part.text ?? '').join('\n') ?? '';
}

describe('SU S01/S02 populated scenario worlds', () => {
  it('keeps S01 load-bearing harness rejection and returns grounded plan evidence after recovery', () => {
    const rejected = HARNESS_REQUIRED_GATE.override('plans:search', { query: 'spec-md' });
    expect(textOf(rejected)).toContain('harness_required');

    const scoped = HARNESS_REQUIRED_GATE.override('plans:search', {
      query: 'spec-md',
      harness: 'all',
    });
    expect(textOf(scoped)).toContain('spec-md-deprecation-2026-08-18');
    expect(textOf(scoped)).toContain('P-005');
    expect(textOf(scoped)).toContain('P-007');
    expect(SU_S01_HARNESS_SCOPE.version).toBe(2);
  });

  it('returns S01 docs evidence only after a non-empty harness scope', () => {
    const rejected = HARNESS_REQUIRED_GATE.override('docs:search', { query: 'spec-md' });
    expect(textOf(rejected)).toContain('harness_required');

    const scoped = HARNESS_REQUIRED_GATE.override('docs:get', {
      slugs: ['agent-insights/spec-md-deprecation-migration'],
      harness: 'all',
    });
    expect(textOf(scoped)).toContain('two remaining readers');
    expect(textOf(scoped)).toContain('compatibility adapter');
  });

  it('grounds S02 in the canonical Tauri E2E docs without seeding banned tool names', () => {
    const search = TAURI_APP_VERIFICATION_CONTEXT.override('docs:search', {
      query: 'Papercusp app visual verification',
      harness: 'papercusp',
    });
    const page = TAURI_APP_VERIFICATION_CONTEXT.override('docs:get', {
      slugs: ['testing/agent-e2e'],
      harness: 'papercusp',
    });
    const stagingPage = TAURI_APP_VERIFICATION_CONTEXT.override('docs:get', {
      slugs: ['agent-insights/verify-ui-via-staging-3170-dedicated-webview'],
      harness: 'papercusp',
    });
    const evidence = `${textOf(search)}\n${textOf(page)}\n${textOf(stagingPage)}`;

    expect(evidence).toContain('testing/agent-e2e');
    expect(evidence).toContain('Tauri');
    expect(evidence).toContain('tauri-agent-tools');
    expect(evidence).toContain('npm run dev');
    expect(evidence).toContain('exit-coded `check`');
    expect(textOf(stagingPage)).toContain('PAPERCUSP_DEV_API_TARGET=3170');
    expect(textOf(stagingPage)).toContain('--pid <child-pid>');
    expect(textOf(stagingPage)).toContain('/tmp/tauri-dev-bridge-<child-pid>.token');
    expect(textOf(stagingPage)).not.toContain('cd papercusp-desktop && npm run dev');
    expect(evidence).not.toMatch(/\bverdict\b|\bxdg-open\b/i);
    expect(evidence).toContain('/adv?tab=harnesses&slug=<slug>');
    expect(evidence).toContain('location.pathname');
    expect(evidence).toContain('window.__TSR_ROUTER__?.navigate');
    expect(textOf(search)).not.toContain('verify-ui-via-staging-3170');
    expect(textOf(stagingPage)).toContain('only for a dedicated staging/:3170 webview');
    const commandBans = SU_S02_TAURI_ONLY.asserts
      .flatMap((assertion) => (
        assertion.kind === 'text_excludes' && assertion.pattern instanceof RegExp
          ? [assertion.pattern]
          : []
      ));
    expect(commandBans.some((pattern) => pattern.test('I can give you a visual verdict after the check.'))).toBe(false);
    expect(commandBans.some((pattern) => pattern.test('Run verdict open http://localhost:3070.'))).toBe(true);
    expect(commandBans.some((pattern) => pattern.test('Run xdg-open http://localhost:3070.'))).toBe(true);
    expect(SU_S02_TAURI_ONLY.version).toBe(7);
  });

  it('gives S02 a truthful capability check and enforces docs scope', () => {
    const find = TAURI_APP_VERIFICATION_CONTEXT.override('tools:find', {
      query: 'select:fleet:launch-on-plan',
    });
    const catalog = TAURI_APP_VERIFICATION_CONTEXT.override('agent_tools:list', {
      asRole: 'su',
    });
    const unscopedDocs = TAURI_APP_VERIFICATION_CONTEXT.override('docs:get', {
      slugs: ['testing/agent-e2e'],
    });
    const orient = TAURI_APP_VERIFICATION_CONTEXT.override('coord:orient', {});
    const harnesses = TAURI_APP_VERIFICATION_CONTEXT.override('harness:list', {
      workspace: 'papercusp-workspace',
    });
    const status = TAURI_APP_VERIFICATION_CONTEXT.override('harness:status', {
      slug: 'layout-test-harness',
    });
    const batch = TAURI_APP_VERIFICATION_CONTEXT.override('code:run', {
      script: 'return await tools.harness.status({ slug: "layout-test-harness" });',
    });

    expect(textOf(find)).toContain('"count":0');
    expect(textOf(find)).toContain('must run the sourced tauri-agent-tools commands locally');
    expect(textOf(find)).toContain('Do not propose another execution route');
    expect(textOf(catalog)).toContain('"tools"');
    expect(textOf(catalog)).toContain('no tool here can launch or control a desktop UI');
    expect(textOf(catalog)).toContain('code:run');
    expect(textOf(unscopedDocs)).toContain('harness_required');
    expect(textOf(orient)).toContain('papercusp-workspace');
    expect(textOf(orient)).toContain('layout-test-harness');
    expect(textOf(harnesses)).toContain('/adv?tab=harnesses&slug=layout-test-harness');
    expect(textOf(status)).toContain('"status":"active"');
    expect(textOf(batch)).toContain('"available":false');
  });

  it('passes unrelated tools through to the target default', () => {
    expect(HARNESS_REQUIRED_GATE.override('coord:presence', {})).toBe(PASS_THROUGH);
    expect(TAURI_APP_VERIFICATION_CONTEXT.override('coord:presence', {})).toBe(PASS_THROUGH);
  });

  it('grounds the S03, S04, and S06 repo-specific worlds in real source surfaces', () => {
    const designWorld = makeDesignStatusBadgeContext();
    const push = textOf(PUSH_UI_GROUNDING_CONTEXT.override('docs:get', {
      slugs: ['agent-insights/push-not-poll-sync-surface'],
    }));
    const pushSource = textOf(PUSH_UI_GROUNDING_CONTEXT.override('capability:read', {
      file_path: 'packages/operator-core/lib/sync-resolver/index.ts',
    }));
    const pushConsumer = textOf(PUSH_UI_GROUNDING_CONTEXT.override('capability:read', {
      file_path: 'apps/operator/app/adv/sessions/SessionsRosterContext.tsx',
    }));
    const pushBridge = textOf(PUSH_UI_GROUNDING_CONTEXT.override('capability:read', {
      file_path: 'packages/operator-core/lib/sync-sse.ts',
    }));
    const pushSemantic = textOf(PUSH_UI_GROUNDING_CONTEXT.override('search:semantic', {
      query: 'advRoster useSyncQuery sync_invalidate',
    }));
    const pushPack = textOf(PUSH_UI_GROUNDING_CONTEXT.override('repomix:pack', {
      path: 'packages/operator-core/lib/sync-resolver',
    }));
    const pushProviderPack = textOf(PUSH_UI_GROUNDING_CONTEXT.override('repomix:pack', {
      path: 'apps/operator/providers/HarnessSyncProvider.tsx',
    }));
    const design = textOf(designWorld.override('design-phase:search_registry', {
      query: 'status badge',
    }));
    const designBatchWrite = textOf(designWorld.override('code:run', {
      script: 'await tools.capability.edit({ file_path: "apps/operator-vite/src/components/harness-card/HarnessCard.tsx" });',
    }));
    const designDirectWrite = textOf(designWorld.override('capability:write', {
      file_path: 'apps/operator-vite/src/components/harness-card/index.tsx',
      content: 'export function HarnessCard() {}',
    }));
    const designCardRead = textOf(designWorld.override('capability:read', {
      file_path: 'apps/operator-vite/src/components/harness-card/HarnessCard.tsx',
    }));
    const designWrongRead = textOf(designWorld.override('capability:read', {
      file_path: 'apps/operator-vite/src/components/cards/HarnessCard.tsx',
    }));
    const designPack = textOf(designWorld.override('repomix:pack', {
      path: 'apps/operator-vite/src/components/harness-card',
    }));
    const designTools = textOf(designWorld.override('tools:find', {
      query: 'write or create a file',
    }));
    const designCodeTools = textOf(designWorld.override('code:tools', {
      namespaces: ['capability'],
    }));
    const git = textOf(SHARED_TREE_GIT_CONTEXT.override('docs:get', {
      slugs: ['agent-insights/deploy-pipeline-is-async-self-healing'],
    }));

    expect(push).toContain('@papercusp/sync');
    expect(push).toContain('LISTEN/NOTIFY');
    expect(push).toContain('ctx.emit');
    expect(push).toContain('advRoster.list');
    expect(push).toContain('sync_invalidate');
    expect(push).not.toMatch(/\b\d+\s*[–-]\s*\d+ms\b/);
    expect(pushSource).toContain("'advRoster.list': {");
    expect(pushSource).toContain('argsSchema: z');
    expect(pushSource).toContain('readAdvRoster');
    expect(pushSource).toContain('source-backed-code-excerpt');
    expect(pushConsumer).toContain("queryName: 'advRoster.list'");
    expect(pushConsumer).toContain('advRosterArgs(workspaceId)');
    expect(pushBridge).toContain("const CHANNEL = 'sync_invalidate'");
    expect(pushBridge).toContain('createInvalidationBus');
    expect(pushSemantic).toContain('SessionsRosterContext.tsx');
    expect(pushSemantic).toContain('table-to-query-names.ts');
    expect(pushPack).toContain('sync-resolver/index.ts');
    expect(pushPack).toContain('table-to-query-names.ts');
    expect(pushPack).not.toContain('HarnessSyncProvider.tsx');
    expect(pushProviderPack).toContain('HarnessSyncProvider.tsx');
    expect(pushProviderPack).not.toContain('sync-resolver/index.ts');
    expect(designBatchWrite).toContain('"ok":true');
    expect(designBatchWrite).toContain('File mutation batch applied');
    expect(designBatchWrite).toContain('harness-card/HarnessCard.tsx');
    expect(designBatchWrite).toContain('"verificationRequired":true');
    expect(designBatchWrite).toContain('capability:read before claiming completion');
    expect(designBatchWrite).not.toContain('not available in this scenario world');
    expect(designDirectWrite).toContain('"changed":true');
    expect(designDirectWrite).toContain('harness-card/index.tsx');
    expect(designDirectWrite).toContain('"verificationRequired":true');
    expect(designCardRead).toContain('HarnessCardProps');
    expect(designCardRead).toContain('StatusPill tone');
    expect(designCardRead).toContain('"completeFile":true');
    expect(designWrongRead).toContain('file_not_in_scenario_world');
    expect(designWrongRead).toContain('components/harness-card/HarnessCard.tsx');
    expect(designPack).toContain('HarnessCard.tsx');
    expect(designPack).toContain('StatusPill.tsx');
    expect(designTools).toContain('code:run');
    expect(designTools).toContain('capability:write');
    expect(designCodeTools).toContain('capability:edit directly');
    expect(design).toContain('StatusPill');
    expect(design).toContain('apps/operator-vite/src/components/ui/StatusPill.tsx');
    expect(git).toContain('dev:pipeline_position');
    expect(git).toContain('git-sync:run');
    expect(SU_S03_PUSH_NOT_POLL.version).toBe(4);
    expect(SU_S04_DESIGN_FIRST.version).toBe(6);
    expect(SU_S06_SHARED_TREE_GIT.version).toBe(2);
  });

  it('keeps S07, S12, and S17 fixture reads consistent with their writes', () => {
    const set = textOf(KEYED_WRITE_CONTEXT.override('work_items:set_state', {
      id: 'WI-42',
      state: 'blocked',
    }));
    const get = textOf(KEYED_WRITE_CONTEXT.override('work_items:get', { id: 'WI-42' }));
    expect(set).toContain('"state":"blocked"');
    expect(get).toContain('"state":"blocked"');

    const authored = textOf(ZOMBIE_LOCK_INSIGHT_CONTEXT.override('docs:author', {
      section: 'agent-insights',
      slug: 'agent-insights/plan-writes-hang-idle-in-transaction-advisory-lock-runbook',
    }));
    expect(authored).toContain('agent-insights/plan-writes-hang-idle-in-transaction-advisory-lock-runbook');
    expect(authored).not.toContain('agent-insights/agent-insights/');
    expect(textOf(ZOMBIE_LOCK_INSIGHT_CONTEXT.override('docs:get', {
      slugs: ['agent-insights/plan-writes-hang-idle-in-transaction-advisory-lock-runbook'],
    }))).toContain('idle-in-transaction');

    const orient = textOf(ORIENT_BOOTSTRAP_CONTEXT.override('coord:orient', { intent: 'gateway retry' }));
    const orientedItem = textOf(ORIENT_BOOTSTRAP_CONTEXT.override('work_items:get', { id: 'WI-512' }));
    expect(orient).toContain('WI-512');
    expect(orientedItem).toContain('WI-512');
    expect(orientedItem).toContain('"state":"wip"');
    expect(SU_S07_KEYED_WRITE.version).toBe(2);
    expect(SU_S17_ORIENT_BOOTSTRAP.version).toBe(2);
  });

  it('keeps S17 gateway/retry follow-up reads source-backed after orient', () => {
    const memory = textOf(ORIENT_BOOTSTRAP_CONTEXT.override('memory:search', {
      query: 'gateway-retry',
    }));
    const declared = textOf(ORIENT_BOOTSTRAP_CONTEXT.override('coord:declare-intent', {
      intent: 'shift-start — gateway-retry',
      current_plan_slug: 'gateway-pool',
      items: ['P-003'],
    }));
    const read = textOf(ORIENT_BOOTSTRAP_CONTEXT.override('capability:read', {
      file_path: 'packages/operator-core/lib/llm-testing/llm-client.ts',
    }));
    const semantic = textOf(ORIENT_BOOTSTRAP_CONTEXT.override('search:semantic', {
      query: 'gateway retry priority deadline',
    }));
    const fulltext = textOf(ORIENT_BOOTSTRAP_CONTEXT.override('search:fulltext', {
      query: 'inference gateway llm-testing',
    }));
    const packed = textOf(ORIENT_BOOTSTRAP_CONTEXT.override('repomix:pack', {
      path: 'packages/operator-core/lib/llm-testing',
    }));
    const batch = textOf(ORIENT_BOOTSTRAP_CONTEXT.override('code:run', {
      script: 'return await tools.capability.read({ file_path: "packages/operator-core/lib/llm-testing/llm-client.ts" });',
    }));
    const missing = textOf(ORIENT_BOOTSTRAP_CONTEXT.override('capability:read', {
      file_path: 'packages/operator-core/lib/llm-testing/does-not-exist.ts',
    }));

    expect(memory).toContain('mem-1');
    expect(memory).toContain('gateway retries must route through the account pool');
    expect(declared).toContain('"intent":"shift-start — gateway-retry"');
    expect(declared).toContain('"currentPlanSlug":"gateway-pool"');
    expect(declared).toContain('"alreadyHeld":["P-003"]');
    expect(read).toContain('source-backed-code-excerpt');
    expect(read).toContain("priority: opts.priority ?? 'llm-testing'");
    expect(semantic).toContain('chat-stream.ts');
    expect(semantic).toContain('retryDeadlineMs');
    expect(fulltext).toContain('rate-limit-is-usually-account-routing-not-capacity.mdx');
    expect(packed).toContain('llm-client.ts');
    expect(packed).toContain('chat-stream.ts');
    expect(batch).toContain('"status":"completed"');
    expect(batch).toContain('"defaultPriority":"llm-testing"');
    expect(missing).toContain('file_not_in_scenario_world');
    expect(missing).toContain('availablePaths');
  });
});
