/**
 * testing-domains-registry.ts — every /admin/testing subtab declaration.
 *
 * Plan: admin-testing-tab-restructure-2026-05-24, P-002.
 *
 * Importing this module side-effect-registers all 21 domains into the
 * `defineTestDomain` registry. Server route (P-003) and SPA tab list
 * (P-006) both import this file to populate themselves.
 *
 * Eight existing tabs (test-runs, live, memory, chaos, ai, routes,
 * packaged, llm) are declared here for routing/labeling only — their
 * bespoke React lives in operator-vite, wired via `customId` lookup
 * inside the SPA (P-006a). The 13 new tabs render via <DomainTestPanel>.
 *
 * Globs are repo-relative POSIX. Glob walk happens server-side at
 * request time (P-003) — no checked-in catalog to drift.
 *
 * Tier groupings:
 *   - quick:   one-click suite runners, observers, packaged build
 *   - domain:  per-domain test surfaces (12 new + memory + llm)
 *   - surface: cross-cutting transports (routes, transport, docs)
 */

import { defineTestDomain } from './testing-domains';

/* ---------------------------------------------------------------- *
 * Tier 1 — quick runs (existing tabs, custom-rendered in operator-vite)
 * ---------------------------------------------------------------- */

defineTestDomain({
  id: 'test-runs',
  label: 'Test Runs',
  description: 'Suite orchestrator: start / poll / cancel named suites.',
  tier: 'quick',
  // Placeholder section — custom UI in operator-vite via P-006a.
  sections: [
    {
      id: 'all',
      label: 'Suites',
      description: 'All admin-test-suite runs.',
      runners: [{ kind: 'admin-suite', suiteId: 'desktop-health' }],
    },
  ],
});

defineTestDomain({
  id: 'live',
  label: 'Live',
  description: 'Passive observer: interactions, console, layout, unhandled errors.',
  tier: 'quick',
  sections: [
    { id: 'all', label: 'Observers', globs: ['apps/operator/app/admin/testing/_lib/vitals-*.test.ts'] },
  ],
});

defineTestDomain({
  id: 'memory',
  label: 'Memory',
  description: 'mem0 pgvector round-trip + memory-core suite + CRUD probe.',
  tier: 'quick',
  sections: [
    { id: 'core', label: 'Health', globs: ['apps/operator/lib/memory/**/*.test.ts'] },
  ],
});

defineTestDomain({
  id: 'chaos',
  label: 'Chaos',
  description: 'Autonomous clicker that drives the Tauri shell looking for crashes.',
  tier: 'quick',
  sections: [
    { id: 'host', label: 'Recorder host', globs: ['apps/operator/app/admin/testing/_lib/chaos-*.test.ts'] },
  ],
});

defineTestDomain({
  id: 'ai',
  label: 'AI Explore',
  description: 'Stagehand LLM walk over admin routes.',
  tier: 'quick',
  sections: [
    {
      id: 'prompts',
      label: 'Prompts',
      runners: [{ kind: 'admin-suite', suiteId: 'ai-explore-prompts' }],
    },
  ],
});

defineTestDomain({
  id: 'routes',
  label: 'Routes',
  description: 'Per-route INP rollup + Hono endpoint test surface.',
  tier: 'surface',
  sections: [
    {
      id: 'endpoint-tests',
      label: 'Endpoint tests',
      globs: ['apps/operator/lib/endpoint-route/__tests__/**/*.test.ts'],
    },
  ],
});

defineTestDomain({
  id: 'packaged',
  label: 'Packaged build',
  description: 'wdio + tauri-driver against the packaged binary.',
  tier: 'quick',
  sections: [
    {
      id: 'wdio',
      label: 'WebdriverIO',
      runners: [{ kind: 'admin-suite', suiteId: 'packaged-readiness' }],
    },
  ],
});

defineTestDomain({
  id: 'llm',
  label: 'LLM',
  description: 'Scenario-driven LLM evaluations (Runs / Scenarios / Targets / Findings).',
  tier: 'domain',
  sections: [
    { id: 'core', label: 'Core', globs: ['apps/operator/lib/llm-testing/__tests__/**/*.test.ts'] },
  ],
});

/* ---------------------------------------------------------------- *
 * Tier 2 — domains (12 new tabs)
 * ---------------------------------------------------------------- */

