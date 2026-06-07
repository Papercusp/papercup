/**
 * testing-domains-registry.ts — the operator's /admin/testing registry barrel.
 *
 * Plan: admin-testing-tab-restructure-2026-05-24 (P-002); split in Phase B
 * (P-010/P-011) of harness-tests-tab-and-tester-promotion-2026-05-26.
 *
 * The portable `routes` domain — the one that applies to any project —
 * lives in `@papercusp/testing-shell` as `universalDomains` (pure data);
 * this file resolves its `endpoints` role against the operator's own repo
 * (OPERATOR_ROLE_GLOBS) and registers it. The Papercusp-runtime-bound
 * test-runs / live / chaos / ai moved here from the lib (they can't run
 * against a non-Papercusp project as-is — D-002 option b), alongside the 16
 * other Papercusp-only domains — 20 in all (testing-shell-cross-project D-007).
 *
 * Importing this module side-effect-registers all 21 domains. The four
 * /admin/testing endpoint routes (P-003) side-effect-import it to populate
 * getTestDomain / listTestDomains; the SPA's left-rail tab list is
 * hardcoded in operator-vite's TestingClient (P-006a) and does not read
 * this file.
 *
 * Globs are repo-relative POSIX. Glob walk happens server-side at request
 * time (P-003) — no checked-in catalog to drift.
 *
 * Tier groupings (the 16 here): `quick` (memory, packaged), `domain`
 * (per-domain surfaces + llm), `surface` (transport, docs). The
 * generalized 5 carry tier `generalized`.
 */

import { defineTestDomain, getTestDomain, universalDomains, applyRoleGlobs, type TestDomain } from './testing-domains';

// The operator's role→globs map for the lib's universal domains: it supplies
// the concrete endpoint-test paths the lib leaves as the 'endpoints' role
// (testing-shell-cross-project D-007). applyRoleGlobs fills routes' globs so
// /admin/testing (and the registered Map) resolve against the operator repo.
const OPERATOR_ROLE_GLOBS: Record<string, string[]> = {
  endpoints: ['packages/operator-core/lib/endpoint-route/__tests__/**/*.test.ts'],
};

/** The lib's universal domains, resolved against the operator's own repo. */
const operatorUniversal: TestDomain[] = applyRoleGlobs(universalDomains, OPERATOR_ROLE_GLOBS);

// Register the universal domains (role-resolved) into the shared Map so
// /admin/testing's getTestDomain / listTestDomains see them.
for (const d of operatorUniversal) defineTestDomain(d);

/* ---------------------------------------------------------------- *
 * Papercusp-only domains (20). The portable `routes` domain lives in the lib
 * (@papercusp/testing-shell, universalDomains). The Papercusp-runtime-bound
 * test-runs/live/chaos/ai used to live there too but moved here — they can't
 * run against a non-Papercusp project as-is (D-002 option b; generalizing
 * them to drive each project's base URL is a deferred follow-up).
 * ---------------------------------------------------------------- */

// — Moved from the lib (formerly the generalized tier; now Papercusp 'quick') —
defineTestDomain({
  id: 'test-runs',
  label: 'Test Runs',
  description: 'Suite orchestrator: start / poll / cancel named suites.',
  tier: 'quick',
  sections: [
    {
      id: 'all',
      label: 'Suites',
      description: 'All admin-test-suite runs.',
      runners: [{ kind: 'admin-suite', suiteId: 'desktop-health' }],
    },
  ],
});

// Operator desktop vitals (LiveMetricsTab). Renamed `live` → `vitals` so the
// universal in-page observer (live-web, from buildUniversalTesting) owns the
// generic "Live" slot — universal-testing-domains-generic Phase 6.
defineTestDomain({
  id: 'vitals',
  label: 'Live metrics',
  description: 'Operator desktop vitals: interactions, console, layout, unhandled errors.',
  tier: 'quick',
  sections: [
    { id: 'all', label: 'Observers', globs: ['apps/operator/app/admin/testing/_lib/vitals-*.test.ts'] },
  ],
});

// The interactive Chaos panel is now the universal chaos-desktop (lib
// ChaosDesktopPanel via buildUniversalTesting); this domain keeps the recorder
// test-glob attached to the matching `chaos-desktop` id so the contract/harness
// view stay consistent.
defineTestDomain({
  id: 'chaos-desktop',
  label: 'Chaos (desktop)',
  description: 'In-app perf-recorder clicker that drives the Tauri shell looking for crashes.',
  tier: 'quick',
  sections: [
    { id: 'host', label: 'Recorder host', globs: ['apps/operator/app/admin/testing/_lib/chaos-*.test.ts'] },
  ],
});

