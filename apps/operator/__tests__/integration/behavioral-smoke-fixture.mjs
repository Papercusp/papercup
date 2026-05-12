#!/usr/bin/env node
/**
 * Fixture harness for behavioral smoke tests.
 *
 * Creates known-state artifacts that ONLY tool calls can reveal,
 * making tool-call frequency a reliable signal again. Without this,
 * the workspace-inventory pre-injected into the system prompt lets
 * the brain answer common questions WITHOUT calling tools.
 *
 * What we fixture:
 *   - A test harness slug ("smoke-fixture") created via POST /api/harness
 *     IF it doesn't already exist.
 *   - An escalation.md with a marker word ("SPRINKLEPOTAMUS") inside.
 *     The marker is intentionally absurd so an LLM can't bullshit it
 *     from priors — it can only know the word if it called
 *     harness:escalation { slug: 'smoke-fixture' } and saw the file
 *     contents.
 *   - A supervisor-notes.md with a different marker ("ZUCCHINI-MOON-42").
 *
 * Idempotent: re-running this script overwrites the fixture files
 * with the same content + leaves the harness row alone.
 *
 * Known limitation (2026-05-11): writing files alone doesn't make the
 * harness discoverable to `/api/harness/projects`. The project
 * resolver requires registry entries the operator stores in PG. To
 * fully wire the fixture into the operator's view, run the
 * canonical harness-create flow (papercusp CLI or POST to the harness
 * registration route) BEFORE running this script. The escalation +
 * supervisor-notes still get read by `harness:escalation` if the
 * project resolver finds the harness via any other path.
 *
 * Workflow:
 *   1. Create smoke-fixture harness via your canonical flow ONCE.
 *   2. Run `node behavioral-smoke-fixture.mjs setup` to write/refresh
 *      the fixture files.
 *   3. Run `node behavioral-smoke.mjs` to execute the smoke suite.
 *   4. Run `node behavioral-smoke-fixture.mjs cleanup` to reset.
 *
 * Usage:
 *   node behavioral-smoke-fixture.mjs setup    → creates fixture
 *   node behavioral-smoke-fixture.mjs cleanup  → removes fixture
 *   node behavioral-smoke-fixture.mjs status   → reports current state
 */

import { writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const OP_PORT = process.env.OP_PORT ?? '3055';
const BASE = `http://localhost:${OP_PORT}`;
const FIXTURE_SLUG = 'smoke-fixture';
const ESCALATION_MARKER = 'SPRINKLEPOTAMUS';
const SUPERVISOR_MARKER = 'ZUCCHINI-MOON-42';

const ESCALATION_BODY = `# Smoke-test fixture escalation

This harness is a behavioral-smoke-test fixture. The unique marker word
in this paragraph is **${ESCALATION_MARKER}** — that string never appears
in any real harness and never appears in the operator's pre-injected
workspace inventory. If a test prompt asks the operator to report this
word, the operator can only know it by calling \`harness:escalation\`
with slug \`${FIXTURE_SLUG}\`.

Filed: 2026-05-11.
`;

const SUPERVISOR_BODY = `# Supervisor notes for ${FIXTURE_SLUG}

Marker: **${SUPERVISOR_MARKER}**.

This file proves harness:escalation's supervisorNotes field reaches the
LLM. The marker word is unique to this fixture.
`;

function resolveFixtureDir() {
  // The Papercusp workspace root is typically ~/.papercusp, but
  // PAPERCUSP_ROOT can override. The harness directory layout is
  // <root>/harnesses/<slug>/.
  const root = process.env.PAPERCUSP_ROOT
    ?? process.env.PAPERCUSP_WS_ROOT
    ?? join(homedir(), '.papercusp');
  return join(root, 'harnesses', FIXTURE_SLUG);
}

async function harnessExists() {
  try {
    const r = await fetch(`${BASE}/api/harness/projects`);
    if (!r.ok) return false;
    const d = await r.json();
    return (d?.projects ?? []).some((p) => p.slug === FIXTURE_SLUG);
  } catch {
    return false;
  }
}

async function setup() {
  console.log(`[fixture] setting up ${FIXTURE_SLUG}…`);
  const dir = resolveFixtureDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    console.log(`[fixture] created ${dir}`);
  } else {
    console.log(`[fixture] ${dir} already exists`);
  }

  writeFileSync(join(dir, 'escalation.md'), ESCALATION_BODY, 'utf8');
  writeFileSync(join(dir, 'supervisor-notes.md'), SUPERVISOR_BODY, 'utf8');
  console.log(`[fixture] wrote escalation.md (marker=${ESCALATION_MARKER})`);
  console.log(`[fixture] wrote supervisor-notes.md (marker=${SUPERVISOR_MARKER})`);

  // Touch a minimal harness.json so the project resolver finds it.
  const harnessJson = join(dir, 'harness.json');
  if (!existsSync(harnessJson)) {
    writeFileSync(harnessJson, JSON.stringify({
      slug: FIXTURE_SLUG,
      title: 'Smoke-test fixture',
      created_at: Date.now(),
      fixture: true,
    }, null, 2));
    console.log(`[fixture] wrote harness.json`);
  }

  const exists = await harnessExists();
  console.log(`[fixture] visible in operator project list: ${exists}`);
  console.log(`[fixture] done`);
}

function cleanup() {
  const dir = resolveFixtureDir();
  if (!existsSync(dir)) {
    console.log(`[fixture] ${dir} does not exist, nothing to clean`);
    return;
  }
  rmSync(dir, { recursive: true, force: true });
  console.log(`[fixture] removed ${dir}`);
}

async function status() {
  const dir = resolveFixtureDir();
  console.log(`fixture dir: ${dir}`);
  console.log(`  exists: ${existsSync(dir)}`);
  console.log(`  escalation.md: ${existsSync(join(dir, 'escalation.md'))}`);
  console.log(`  supervisor-notes.md: ${existsSync(join(dir, 'supervisor-notes.md'))}`);
  console.log(`  visible to operator: ${await harnessExists()}`);
}

export const FIXTURE_INFO = {
  slug: FIXTURE_SLUG,
  escalationMarker: ESCALATION_MARKER,
  supervisorMarker: SUPERVISOR_MARKER,
};

const cmd = process.argv[2] ?? 'status';
if (import.meta.url === `file://${process.argv[1]}`) {
  if (cmd === 'setup') await setup();
  else if (cmd === 'cleanup') cleanup();
  else if (cmd === 'status') await status();
  else { console.error(`unknown command: ${cmd}`); process.exit(2); }
}
