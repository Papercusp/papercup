/**
 * Fixture helper for behavioral smoke tests.
 *
 * Creates known-state artifacts under ~/.papercusp/harnesses/smoke-fixture/
 * that the operator can ONLY discover via tool calls — not from the
 * pre-injected workspace inventory block.
 *
 * Usage in tests:
 *   import { FIXTURE_INFO, setupFixture, cleanupFixture } from './behavioral-smoke-fixture';
 *   beforeAll(setupFixture);
 *   afterAll(cleanupFixture);
 */

import { writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const FIXTURE_SLUG = 'smoke-fixture';
export const ESCALATION_MARKER = 'SPRINKLEPOTAMUS';
export const SUPERVISOR_MARKER = 'ZUCCHINI-MOON-42';

export const FIXTURE_INFO = {
  slug: FIXTURE_SLUG,
  escalationMarker: ESCALATION_MARKER,
  supervisorMarker: SUPERVISOR_MARKER,
} as const;

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

function resolveFixtureDir(): string {
  const root =
    process.env.PAPERCUSP_ROOT ??
    process.env.PAPERCUSP_WS_ROOT ??
    join(homedir(), '.papercusp');
  return join(root, 'harnesses', FIXTURE_SLUG);
}

export async function setupFixture(): Promise<void> {
  const dir = resolveFixtureDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'escalation.md'), ESCALATION_BODY, 'utf8');
  writeFileSync(join(dir, 'supervisor-notes.md'), SUPERVISOR_BODY, 'utf8');
  const harnessJson = join(dir, 'harness.json');
  if (!existsSync(harnessJson)) {
    writeFileSync(
      harnessJson,
      JSON.stringify({ slug: FIXTURE_SLUG, title: 'Smoke-test fixture', created_at: Date.now(), fixture: true }, null, 2),
    );
  }
}

export function cleanupFixture(): void {
  const dir = resolveFixtureDir();
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}