// The interactive AI Explore panel is now the universal ai-explore (lib
// AiExplorePanel via buildUniversalTesting); this domain keeps the prompts suite
// attached to the matching `ai-explore` id.
defineTestDomain({
  id: 'ai-explore',
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
  id: 'memory',
  label: 'Memory',
  description: 'mem0 pgvector round-trip + memory-core suite + CRUD probe.',
  tier: 'quick',
  sections: [
    { id: 'core', label: 'Health', globs: ['packages/operator-core/lib/memory/**/*.test.ts'] },
    {
      id: 'live',
      label: 'Live',
      description:
        'Live session-extraction round-trip on the anthropic-direct transport (mem0-extraction-via-claude-session P-007): ' +
        'remember → Haiku-extracted facts → paraphrase-searchable, in an isolated PG schema. ' +
        'Needs a Claude session + PG + embedder key; exits 2 (skip) without a usable session.',
      runners: [
        {
          kind: 'node',
          cmd: 'npx',
          args: ['tsx', 'packages/operator-core/lib/memory/session-extraction-live.ts'],
          label: 'session-extraction round-trip (live Claude session)',
        },
      ],
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
    { id: 'core', label: 'Core', globs: ['packages/operator-core/lib/llm-testing/__tests__/**/*.test.ts'] },
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
        'packages/operator-core/lib/dock-layouts.test.ts',
        'packages/operator-core/lib/dock-layout-migrators.test.ts',
      ] },
    { id: 'fs-watcher', label: 'FS watcher', globs: ['packages/operator-core/lib/harness-fs-watcher.test.ts'] },
    { id: 'status-sweep', label: 'Status sweep', globs: ['packages/operator-core/lib/harness-status-sweep.test.ts'] },
    // Catch-the-rest for the harness lib surface (federation/dogfood-specific
    // harness/__tests__ files also appear under the Dogfood domain — overlap
    // is intentional).
    { id: 'lib', label: 'Lib', globs: [
        'packages/operator-core/lib/harness-*.test.ts',
        'packages/operator-core/lib/harness/**/*.test.ts',
        'packages/operator-core/lib/harness-insights/**/*.test.ts',
        'packages/operator-core/lib/harness-state/**/*.test.ts',
      ] },
    { id: 'app', label: 'App UI', globs: ['apps/operator/app/harness/**/*.test.*'] },
    { id: 'e2e', label: 'E2E', globs: [
        'apps/operator/e2e/harness-*.spec.ts',
        'apps/operator/e2e/dock.spec.ts',
      ] },
  ],
});