defineTestDomain({
  id: 'harness',
  label: 'Harness',
  description: 'Harness UI: dock, layouts, fs-watcher, status sweep, branch actions.',
  tier: 'domain',
  sections: [
    { id: 'dock', label: 'Dock', globs: ['apps/operator/app/harness/dock/**/*.test.*'] },
    { id: 'layout', label: 'Layout', globs: [
        'apps/operator/lib/dock-layouts.test.ts',
        'apps/operator/lib/dock-layout-migrators.test.ts',
      ] },
    { id: 'fs-watcher', label: 'FS watcher', globs: ['apps/operator/lib/harness-fs-watcher.test.ts'] },
    { id: 'status-sweep', label: 'Status sweep', globs: ['apps/operator/lib/harness-status-sweep.test.ts'] },
    { id: 'e2e', label: 'E2E', globs: [
        'apps/operator/e2e/harness-*.spec.ts',
        'apps/operator/e2e/dock.spec.ts',
      ] },
  ],
});

defineTestDomain({
  id: 'voice',
  label: 'Voice',
  description: 'Voice stack: cards, engines, persona, spend.',
  tier: 'domain',
  sections: [
    { id: 'cards', label: 'Cards', globs: ['apps/operator/lib/voice-cards/**/*.test.ts'] },
    { id: 'engines', label: 'Engines', globs: [
        'apps/operator/lib/voice-engines/**/*.test.ts',
        'apps/operator/lib/voice-engines.test.ts',
        'apps/operator/lib/voice-engine-health.test.ts',
      ] },
    { id: 'persona', label: 'Persona', globs: [
        'apps/operator/lib/op-backstory*.test.ts',
        'apps/operator/lib/op-narration-policy.test.ts',
        'apps/operator/lib/operator-persona.test.ts',
        'apps/operator/lib/classify-utterance-mode.test.ts',
      ] },
    { id: 'spend', label: 'Spend', globs: [
        'apps/operator/lib/stt-spend.test.ts',
        'apps/operator/lib/tts-spend.test.ts',
        'apps/operator/lib/elevenlabs-webhook-auth.test.ts',
      ] },
    { id: 'smoke', label: 'Smoke', runners: [
        { kind: 'node', cmd: 'node', args: ['apps/operator/scripts/el-suite-test.mjs'], label: 'el-suite' },
        { kind: 'node', cmd: 'node', args: ['apps/operator/scripts/voice-stack-check.mjs'], label: 'voice-stack-check' },
      ] },
  ],
});

