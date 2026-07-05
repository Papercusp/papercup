/**
 * `role-config` — the single runtime source of truth for Papercusp's built-in
 * agent role ids (plan P-010 / D-005). `AGENT_ROLES` feeds tool `roles:`
 * allowlists, `rolesQuota` keys, and `byRole` guidance overrides, and the
 * type-level `RoleRegistry` augmentation is *derived* from it — so a drift here
 * silently widens or narrows `AgentRole` program-wide. These tests pin the set's
 * invariants (the pipeline spine, the chat + cross-cutting roles, no dupes, the
 * deliberately-CUT roles staying gone).
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { AGENT_ROLES, OPERATOR_CONFIG_WRITE_ROLES, isOperatorConfigWriteRole, SU_ROLES } from './role-config.js';

test('AGENT_ROLES contains the coding pipeline spine in order (scoper → curator)', () => {
  // The seven-stage spine plus the read-only debugger gate, as the `coding`
  // blueprint dispatches them. Asserted as a contiguous ordered slice so a
  // reordering or a dropped stage trips here.
  const pipeline = ['scoper', 'architect', 'worker', 'validator', 'reviewer', 'debugger', 'documenter', 'curator'];
  const idx = pipeline.map((r) => AGENT_ROLES.indexOf(r));
  for (let i = 0; i < pipeline.length; i++) {
    assert.ok(idx[i] >= 0, `pipeline role "${pipeline[i]}" missing from AGENT_ROLES`);
  }
  // strictly increasing → the relative order is preserved
  for (let i = 1; i < idx.length; i++) {
    assert.ok(idx[i] > idx[i - 1], `pipeline order broken at "${pipeline[i]}"`);
  }
});

test('AGENT_ROLES includes the two chat-surface roles', () => {
  for (const role of ['operator', 'oracle']) {
    assert.ok(AGENT_ROLES.includes(role as (typeof AGENT_ROLES)[number]), `missing chat role "${role}"`);
  }
});

test('AGENT_ROLES includes the built-in cross-cutting roles', () => {
  // The coordinator + the roles spawned by system actions / gates that appear in
  // tool `roles:` allowlists.
  for (const role of [
    'orchestrator',
    'promote',
    'security-reviewer',
    'infra-reviewer',
    'crosscheck',
    'ui-qa',
    'auditor',
    'merge-resolver',
    'release-manager',
  ]) {
    assert.ok(AGENT_ROLES.includes(role as (typeof AGENT_ROLES)[number]), `missing cross-cutting role "${role}"`);
  }
});

test('AGENT_ROLES has no duplicate ids', () => {
  assert.equal(new Set(AGENT_ROLES).size, AGENT_ROLES.length);
});

test('every role id is a non-empty kebab/lower token (valid in a tool roles: allowlist)', () => {
  for (const role of AGENT_ROLES) {
    assert.match(role, /^[a-z][a-z0-9-]*$/, `role id "${role}" is not a kebab/lower token`);
  }
});

test('OPERATOR_CONFIG_WRITE_ROLES is the operator-equivalent write set incl. queen (EI-2204)', () => {
  // The in-handler write-gate for operator-config-mutating tools (rate_limit_config,
  // preferences, reset-overrides, migrate-policy, set-watchdog-tunables, routines:set).
  // queen is the operator SPECIALIZED (local-hive D-001) — she MUST be here, or she can
  // invoke those tools but their `set` rejects her (the EI-2204 regression). operator +
  // architect are the historical writers and must remain.
  for (const role of ['operator', 'architect', 'mug']) {
    assert.ok(
      OPERATOR_CONFIG_WRITE_ROLES.includes(role as (typeof OPERATOR_CONFIG_WRITE_ROLES)[number]),
      `operator-config write role "${role}" missing — its tools' set op would reject it`,
    );
  }
  // It is a SUBSET of the broad invoke allowlist those tools advertise ([...SU_ROLES]) —
  // a write role the dispatch layer would never admit makes no sense.
  for (const role of OPERATOR_CONFIG_WRITE_ROLES) {
    assert.ok((SU_ROLES as readonly string[]).includes(role), `write role "${role}" not in SU_ROLES`);
  }
});

test('isOperatorConfigWriteRole — queen/operator/architect pass, other roles + unknown fail', () => {
  for (const role of ['operator', 'architect', 'mug']) {
    assert.equal(isOperatorConfigWriteRole(role), true, `${role} should have operator-config write authority`);
  }
  // Read-only / non-operator-equivalent SU roles, plugin-namespaced, and absent roles fail-closed.
  for (const role of ['worker', 'scoper', 'validator', 'reviewer', 'documenter', 'curator', 'cup', 'plugin:role']) {
    assert.equal(isOperatorConfigWriteRole(role), false, `${role} must NOT have operator-config write authority`);
  }
  assert.equal(isOperatorConfigWriteRole(undefined), false);
  assert.equal(isOperatorConfigWriteRole(null), false);
});

test('the deliberately-CUT roles stay out of the set (dbos-system-completion P-015, D-020)', () => {
  // `summarizer` (dead role) + `project_manager` (retired PM-dispatch feature)
  // were removed; this guards against an accidental re-introduction.
  for (const cut of ['summarizer', 'project_manager']) {
    assert.ok(!AGENT_ROLES.includes(cut as (typeof AGENT_ROLES)[number]), `CUT role "${cut}" reappeared`);
  }
});