defineTestDomain({
  id: 'voice',
  label: 'Voice',
  description: 'Voice stack: runtime/capture, cards, engines, persona, spend.',
  tier: 'domain',
  sections: [
    { id: 'runtime', label: 'Runtime', globs: ['apps/operator/app/_components/voice/**/*.test.*'] },
    { id: 'cards', label: 'Cards', globs: ['packages/operator-core/lib/voice-cards/**/*.test.ts'] },
    { id: 'engines', label: 'Engines', globs: [
        'packages/operator-core/lib/voice-engines/**/*.test.ts',
        'packages/operator-core/lib/voice-engines.test.ts',
        'packages/operator-core/lib/voice-engine-health.test.ts',
      ] },
    { id: 'persona', label: 'Persona', globs: [
        'packages/operator-core/lib/op-backstory*.test.ts',
        'packages/operator-core/lib/op-narration-policy.test.ts',
        'packages/operator-core/lib/operator-persona.test.ts',
        'packages/operator-core/lib/classify-utterance-mode.test.ts',
      ] },
    { id: 'spend', label: 'Spend', globs: [
        'packages/operator-core/lib/stt-spend.test.ts',
        'packages/operator-core/lib/tts-spend.test.ts',
        'packages/operator-core/lib/elevenlabs-webhook-auth.test.ts',
      ] },
    // Catch-the-rest for the voice-* lib surface so new voice tests appear
    // without a per-file registry edit.
    { id: 'lib', label: 'Lib', globs: [
        'packages/operator-core/lib/voice-*.test.ts',
        'packages/operator-core/lib/voice/**/*.test.ts',
      ] },
    { id: 'smoke', label: 'Smoke', runners: [
        { kind: 'node', cmd: 'node', args: ['apps/operator/scripts/el-suite-test.mjs'], label: 'el-suite' },
        { kind: 'node', cmd: 'node', args: ['apps/operator/scripts/voice-stack-check.mjs'], label: 'voice-stack-check' },
        { kind: 'node', cmd: 'node', args: ['apps/operator/scripts/el-connect-test.mjs'], label: 'el-connect (live EL creds)' },
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
        'packages/operator-core/lib/agent-tools/coordination/**/*.test.ts',
        'packages/operator-core/lib/agent-tools/agent_chats/**/*.test.ts',
      ],
    },
    {
      id: 'file-locking',
      label: 'File Locking',
      description: 'locks:* tools, file-lock-queue, su-locks integration.',
      globs: [
        'packages/operator-core/lib/agent-tools/locks/**/*.test.ts',
        'packages/operator-core/lib/endpoint-route/__tests__/su-locks*.test.ts',
        // P-030 migrated the legacy su-locks-e2e.sh into:
        'apps/operator/scripts/hooks/omp/__tests__/su-locks-omp.integration.test.ts',
      ],
    },
    {
      id: 'identity',
      label: 'Identity',
      description: 'Auth principals, device JWT, OAuth, audit, rate-limit, power-user.',
      globs: [
        'packages/operator-core/lib/agent-tools/coordination/identity*.test.ts',
        'packages/operator-core/lib/agent-tools/locks/identity*.test.ts',
        'packages/operator-core/lib/auth.test.ts',
        'packages/operator-core/lib/auth-*.test.ts',
        'packages/operator-core/lib/device-jwt*.test.ts',
        'packages/operator-core/lib/power-user-token*.test.ts',
        'packages/operator-core/lib/oauth/**/*.test.ts',
      ],
    },
    {
      id: 'tools',
      label: 'Tools',
      description: 'agent-tools surface + agent-mcp dispatch/projection/define-tool. coordination/locks live in their own sections above.',
      globs: [
        'packages/operator-core/lib/agent-tools/__tests__/**/*.test.ts',
        // Explicit positive list — my dependency-free matcher doesn't
        // support extglob negation (!(coordination|locks)).
        'packages/operator-core/lib/agent-tools/agent_chats/**/*.test.ts',
        'packages/operator-core/lib/agent-tools/agents/**/*.test.ts',
        'packages/operator-core/lib/agent-tools/agent_tools/**/*.test.ts',
        'packages/operator-core/lib/agent-tools/architect/**/*.test.ts',
        'packages/operator-core/lib/agent-tools/autoloop/**/*.test.ts',
        'packages/operator-core/lib/agent-tools/backup/**/*.test.ts',
        'packages/operator-core/lib/agent-tools/chat/**/*.test.ts',
        'packages/operator-core/lib/agent-tools/cross_harness/**/*.test.ts',
        'packages/operator-core/lib/agent-tools/delegates/**/*.test.ts',
        'packages/operator-core/lib/agent-tools/dev/**/*.test.ts',
        'packages/operator-core/lib/agent-tools/docs/**/*.test.ts',
        'packages/operator-core/lib/agent-tools/flags/**/*.test.ts',
        'packages/operator-core/lib/agent-tools/harness/**/*.test.ts',
        'packages/operator-core/lib/agent-tools/hooks/**/*.test.ts',
        'packages/operator-core/lib/agent-tools/memory/**/*.test.ts',
        'packages/operator-core/lib/agent-tools/messages/**/*.test.ts',
        'packages/operator-core/lib/agent-tools/omp/**/*.test.ts',
        'packages/operator-core/lib/agent-tools/operator/**/*.test.ts',
        'packages/operator-core/lib/agent-tools/oracle/**/*.test.ts',
        'packages/operator-core/lib/agent-tools/plans/**/*.test.ts',
        'packages/operator-core/lib/agent-tools/plugins/**/*.test.ts',
        'packages/operator-core/lib/agent-tools/processes/**/*.test.ts',
        'packages/operator-core/lib/agent-tools/projects/**/*.test.ts',
        'packages/operator-core/lib/agent-tools/roles/**/*.test.ts',
        'packages/operator-core/lib/agent-tools/search/**/*.test.ts',
        'packages/operator-core/lib/agent-tools/snapshots/**/*.test.ts',
        'packages/operator-core/lib/agent-tools/tasks/**/*.test.ts',
        'packages/operator-core/lib/agent-tools/ui/**/*.test.ts',
        'packages/operator-core/lib/agent-tools/wiki/**/*.test.ts',
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
    { id: 'core', label: 'Core', globs: ['packages/operator-core/lib/backup/**/*.test.ts'] },
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
        'packages/operator-core/lib/agent-tools/plans/__tests__/add-*.test.ts',
        'packages/operator-core/lib/agent-tools/plans/__tests__/set-*.test.ts',
        'packages/operator-core/lib/agent-tools/plans/__tests__/new.test.ts',
        'packages/operator-core/lib/agent-tools/plans/__tests__/lint.test.ts',
      ],
    },
    {
      id: 'runs',
      label: 'Runs',
      globs: [
        'packages/operator-core/lib/agent-tools/plans/__tests__/runs.test.ts',
        'packages/operator-core/lib/agent-tools/plans/__tests__/launch*.test.ts',
        'packages/operator-core/lib/agent-tools/plans/__tests__/resume*.test.ts',
        'packages/operator-core/lib/agent-tools/plans/__tests__/context-bundle.test.ts',
      ],
    },
    {
      id: 'revisions',
      label: 'Revisions',
      globs: [
        'packages/operator-core/lib/agent-tools/plans/__tests__/revision-*.test.ts',
        'packages/operator-core/lib/agent-tools/plans/__tests__/diff.test.ts',
      ],
    },
    {
      id: 'concurrency',
      label: 'Concurrency',
      globs: [
        'packages/operator-core/lib/agent-tools/plans/__tests__/concurrency*.test.ts',
        'packages/operator-core/lib/agent-tools/plans/__tests__/e2e.test.ts',
      ],
    },
    // Catch-the-rest for the plans tool __tests__ dir + the plans admin UI.
    { id: 'tools', label: 'Tools', globs: ['packages/operator-core/lib/agent-tools/plans/__tests__/**/*.test.ts'] },
    { id: 'app', label: 'App UI', globs: ['apps/operator/app/admin/plans/**/*.test.*'] },
    {
      id: 'ui',
      label: 'UI',
      globs: [
        'apps/operator/app/admin/plans/**/*.test.*',
        'packages/operator-core/lib/__tests__/client-navigation.test.ts',
        'packages/operator-core/lib/__tests__/desktop-static-host.test.ts',
        'packages/operator-core/lib/__tests__/desktop-ui-intents.test.ts',
        'packages/operator-core/lib/__tests__/operator-vite-dev-mode.test.ts',
        'packages/operator-core/lib/__tests__/lazy-with-retry.test.ts',
        'packages/operator-core/lib/__tests__/navigation-progress-helpers.test.ts',
        'apps/operator/app/admin/testing/_lib/recorder-start-params.test.ts',
        'apps/operator/app/_components/__tests__/SupportChatButton.test.tsx',
        'apps/operator/app/_components/__tests__/ChatwootWidget.test.tsx',
        'apps/operator/app/_components/__tests__/UiPresenceProvider.test.tsx',
        'apps/operator/app/_components/__tests__/OperatorChatSidebar.test.ts',
        'apps/operator/app/_components/__tests__/UserPicker.test.tsx',
        'packages/operator-core/lib/__tests__/PluginIframe.test.tsx',
        'packages/operator-core/lib/__tests__/notify.test.ts',
        'packages/operator-core/lib/__tests__/workspaces-tauri.test.ts',
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
    { id: 'brain', label: 'Brain', globs: ['packages/operator-core/lib/operator-converse*.test.ts'] },
    { id: 'cards', label: 'Cards', globs: ['packages/operator-core/lib/operator-card*.test.ts'] },
    { id: 'suggestions', label: 'Suggestions', globs: ['packages/operator-core/lib/operator-suggest*.test.ts', 'packages/operator-core/lib/operator-scan*.test.ts'] },
    { id: 'audit', label: 'Audit', globs: ['packages/operator-core/lib/operator-audit*.test.ts'] },
    { id: 'persona', label: 'Persona', globs: ['packages/operator-core/lib/operator-persona*.test.ts', 'packages/operator-core/lib/operator-prompt*.test.ts'] },
    { id: 'state', label: 'State', globs: ['packages/operator-core/lib/operator-state*.test.ts', 'packages/operator-core/lib/operator-trigger*.test.ts'] },
    // Catch-the-rest: every operator-*.test.ts at lib root (converse/scan/etc.
    // are already sectioned above; this surfaces the long tail too).
    { id: 'lib', label: 'Lib', globs: ['packages/operator-core/lib/operator-*.test.ts'] },
  ],
});

defineTestDomain({
  id: 'design',
  label: 'Design',
  description: 'Design phase: IR, adapters, spec, tokens, phase flow.',
  tier: 'domain',
  sections: [
    { id: 'ir', label: 'IR', globs: ['packages/operator-core/lib/design-ir*.test.ts'] },
    { id: 'adapters', label: 'Adapters', globs: ['packages/operator-core/lib/design-adapter*.test.ts'] },
    { id: 'spec', label: 'Spec', globs: ['packages/operator-core/lib/design-spec/**/*.test.ts'] },
    { id: 'phase-flow', label: 'Phase flow', globs: ['packages/operator-core/lib/design-phase*.test.ts'] },
    // Catch-the-rest for the design-* lib surface + design-tokens outputs.
    { id: 'lib', label: 'Lib', globs: [
        'packages/operator-core/lib/design-*.test.ts',
        'packages/operator-core/lib/design/**/*.test.ts',
        'design-tokens/**/*.test.ts',
      ] },
    // Live E2E smoke (needs a running operator) — surfaced as a runner.
    { id: 'smoke', label: 'Smoke', runners: [
        { kind: 'node', cmd: 'node', args: ['apps/operator/scripts/design-loop-smoke.mjs'], label: 'design-loop (live operator)' },
      ] },
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
    { id: 'grants', label: 'Grants', globs: ['packages/operator-core/lib/plugin-grants*.test.ts'] },
    { id: 'lifecycle', label: 'Lifecycle', globs: ['packages/operator-core/lib/plugin-*.test.ts'] },
  ],
});

defineTestDomain({
  id: 'transport',
  label: 'Transport',
  description: 'SSE / IPC / adapters / sync-resolver.',
  tier: 'surface',
  sections: [
    { id: 'sse', label: 'SSE', globs: ['libs/generic/sse/**/*.test.ts'] },
    { id: 'ipc', label: 'IPC', globs: [
        'packages/operator-core/lib/endpoint-ipc/**/*.test.ts',
        'libs/generic/ipc-endpoint-server/**/*.test.ts',
        'libs/generic/ipc-framing/**/*.test.ts',
      ] },
    { id: 'adapters', label: 'Adapters', globs: [
        'libs/generic/desktop-ipc/src/**/*.test.ts',
        'packages/operator-core/lib/transport-adapters/**/*.test.ts',
      ] },
  ],
});

defineTestDomain({
  id: 'snapshots',
  label: 'Snapshots',
  description: 'Snapshot shape, locks, fork, export-state, routes.',
  tier: 'domain',
  sections: [
    { id: 'shape', label: 'Shape', globs: ['packages/operator-core/lib/snapshot-shape*.test.ts'] },
    { id: 'locks', label: 'Locks', globs: ['packages/operator-core/lib/snapshot-lock*.test.ts'] },
    { id: 'fork', label: 'Fork', globs: ['packages/operator-core/lib/snapshot-fork*.test.ts'] },
    { id: 'export-state', label: 'Export-state', globs: ['libs/papercusp-export-state/src/**/*.test.ts'] },
    { id: 'routes', label: 'Routes', globs: ['packages/operator-core/lib/endpoint-route/__tests__/snapshot*.test.ts'] },
  ],
});

defineTestDomain({
  id: 'mobile',
  label: 'Mobile',
  description: 'Paired-device flow: pair, JWT, feeds, actions, voice init.',
  tier: 'domain',
  sections: [
    { id: 'pair', label: 'Pair', globs: ['packages/operator-core/lib/device-pair*.test.ts'] },
    { id: 'jwt', label: 'JWT', globs: ['packages/operator-core/lib/device-jwt*.test.ts'] },
    { id: 'feeds', label: 'Feeds', globs: ['packages/operator-core/lib/device-feed*.test.ts'] },
    // Catch-the-rest for the device-*/mobile-* lib surface.
    { id: 'lib', label: 'Lib', globs: [
        'packages/operator-core/lib/device-*.test.ts',
        'packages/operator-core/lib/mobile-*.test.ts',
      ] },
  ],
});

defineTestDomain({
  id: 'provisioning',
  label: 'Provisioning',
  description: 'Workspace provisioning: runner, sandbox, trust-store, templates, network.',
  tier: 'domain',
  sections: [
    { id: 'runner', label: 'Runner', globs: ['packages/operator-core/lib/provision/runner*.test.ts'] },
    { id: 'sandbox', label: 'Sandbox', globs: ['packages/operator-core/lib/provision/sandbox*.test.ts'] },
    { id: 'trust-store', label: 'Trust store', globs: ['packages/operator-core/lib/provision/trust*.test.ts'] },
    { id: 'network', label: 'Network', globs: ['packages/operator-core/lib/provision/network*.test.ts'] },
    // Catch-the-rest for everything under the provision/ dir.
    { id: 'lib', label: 'Lib', globs: ['packages/operator-core/lib/provision/**/*.test.ts'] },
  ],
});

defineTestDomain({
  id: 'docs',
  label: 'Docs',
  description: 'Docs engine: outline, search, adapters.',
  tier: 'surface',
  sections: [
    { id: 'engine', label: 'Engine', globs: ['packages/docs-engine/**/*.test.ts'] },
    { id: 'outline', label: 'Outline', globs: ['packages/operator-core/lib/agent-tools/docs/**/*.test.ts'] },
    { id: 'search', label: 'Search', globs: [
        'packages/operator-core/lib/search/**/*.test.ts',
        'packages/operator-core/lib/agent-tools/search/**/*.test.ts',
      ] },
    { id: 'adapters', label: 'Adapters', globs: ['packages/operator-core/lib/agent-tools/cross_harness/docs*.test.ts'] },
  ],
});

/* ---------------------------------------------------------------- *
 * Dogfood — the shared-harness collaborative substrate (plan
 * dogfood-test-suite-2026-06-01). One sectioned domain covering the
 * Model-B sync layer, identity/binding, federation, orchestrator
 * claim, PR lifecycle, reactivity, revocation, the Cupboard public
 * API, the collaboration UI, and the endpoint routes — surfaces the
 * ~80 existing substrate/identity/orchestrator/pr-host tests (which
 * no prior domain globbed) plus the new coverage this plan adds.
 * Cross-section overlap (e.g. revocation ⊂ substrate) is intentional:
 * the matcher doesn't negate, and a sub-view is worth its own glob.
 * ---------------------------------------------------------------- */
defineTestDomain({
  id: 'dogfood',
  label: 'Dogfood',
  description: 'Shared-harness collaborative substrate: Model-B sync, identity/binding, federation, claims, PR lifecycle, Cupboard.',
  tier: 'domain',
  sections: [
    {
      id: 'substrate',
      label: 'Substrate',
      description: 'Model-B per-peer signed logs + LWW read-merge + projections + boot/swarm.',
      globs: ['packages/operator-core/lib/sync/hyperbee/**/*.test.ts'],
    },
    {
      id: 'identity-binding',
      label: 'Identity & binding',
      description: 'Device keychain, Ed25519 signing, two-channel binding, attestation.',
      globs: ['packages/operator-core/lib/identity/**/*.test.ts'],
    },
    {
      id: 'federation',
      label: 'Federation',
      description: 'Join/share, user-branch, binding publish, tree classifier, clone, register.',
      globs: [
        'packages/operator-core/lib/harness/__tests__/**/*.test.ts',
        'packages/operator-core/lib/harness/classify-tree.test.ts',
        'packages/operator-core/lib/harness/clone-github.test.ts',
        'packages/operator-core/lib/harness/register-papercup.test.ts',
        'packages/operator-core/lib/harness/papercusp-workspace.test.ts',
        'packages/operator-core/lib/harness/contributor-row-types.test.ts',
        'packages/operator-core/lib/harness/contributor-usage-event-types.test.ts',
        'packages/operator-core/lib/harness/feature-queue-row-types.test.ts',
      ],
    },
    {
      id: 'claim',
      label: 'Claim',
      description: 'Orchestrator distributed/advisory feature claim + audit + multi-harness spawning smoke.',
      globs: ['packages/operator-core/lib/orchestrator/**/*.test.ts'],
      // Live multi-harness-spawning E2E (drives a running operator) — runner.
      runners: [
        { kind: 'shell', cmd: 'bash', args: ['bin/smoke-multi-harness-spawning.sh'], label: 'multi-harness spawning (live)' },
      ],
    },
    {
      id: 'pr-lifecycle',
      label: 'PR lifecycle',
      description: 'PrHost, poll daemon + retry, auto-approve/merge, reviewer settings.',
      globs: ['packages/operator-core/lib/pr-host/**/*.test.ts'],
    },
    {
      id: 'completion-ref',
      label: 'Completion ref',
      description: 'completion_ref writer + background ls-remote verifier.',
      globs: ['packages/operator-core/lib/harness/completion-ref-*.test.ts'],
    },
    {
      id: 'reactivity',
      label: 'Reactivity',
      description: 'sync-resolver query registry + sync-sse bridge + emit-change-notify trigger sentinel.',
      globs: [
        'packages/operator-core/lib/sync-resolver/**/*.test.ts',
        'packages/operator-core/lib/sync-sse.test.ts',
      ],
      // Live-PG regression sentinel (brings its own embedded PG) — see
      // agent-insights/live-pg-regression-sentinel.
      runners: [
        { kind: 'node', cmd: 'node', args: ['apps/operator/scripts/verify-trigger-consolidation.mjs'], label: 'emit-change-notify sentinel' },
      ],
    },
    {
      id: 'revocation',
      label: 'Revocation',
      description: 'Self-device + contributor revocation, enforcement, re-verify, MCP tools.',
      globs: [
        'packages/operator-core/lib/sync/hyperbee/__tests__/revoke-*.test.ts',
        'packages/operator-core/lib/sync/hyperbee/__tests__/revocation-enforcement.test.ts',
        'packages/operator-core/lib/sync/hyperbee/__tests__/reverify-admitted.test.ts',
        'packages/operator-core/lib/sync/hyperbee/__tests__/boot-revoke-production-path.test.ts',
        'packages/operator-core/lib/agent-tools/substrate/**/*.test.ts',
      ],
    },
    {
      id: 'cupboard',
      label: 'Cupboard',
      description: 'Public harness-discovery API (operator-public).',
      globs: ['apps/operator-public/src/**/*.test.ts'],
    },
    {
      id: 'ui',
      label: 'UI',
      description: 'Create/Share/Join, PRs, Insights cards, claim/contributor/binding badges.',
      globs: [
        'apps/operator/app/harness/__tests__/**/*.test.tsx',
        'apps/operator/app/harness/insights/__tests__/**/*.test.tsx',
        'apps/operator/app/harness/PrsTab.component.test.tsx',
        'apps/operator/app/_components/__tests__/ContributorBadge.test.tsx',
        'apps/operator/app/_components/__tests__/ClaimStatusBadge.test.tsx',
        'apps/operator/app/_components/__tests__/HarnessClaimHeader.test.tsx',
        'apps/operator/app/_components/__tests__/BindingStatusBadge.test.tsx',
        'apps/operator/app/users/github/[id]/__tests__/**/*.test.tsx',
      ],
    },
    {
      id: 'routes',
      label: 'Routes',
      description: 'Substrate revoke, join/share/feature-queue/discord, user-profile endpoints.',
      globs: [
        'packages/operator-core/lib/endpoint-route/routes/admin/__tests__/substrate-*.test.ts',
        'packages/operator-core/lib/endpoint-route/routes/admin/__tests__/dogfood-substrate-*.test.ts',
        'packages/operator-core/lib/endpoint-route/routes/harness/__tests__/**/*.test.ts',
        'packages/operator-core/lib/endpoint-route/routes/users/__tests__/**/*.test.ts',
      ],
    },
    {
      id: 'e2e',
      label: 'E2E',
      description: 'Browser collaboration flows (Playwright).',
      globs: ['apps/operator/e2e/collab-*.spec.ts'],
    },
  ],
});

/* ---------------------------------------------------------------- *
 * Newer subsystems that grew their own test trees after the original 20
 * domains were hand-curated, plus catch-all domains so NO canonical test
 * is ever invisible in the tab. Globs are directory/prefix-level so new
 * tests in an existing area appear with no registry edit; a genuinely new
 * subsystem (a new top-level dir) trips the coverage guard
 * (scripts/lint-tests.ts) which forces a one-line glob add here.
 * ---------------------------------------------------------------- */

defineTestDomain({
  id: 'gym',
  label: 'Gym',
  description: 'Agent gym / eval harness.',
  tier: 'domain',
  sections: [
    { id: 'lib', label: 'Lib', globs: [
        'packages/operator-core/lib/gym/**/*.test.ts',
        'packages/operator-core/lib/gym/**/*.test.tsx',
        'packages/operator-core/lib/gym-*.test.ts',
      ] },
  ],
});

defineTestDomain({
  id: 'dbos',
  label: 'DBOS',
  description: 'Durable workflow engine: steps, crash-replay, sweep glue.',
  tier: 'domain',
  sections: [
    { id: 'lib', label: 'Lib', globs: [
        'packages/operator-core/lib/dbos/**/*.test.ts',
        'packages/operator-core/lib/dbos-*.test.ts',
      ] },
    { id: 'integration', label: 'Integration', globs: ['apps/operator/test/dbos-*.integration.test.ts'] },
  ],
});

defineTestDomain({
  id: 'workspace',
  label: 'Workspace',
  description: 'Workspace registry, multi-workspace context, per-window scoping.',
  tier: 'domain',
  sections: [
    { id: 'lib', label: 'Lib', globs: [
        'packages/operator-core/lib/workspace-*.test.ts',
        'packages/operator-core/lib/workspaces-*.test.ts',
        'packages/operator-core/lib/workspace/**/*.test.ts',
      ] },
  ],
});

defineTestDomain({
  id: 'adv',
  label: 'ADV Shell',
  description: 'The /adv operator shell: dock panels, sessions, contributors, Vite SPA.',
  tier: 'domain',
  sections: [
    { id: 'panels', label: 'Panels', globs: [
        'apps/operator/app/adv/**/*.test.ts',
        'apps/operator/app/adv/**/*.test.tsx',
        'packages/operator-core/lib/adv-*.test.ts',
      ] },
    { id: 'vite', label: 'Vite SPA', globs: [
        'apps/operator-vite/src/**/*.test.ts',
        'apps/operator-vite/src/**/*.test.tsx',
        // Root-level operator-vite tests (e.g. dev-dist-prune.test.ts — the
        // dev-watch build-churn tooling lives at the package root, not src/).
        'apps/operator-vite/*.test.ts',
        'apps/operator-vite/*.test.tsx',
      ] },
  ],
});

defineTestDomain({
  id: 'operator-core',
  label: 'Operator (core & misc)',
  description: 'Flat catch-all for the operator app: every lib/app/bin/script/integration test, so nothing is invisible. Files here may also appear under a more specific domain — overlap is intentional.',
  tier: 'domain',
  sections: [
    { id: 'lib-root', label: 'lib (root)', globs: [
        'packages/operator-core/lib/*.test.ts',
        'packages/operator-core/lib/*.test.tsx',
      ] },
    { id: 'lib-subdirs', label: 'lib (subdirs)', globs: [
        'packages/operator-core/lib/*/*.test.ts',
        'packages/operator-core/lib/*/*.test.tsx',
        'packages/operator-core/lib/*/__tests__/**/*.test.ts',
        'packages/operator-core/lib/*/__tests__/**/*.test.tsx',
        'packages/operator-core/lib/endpoint-route/routes/**/*.test.ts',
      ] },
    { id: 'lib-tests', label: 'lib/__tests__', globs: [
        'packages/operator-core/lib/__tests__/**/*.test.ts',
        'packages/operator-core/lib/__tests__/**/*.test.tsx',
      ] },
    { id: 'app', label: 'app', globs: [
        'apps/operator/app/**/*.test.ts',
        'apps/operator/app/**/*.test.tsx',
      ] },
    { id: 'bin-scripts', label: 'bin / scripts', globs: [
        'apps/operator/bin/**/*.test.ts',
        'apps/operator/scripts/**/*.test.ts',
        'apps/operator/scripts/**/*.test.mjs',
      ] },
    { id: 'integration', label: 'Integration (test/)', globs: [
        'apps/operator/test/**/*.test.ts',
        'apps/operator/__tests__/**/*.test.ts',
      ] },
    { id: 'e2e', label: 'E2E (all specs)', globs: ['apps/operator/e2e/*.spec.ts'] },
  ],
});

defineTestDomain({
  id: 'libraries',
  label: 'Libraries',
  description: 'Shared libs + packages the operator depends on (libs/*, packages/*, tools/*).',
  tier: 'surface',
  sections: [
    { id: 'generic', label: 'libs/generic', globs: [
        'libs/generic/**/*.test.ts',
        'libs/generic/**/*.test.tsx',
        // papergrid + search-core use `.spec.ts` for Vitest (Restart-style).
        'libs/generic/**/*.spec.ts',
      ] },
    { id: 'papercusp', label: 'libs/papercusp', globs: [
        'libs/papercusp/packages/**/*.test.ts',
        'libs/papercusp/packages/**/*.test.tsx',
        'libs/papercusp/packages/**/*.spec.ts',
        'libs/papercusp/libs/**/*.test.ts',
      ] },
    { id: 'operator-libs', label: 'operator libs', globs: [
        'libs/papercup-shared/src/**/*.test.ts',
        'libs/papercup-shared/src/**/*.test.tsx',
        'libs/papercusp-export-state/src/**/*.test.ts',
        'libs/papercusp-publish-auth/src/**/*.test.ts',
        'libs/host-platform/src/**/*.test.ts',
        'libs/flags/src/**/*.test.ts',
        'libs/test-config/src/**/*.test.ts',
        'libs/testing-shell/src/**/*.test.ts',
        'libs/testing-shell/src/**/*.test.tsx',
        // The standalone publish worker (Cloudflare).
        'apps/papercusp-publish/src/**/*.test.ts',
      ] },
    { id: 'ui-libs', label: 'UI libs', globs: [
        'libs/marketplace-public-ui/src/**/*.test.ts',
        'libs/marketplace-public-ui/src/**/*.test.tsx',
        'libs/agent-chat/src/**/*.test.ts',
        'libs/agent-chat/src/**/*.test.tsx',
      ] },
    { id: 'packages', label: 'packages', globs: [
        'packages/**/*.test.ts',
        'packages/**/*.test.tsx',
        'packages/**/*.spec.ts',
      ] },
    { id: 'tools', label: 'tools', globs: [
        'tools/**/*.test.ts',
        'tools/**/*.test.mjs',
        'tools/**/*.spec.ts',
      ] },
  ],
});

defineTestDomain({
  id: 'harness-framework',
  label: 'Harness Framework',
  description: 'libs/papercusp framework end-to-end smokes (bash). Live — drive real services; surfaced as shell runners, not Vitest.',
  tier: 'surface',
  sections: [
    {
      id: 'smokes',
      label: 'Smokes',
      description: 'Full-stack, planner, and service-gate smokes for the Papercusp harness framework.',
      runners: [
        { kind: 'shell', cmd: 'bash', args: ['libs/papercusp/bin/papercusp-smoketest.sh'], label: 'framework full-stack' },
        { kind: 'shell', cmd: 'bash', args: ['libs/papercusp/packages/harness/bin/smoke-test.sh'], label: 'planner smoke' },
        { kind: 'shell', cmd: 'bash', args: ['libs/papercusp/packages/harness/bin/service-smoke-test.sh'], label: 'service gate (run.sh DONE)' },
      ],
    },
  ],
});

/* ---------------------------------------------------------------- *
 * Composed views (P-011). `papercuspRegistry` = the 20 declared above
 * (read back from the Map by id); `adminRegistry` = universal + papercusp
 * = the full /admin/testing set. The SPA nav order is TestingClient's own
 * TABS, not these arrays.
 * ---------------------------------------------------------------- */

defineTestDomain({
  id: 'operator-ui-lib',
  label: 'Operator UI lib',
  description: 'UI-tier lib kept in apps/operator after the operator-core carve (router-compat, flag-hooks, plugin UI, forms, chat-cards, theme/notify/visual-effects hooks + the operator-vite/script/bin-composition tests).',
  tier: 'quick',
  sections: [
    { id: 'all', label: 'UI lib', globs: ['apps/operator/lib/**/*.test.ts', 'apps/operator/lib/**/*.test.tsx'] },
  ],
});

const PAPERCUSP_IDS = [
  'test-runs', 'vitals', 'chaos-desktop', 'ai-explore',
  'memory', 'packaged', 'llm', 'harness', 'voice', 'papercusp-su', 'backup',
  'plans', 'operator', 'design', 'plugins', 'transport', 'snapshots', 'mobile',
  'provisioning', 'docs', 'dogfood',
  // Subsystems + catch-alls added by the test-framework coverage audit.
  'gym', 'dbos', 'workspace', 'adv', 'operator-core', 'operator-ui-lib', 'libraries', 'harness-framework',
] as const;

export const papercuspRegistry: TestDomain[] = PAPERCUSP_IDS.map((id) => {
  const d = getTestDomain(id);
  if (!d) throw new Error(`testing-domains-registry: papercusp domain '${id}' not registered`);
  return d;
});

export const adminRegistry: TestDomain[] = [...operatorUniversal, ...papercuspRegistry];