defineTestDomain({
  id: 'papercusp-su',
  label: 'Papercusp-SU',
  description: 'Superuser surface: coordination, file locking, identity, tools.',
  tier: 'domain',
  sections: [
    {
      id: 'coordination',
      label: 'Coordination',
      description: 'Messages, plan-events, watermarks, subscriptions, escalations, handoffs, promote.',
      globs: [
        'apps/operator/lib/agent-tools/coordination/**/*.test.ts',
        'apps/operator/lib/agent-tools/agent_chats/**/*.test.ts',
      ],
    },
    {
      id: 'file-locking',
      label: 'File Locking',
      description: 'locks:* tools, file-lock-queue, su-locks integration.',
      globs: [
        'apps/operator/lib/agent-tools/locks/**/*.test.ts',
        'apps/operator/lib/endpoint-route/__tests__/su-locks*.test.ts',
        // P-030 migrated the legacy su-locks-e2e.sh into:
        'apps/operator/scripts/hooks/omp/__tests__/su-locks-omp.integration.test.ts',
      ],
    },
    {
      id: 'identity',
      label: 'Identity',
      description: 'Auth principals, device JWT, OAuth, audit, rate-limit, power-user.',
      globs: [
        'apps/operator/lib/agent-tools/coordination/identity*.test.ts',
        'apps/operator/lib/agent-tools/locks/identity*.test.ts',
        'apps/operator/lib/auth.test.ts',
        'apps/operator/lib/auth-*.test.ts',
        'apps/operator/lib/device-jwt*.test.ts',
        'apps/operator/lib/power-user-token*.test.ts',
        'apps/operator/lib/oauth/**/*.test.ts',
      ],
    },
    {
      id: 'tools',
      label: 'Tools',
      description: 'agent-tools surface + agent-mcp dispatch/projection/define-tool. coordination/locks live in their own sections above.',
      globs: [
        'apps/operator/lib/agent-tools/__tests__/**/*.test.ts',
        // Explicit positive list — my dependency-free matcher doesn't
        // support extglob negation (!(coordination|locks)).
        'apps/operator/lib/agent-tools/agent_chats/**/*.test.ts',
        'apps/operator/lib/agent-tools/agents/**/*.test.ts',
        'apps/operator/lib/agent-tools/agent_tools/**/*.test.ts',
        'apps/operator/lib/agent-tools/architect/**/*.test.ts',
        'apps/operator/lib/agent-tools/autoloop/**/*.test.ts',
        'apps/operator/lib/agent-tools/backup/**/*.test.ts',
        'apps/operator/lib/agent-tools/chat/**/*.test.ts',
        'apps/operator/lib/agent-tools/cross_harness/**/*.test.ts',
        'apps/operator/lib/agent-tools/delegates/**/*.test.ts',
        'apps/operator/lib/agent-tools/dev/**/*.test.ts',
        'apps/operator/lib/agent-tools/docs/**/*.test.ts',
        'apps/operator/lib/agent-tools/experts/**/*.test.ts',
        'apps/operator/lib/agent-tools/flags/**/*.test.ts',
        'apps/operator/lib/agent-tools/harness/**/*.test.ts',
        'apps/operator/lib/agent-tools/hooks/**/*.test.ts',
        'apps/operator/lib/agent-tools/memory/**/*.test.ts',
        'apps/operator/lib/agent-tools/messages/**/*.test.ts',
        'apps/operator/lib/agent-tools/omp/**/*.test.ts',
        'apps/operator/lib/agent-tools/operator/**/*.test.ts',
        'apps/operator/lib/agent-tools/oracle/**/*.test.ts',
        'apps/operator/lib/agent-tools/plans/**/*.test.ts',
        'apps/operator/lib/agent-tools/plugins/**/*.test.ts',
        'apps/operator/lib/agent-tools/processes/**/*.test.ts',
        'apps/operator/lib/agent-tools/projects/**/*.test.ts',
        'apps/operator/lib/agent-tools/roles/**/*.test.ts',
        'apps/operator/lib/agent-tools/search/**/*.test.ts',
        'apps/operator/lib/agent-tools/snapshots/**/*.test.ts',
        'apps/operator/lib/agent-tools/tasks/**/*.test.ts',
        'apps/operator/lib/agent-tools/ui/**/*.test.ts',
        'apps/operator/lib/agent-tools/wiki/**/*.test.ts',
        'packages/agent-mcp/**/*.test.ts',
      ],
    },
  ],
});

defineTestDomain({
  id: 'backup',
  label: 'Backup',
  description: 'Kopia backup integration: settings, policy, snapshot, self-exclusion.',
  tier: 'domain',
  sections: [
    { id: 'core', label: 'Core', globs: ['apps/operator/lib/backup/**/*.test.ts'] },
    { id: 'e2e', label: 'E2E', globs: ['apps/operator/e2e/backups.spec.ts'] },
  ],
});

