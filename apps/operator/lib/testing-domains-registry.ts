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
  endpoints: ['apps/operator/lib/endpoint-route/__tests__/**/*.test.ts'],
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
  id: 'memory',
  label: 'Memory',
  description: 'mem0 pgvector round-trip + memory-core suite + CRUD probe.',
  tier: 'quick',
  sections: [
    { id: 'core', label: 'Health', globs: ['apps/operator/lib/memory/**/*.test.ts'] },
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
    // Catch-the-rest for the harness lib surface (federation/dogfood-specific
    // harness/__tests__ files also appear under the Dogfood domain — overlap
    // is intentional).
    { id: 'lib', label: 'Lib', globs: [
        'apps/operator/lib/harness-*.test.ts',
        'apps/operator/lib/harness/**/*.test.ts',
        'apps/operator/lib/harness-insights/**/*.test.ts',
        'apps/operator/lib/harness-state/**/*.test.ts',
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
    // Catch-the-rest for the voice-* lib surface so new voice tests appear
    // without a per-file registry edit.
    { id: 'lib', label: 'Lib', globs: [
        'apps/operator/lib/voice-*.test.ts',
        'apps/operator/lib/voice/**/*.test.ts',
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
    // Catch-the-rest for the plans tool __tests__ dir + the plans admin UI.
    { id: 'tools', label: 'Tools', globs: ['apps/operator/lib/agent-tools/plans/__tests__/**/*.test.ts'] },
    { id: 'app', label: 'App UI', globs: ['apps/operator/app/admin/plans/**/*.test.*'] },
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
    { id: 'cards', label: 'Cards', globs: ['apps/operator/lib/operator-card*.test.ts'] },
    { id: 'suggestions', label: 'Suggestions', globs: ['apps/operator/lib/operator-suggest*.test.ts', 'apps/operator/lib/operator-scan*.test.ts'] },
    { id: 'audit', label: 'Audit', globs: ['apps/operator/lib/operator-audit*.test.ts'] },
    { id: 'persona', label: 'Persona', globs: ['apps/operator/lib/operator-persona*.test.ts', 'apps/operator/lib/operator-prompt*.test.ts'] },
    { id: 'state', label: 'State', globs: ['apps/operator/lib/operator-state*.test.ts', 'apps/operator/lib/operator-trigger*.test.ts'] },
    // Catch-the-rest: every operator-*.test.ts at lib root (converse/scan/etc.
    // are already sectioned above; this surfaces the long tail too).
    { id: 'lib', label: 'Lib', globs: ['apps/operator/lib/operator-*.test.ts'] },
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
    // Catch-the-rest for the design-* lib surface + design-tokens outputs.
    { id: 'lib', label: 'Lib', globs: [
        'apps/operator/lib/design-*.test.ts',
        'apps/operator/lib/design/**/*.test.ts',
        'design-tokens/**/*.test.ts',
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
    { id: 'sse', label: 'SSE', globs: ['libs/generic/sse/**/*.test.ts'] },
    { id: 'ipc', label: 'IPC', globs: [
        'apps/operator/lib/endpoint-ipc/**/*.test.ts',
        'libs/generic/ipc-endpoint-server/**/*.test.ts',
        'libs/generic/ipc-framing/**/*.test.ts',
      ] },
    { id: 'adapters', label: 'Adapters', globs: [
        'libs/generic/desktop-ipc/src/**/*.test.ts',
        'apps/operator/lib/transport-adapters/**/*.test.ts',
      ] },
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
    { id: 'export-state', label: 'Export-state', globs: ['libs/papercusp-export-state/src/**/*.test.ts'] },
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
    // Catch-the-rest for the device-*/mobile-* lib surface.
    { id: 'lib', label: 'Lib', globs: [
        'apps/operator/lib/device-*.test.ts',
        'apps/operator/lib/mobile-*.test.ts',
      ] },
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
    { id: 'network', label: 'Network', globs: ['apps/operator/lib/provision/network*.test.ts'] },
    // Catch-the-rest for everything under the provision/ dir.
    { id: 'lib', label: 'Lib', globs: ['apps/operator/lib/provision/**/*.test.ts'] },
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
      globs: ['apps/operator/lib/sync/hyperbee/**/*.test.ts'],
    },
    {
      id: 'identity-binding',
      label: 'Identity & binding',
      description: 'Device keychain, Ed25519 signing, two-channel binding, attestation.',
      globs: ['apps/operator/lib/identity/**/*.test.ts'],
    },
    {
      id: 'federation',
      label: 'Federation',
      description: 'Join/share, user-branch, binding publish, tree classifier, clone, register.',
      globs: [
        'apps/operator/lib/harness/__tests__/**/*.test.ts',
        'apps/operator/lib/harness/classify-tree.test.ts',
        'apps/operator/lib/harness/clone-github.test.ts',
        'apps/operator/lib/harness/register-papercup.test.ts',
        'apps/operator/lib/harness/papercusp-workspace.test.ts',
        'apps/operator/lib/harness/contributor-row-types.test.ts',
        'apps/operator/lib/harness/contributor-usage-event-types.test.ts',
        'apps/operator/lib/harness/feature-queue-row-types.test.ts',
      ],
    },
    {
      id: 'claim',
      label: 'Claim',
      description: 'Orchestrator distributed/advisory feature claim + audit.',
      globs: ['apps/operator/lib/orchestrator/**/*.test.ts'],
    },
    {
      id: 'pr-lifecycle',
      label: 'PR lifecycle',
      description: 'PrHost, poll daemon + retry, auto-approve/merge, reviewer settings.',
      globs: ['apps/operator/lib/pr-host/**/*.test.ts'],
    },
    {
      id: 'completion-ref',
      label: 'Completion ref',
      description: 'completion_ref writer + background ls-remote verifier.',
      globs: ['apps/operator/lib/harness/completion-ref-*.test.ts'],
    },
    {
      id: 'reactivity',
      label: 'Reactivity',
      description: 'sync-resolver query registry + sync-sse bridge.',
      globs: [
        'apps/operator/lib/sync-resolver/**/*.test.ts',
        'apps/operator/lib/sync-sse.test.ts',
      ],
    },
    {
      id: 'revocation',
      label: 'Revocation',
      description: 'Self-device + contributor revocation, enforcement, re-verify, MCP tools.',
      globs: [
        'apps/operator/lib/sync/hyperbee/__tests__/revoke-*.test.ts',
        'apps/operator/lib/sync/hyperbee/__tests__/revocation-enforcement.test.ts',
        'apps/operator/lib/sync/hyperbee/__tests__/reverify-admitted.test.ts',
        'apps/operator/lib/sync/hyperbee/__tests__/boot-revoke-production-path.test.ts',
        'apps/operator/lib/agent-tools/substrate/**/*.test.ts',
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
        'apps/operator/lib/endpoint-route/routes/admin/__tests__/substrate-*.test.ts',
        'apps/operator/lib/endpoint-route/routes/admin/__tests__/dogfood-substrate-*.test.ts',
        'apps/operator/lib/endpoint-route/routes/harness/__tests__/**/*.test.ts',
        'apps/operator/lib/endpoint-route/routes/users/__tests__/**/*.test.ts',
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
        'apps/operator/lib/gym/**/*.test.ts',
        'apps/operator/lib/gym/**/*.test.tsx',
        'apps/operator/lib/gym-*.test.ts',
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
        'apps/operator/lib/dbos/**/*.test.ts',
        'apps/operator/lib/dbos-*.test.ts',
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
        'apps/operator/lib/workspace-*.test.ts',
        'apps/operator/lib/workspaces-*.test.ts',
        'apps/operator/lib/workspace/**/*.test.ts',
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
        'apps/operator/lib/adv-*.test.ts',
      ] },
    { id: 'vite', label: 'Vite SPA', globs: [
        'apps/operator-vite/src/**/*.test.ts',
        'apps/operator-vite/src/**/*.test.tsx',
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
        'apps/operator/lib/*.test.ts',
        'apps/operator/lib/*.test.tsx',
      ] },
    { id: 'lib-subdirs', label: 'lib (subdirs)', globs: [
        'apps/operator/lib/*/*.test.ts',
        'apps/operator/lib/*/*.test.tsx',
        'apps/operator/lib/*/__tests__/**/*.test.ts',
        'apps/operator/lib/*/__tests__/**/*.test.tsx',
        'apps/operator/lib/endpoint-route/routes/**/*.test.ts',
      ] },
    { id: 'lib-tests', label: 'lib/__tests__', globs: [
        'apps/operator/lib/__tests__/**/*.test.ts',
        'apps/operator/lib/__tests__/**/*.test.tsx',
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

/* ---------------------------------------------------------------- *
 * Composed views (P-011). `papercuspRegistry` = the 20 declared above
 * (read back from the Map by id); `adminRegistry` = universal + papercusp
 * = the full /admin/testing set. The SPA nav order is TestingClient's own
 * TABS, not these arrays.
 * ---------------------------------------------------------------- */

const PAPERCUSP_IDS = [
  'test-runs', 'live', 'chaos', 'ai',
  'memory', 'packaged', 'llm', 'harness', 'voice', 'papercusp-su', 'backup',
  'plans', 'operator', 'design', 'plugins', 'transport', 'snapshots', 'mobile',
  'provisioning', 'docs', 'dogfood',
  // Subsystems + catch-alls added by the test-framework coverage audit.
  'gym', 'dbos', 'workspace', 'adv', 'operator-core', 'libraries',
] as const;

export const papercuspRegistry: TestDomain[] = PAPERCUSP_IDS.map((id) => {
  const d = getTestDomain(id);
  if (!d) throw new Error(`testing-domains-registry: papercusp domain '${id}' not registered`);
  return d;
});

export const adminRegistry: TestDomain[] = [...operatorUniversal, ...papercuspRegistry];
