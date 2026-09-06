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
  DESIGN_STATUS_BADGE_CONTEXT,
  HARNESS_REQUIRED_GATE,
  KEYED_WRITE_CONTEXT,
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
    expect(SU_S02_TAURI_ONLY.version).toBe(4);
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

    expect(textOf(find)).toContain('"count":0');
    expect(textOf(find)).toContain('Do not offer or claim');
    expect(textOf(catalog)).toContain('"tools"');
    expect(textOf(catalog)).toContain('No process launcher');
    expect(textOf(unscopedDocs)).toContain('harness_required');
  });

  it('passes unrelated tools through to the target default', () => {
    expect(HARNESS_REQUIRED_GATE.override('coord:presence', {})).toBe(PASS_THROUGH);
    expect(TAURI_APP_VERIFICATION_CONTEXT.override('coord:presence', {})).toBe(PASS_THROUGH);
  });

  it('grounds the S03, S04, and S06 repo-specific worlds in real source surfaces', () => {
    const push = textOf(PUSH_UI_GROUNDING_CONTEXT.override('docs:get', {
      slugs: ['agent-insights/push-not-poll-sync-surface'],
    }));
    const pushSource = textOf(PUSH_UI_GROUNDING_CONTEXT.override('capability:read', {
      file_path: 'packages/operator-core/lib/sync-resolver/index.ts',
    }));
    const pushPack = textOf(PUSH_UI_GROUNDING_CONTEXT.override('repomix:pack', {
      path: 'packages/operator-core/lib/sync-resolver',
    }));
    const design = textOf(DESIGN_STATUS_BADGE_CONTEXT.override('design-phase:search_registry', {
      query: 'status badge',
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
    expect(pushSource).toContain('module-level REGISTRY');
    expect(pushSource).toContain('readAdvRoster');
    expect(pushPack).toContain('HarnessSyncProvider.tsx');
    expect(pushPack).toContain('sync-sse.ts');
    expect(design).toContain('StatusPill');
    expect(design).toContain('apps/operator-vite/src/components/ui/StatusPill.tsx');
    expect(git).toContain('dev:pipeline_position');
    expect(git).toContain('git-sync:run');
    expect(SU_S03_PUSH_NOT_POLL.version).toBe(3);
    expect(SU_S04_DESIGN_FIRST.version).toBe(2);
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
});