defineTestDomain({
  id: 'plans',
  label: 'Plans',
  description: 'Plan-tracking surface: authoring, runs, revisions, concurrency, UI.',
  tier: 'domain',
  sections: [
    {
      id: 'authoring',
      label: 'Authoring',
      globs: [
        'apps/operator/lib/agent-tools/plans/__tests__/add-*.test.ts',
        'apps/operator/lib/agent-tools/plans/__tests__/set-*.test.ts',
        'apps/operator/lib/agent-tools/plans/__tests__/new.test.ts',
        'apps/operator/lib/agent-tools/plans/__tests__/lint.test.ts',
      ],
    },
    {
      id: 'runs',
      label: 'Runs',
      globs: [
        'apps/operator/lib/agent-tools/plans/__tests__/runs.test.ts',
        'apps/operator/lib/agent-tools/plans/__tests__/launch*.test.ts',
        'apps/operator/lib/agent-tools/plans/__tests__/resume*.test.ts',
        'apps/operator/lib/agent-tools/plans/__tests__/context-bundle.test.ts',
      ],
    },
    {
      id: 'revisions',
      label: 'Revisions',
      globs: [
        'apps/operator/lib/agent-tools/plans/__tests__/revision-*.test.ts',
        'apps/operator/lib/agent-tools/plans/__tests__/diff.test.ts',
      ],
    },
    {
      id: 'concurrency',
      label: 'Concurrency',
      globs: [
        'apps/operator/lib/agent-tools/plans/__tests__/concurrency*.test.ts',
        'apps/operator/lib/agent-tools/plans/__tests__/e2e.test.ts',
      ],
    },
    {
      id: 'ui',
      label: 'UI',
      globs: [
        'apps/operator/app/admin/plans/**/*.test.*',
        'apps/operator/lib/__tests__/client-navigation.test.ts',
        'apps/operator/lib/__tests__/desktop-static-host.test.ts',
        'apps/operator/lib/__tests__/desktop-ui-intents.test.ts',
        'apps/operator/lib/__tests__/operator-vite-dev-mode.test.ts',
        'apps/operator/lib/__tests__/lazy-with-retry.test.ts',
        'apps/operator/lib/__tests__/navigation-progress-helpers.test.ts',
        'apps/operator/app/admin/testing/_lib/recorder-start-params.test.ts',
        'apps/operator/app/_components/__tests__/SupportChatButton.test.tsx',
        'apps/operator/app/_components/__tests__/ChatwootWidget.test.tsx',
        'apps/operator/app/_components/__tests__/UiPresenceProvider.test.tsx',
        'apps/operator/app/_components/__tests__/OperatorChatSidebar.test.ts',
        'apps/operator/app/_components/__tests__/UserPicker.test.tsx',
        'apps/operator/lib/__tests__/PluginIframe.test.tsx',
        'apps/operator/lib/__tests__/notify.test.ts',
        'apps/operator/lib/__tests__/workspaces-tauri.test.ts',
        'apps/operator/app/_components/__tests__/routePending.test.ts',
        'apps/operator/app/_components/__tests__/RouteLink.test.ts',
        'apps/operator/app/_components/__tests__/RouteProgressProvider.test.ts',
        'apps/operator/app/_components/__tests__/ChromeShellNav.test.ts',
      ],
    },
  ],
});

defineTestDomain({
  id: 'operator',
  label: 'Operator',
  description: 'Operator brain: converse, scan, suggestions, audit, persona, state.',
  tier: 'domain',
  sections: [
    { id: 'brain', label: 'Brain', globs: ['apps/operator/lib/operator-converse*.test.ts'] },
    { id: 'cards', label: 'Cards', globs: ['apps/operator/lib/operator-card*.test.ts', 'apps/operator/lib/operator-cards/**/*.test.ts'] },
    { id: 'suggestions', label: 'Suggestions', globs: ['apps/operator/lib/operator-suggest*.test.ts', 'apps/operator/lib/operator-scan*.test.ts'] },
    { id: 'audit', label: 'Audit', globs: ['apps/operator/lib/operator-audit*.test.ts'] },
    { id: 'persona', label: 'Persona', globs: ['apps/operator/lib/operator-persona*.test.ts', 'apps/operator/lib/operator-prompt*.test.ts'] },
    { id: 'state', label: 'State', globs: ['apps/operator/lib/operator-state*.test.ts', 'apps/operator/lib/operator-trigger*.test.ts'] },
  ],
});

defineTestDomain({
  id: 'design',
  label: 'Design',
  description: 'Design phase: IR, adapters, spec, tokens, phase flow.',
  tier: 'domain',
  sections: [
    { id: 'ir', label: 'IR', globs: ['apps/operator/lib/design-ir*.test.ts'] },
    { id: 'adapters', label: 'Adapters', globs: ['apps/operator/lib/design-adapter*.test.ts'] },
    { id: 'spec', label: 'Spec', globs: ['apps/operator/lib/design-spec/**/*.test.ts'] },
    { id: 'phase-flow', label: 'Phase flow', globs: ['apps/operator/lib/design-phase*.test.ts'] },
  ],
});

defineTestDomain({
  id: 'plugins',
  label: 'Plugins',
  description: 'Plugin runtime: loader, SDK, WIT, grants, lifecycle, host-shim.',
  tier: 'domain',
  sections: [
    { id: 'loader', label: 'Loader', globs: ['packages/plugin-loader/**/*.test.ts'] },
    { id: 'sdk', label: 'SDK', globs: ['packages/plugin-sdk/**/*.test.ts'] },
    { id: 'wit', label: 'WIT', globs: ['packages/plugin-wit/**/*.test.ts'] },
    { id: 'grants', label: 'Grants', globs: ['apps/operator/lib/plugin-grants*.test.ts'] },
    { id: 'lifecycle', label: 'Lifecycle', globs: ['apps/operator/lib/plugin-*.test.ts'] },
  ],
});

defineTestDomain({
  id: 'transport',
  label: 'Transport',
  description: 'SSE / IPC / adapters / sync-resolver.',
  tier: 'surface',
  sections: [
    { id: 'sse', label: 'SSE', globs: ['libs/sse/**/*.test.ts'] },
    { id: 'ipc', label: 'IPC', globs: ['apps/operator/lib/endpoint-ipc/**/*.test.ts'] },
    { id: 'adapters', label: 'Adapters', globs: ['packages/desktop-ipc/src/**/*.test.ts'] },
  ],
});

defineTestDomain({
  id: 'snapshots',
  label: 'Snapshots',
  description: 'Snapshot shape, locks, fork, export-state, routes.',
  tier: 'domain',
  sections: [
    { id: 'shape', label: 'Shape', globs: ['apps/operator/lib/snapshot-shape*.test.ts'] },
    { id: 'locks', label: 'Locks', globs: ['apps/operator/lib/snapshot-lock*.test.ts'] },
    { id: 'fork', label: 'Fork', globs: ['apps/operator/lib/snapshot-fork*.test.ts'] },
    { id: 'export-state', label: 'Export-state', globs: ['packages/papercusp-export-state/**/*.test.ts'] },
    { id: 'routes', label: 'Routes', globs: ['apps/operator/lib/endpoint-route/__tests__/snapshot*.test.ts'] },
  ],
});

defineTestDomain({
  id: 'mobile',
  label: 'Mobile',
  description: 'Paired-device flow: pair, JWT, feeds, actions, voice init.',
  tier: 'domain',
  sections: [
    { id: 'pair', label: 'Pair', globs: ['apps/operator/lib/device-pair*.test.ts'] },
    { id: 'jwt', label: 'JWT', globs: ['apps/operator/lib/device-jwt*.test.ts'] },
    { id: 'feeds', label: 'Feeds', globs: ['apps/operator/lib/device-feed*.test.ts'] },
    { id: 'actions', label: 'Actions', globs: ['apps/operator/lib/device-action*.test.ts'] },
    { id: 'voice-init', label: 'Voice init', globs: ['apps/operator/lib/mobile-voice*.test.ts'] },
  ],
});

defineTestDomain({
  id: 'provisioning',
  label: 'Provisioning',
  description: 'Workspace provisioning: runner, sandbox, trust-store, templates, network.',
  tier: 'domain',
  sections: [
    { id: 'runner', label: 'Runner', globs: ['apps/operator/lib/provision/runner*.test.ts'] },
    { id: 'sandbox', label: 'Sandbox', globs: ['apps/operator/lib/provision/sandbox*.test.ts'] },
    { id: 'trust-store', label: 'Trust store', globs: ['apps/operator/lib/provision/trust*.test.ts'] },
    { id: 'templates', label: 'Templates', globs: ['apps/operator/lib/provision/template*.test.ts'] },
    { id: 'network', label: 'Network', globs: ['apps/operator/lib/provision/network*.test.ts'] },
  ],
});

defineTestDomain({
  id: 'docs',
  label: 'Docs',
  description: 'Docs engine: outline, search, adapters.',
  tier: 'surface',
  sections: [
    { id: 'engine', label: 'Engine', globs: ['packages/docs-engine/**/*.test.ts'] },
    { id: 'outline', label: 'Outline', globs: ['apps/operator/lib/agent-tools/docs/**/*.test.ts'] },
    { id: 'search', label: 'Search', globs: [
        'apps/operator/lib/search/**/*.test.ts',
        'apps/operator/lib/agent-tools/search/**/*.test.ts',
      ] },
    { id: 'adapters', label: 'Adapters', globs: ['apps/operator/lib/agent-tools/cross_harness/docs*.test.ts'] },
  ],
});
