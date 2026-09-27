/**
 * Integration-layer recurrence guard for WI-10003538 (native-cutover R-3,
 * AUTO-BAR-R-3-P-002): "credentials stay redacted / access-controlled".
 *
 * The defect: capability:bash redacted only the EXACT values of operator-bound
 * credentials, so a secret-SHAPED token nobody bound (a GitHub PAT, an AWS key
 * id, an Anthropic key printed by the command itself) reached agent context
 * AND a group-readable (0664) spill log. An independent grader observed it
 * through the MCP surface (EI-24445491986370200).
 *
 * This crosses the real capability handler → durable bash-job registry → later
 * bash_output handler boundary, for BOTH the foreground path and the
 * start-once yielded-job path, and reads the real on-disk spill log. The fake
 * tokens are assembled inside the shell at runtime so no secret-shaped literal
 * is ever written to this file, and the oracle is those literal strings plus the
 * literal 0o600 mode — independent of the redactor under test.
 *
 * The sandbox is off for the same reason as bash-start-once-yield: sandbox
 * correctness has its own real-wrapper suite; this test owns the output sinks.
 */
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./exec-sandbox', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./exec-sandbox')>()),
  capabilityExecSandboxPolicy: vi.fn(async () => ({
    enabled: false,
    required: false,
    profile: { kind: 'trusted', reason: 'secret-redaction-integration' },
  })),
}));

import bashTool from './bash';
import bashOutputTool from './bash_output';
import { __resetBashJobs } from './bash-jobs';

type Result = { content: Array<{ text: string }> };
type Tool = { handler: (args: unknown, ctx: unknown) => Promise<Result> };
const bash = bashTool as unknown as Tool;
const bashOutput = bashOutputTool as unknown as Tool;
const STATE = mkdtempSync(join(tmpdir(), 'cap-bash-redaction-integration-'));

// The shapes, rebuilt in JS only to assert ABSENCE. Split so this source file
// never contains a contiguous secret-shaped literal.
const FAKES = [
  'gh' + 'p_' + 'Q'.repeat(36),
  'AK' + 'IA' + 'Z'.repeat(16),
  'sk' + '-ant-' + 'x'.repeat(40),
];

// Build the same three tokens inside the shell and print them. `raw_lengths`
// proves the command really produced full-length tokens (a truncated token would
// make "not redacted" vacuous).
const SHAPE_COMMAND =
  `A=gh; B=p_; T1="$A$B$(printf 'Q%.0s' $(seq 36))"; ` +
  `T2="AK""IA$(printf 'Z%.0s' $(seq 16))"; ` +
  `T3="sk""-ant-$(printf 'x%.0s' $(seq 40))"; ` +
  `printf 'gh=%s aws=%s ant=%s\\n' "$T1" "$T2" "$T3"; ` +
  `echo "raw_lengths \${#T1} \${#T2} \${#T3}"`;

function ctx() {
  return {
    projectDir: STATE,
    stateDir: STATE,
    workspaceId: 'papercusp-workspace',
    harnessSlug: 'papercusp',
    signal: new AbortController().signal,
    emit: () => {},
    role: 'operator',
  } as never;
}

function payload(result: Result): Record<string, unknown> {
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

function expectRedacted(surface: string, where: string): void {
  expect(surface, `${where}: the command must have run`).toContain('raw_lengths 40 20 47');
  for (const fake of FAKES) expect(surface, `${where} leaked a secret shape`).not.toContain(fake);
}

function expectPrivateSpill(logPath: unknown): string {
  expect(typeof logPath, 'result must name its spill log').toBe('string');
  const path = String(logPath);
  expect(statSync(path).mode & 0o777, 'spill log must be owner-only').toBe(0o600);
  const spill = readFileSync(path, 'utf8');
  expectRedacted(spill, 'spill log');
  return spill;
}

afterEach(() => __resetBashJobs());

describe('capability:bash secret-shape redaction — integration (WI-10003538)', () => {
  it('foreground: unbound secret shapes never reach the tool result or the spill log; spill is 0600', async () => {
    // A completed foreground run returns the agent-facing TEXT form
    // (`exit 0 · … · full output → <spill path>` then the output) — exactly
    // what reaches context, so assert on that text, not a parsed shape.
    const text = (await bash.handler({ command: SHAPE_COMMAND, timeout: 10_000 }, ctx())).content
      .map((part) => part.text)
      .join('\n');

    expect(text).toMatch(/^exit 0\b/);
    expectRedacted(text, 'foreground tool result');
    expectPrivateSpill(/full output → (\S+)/.exec(text)?.[1]);
  });

  it('yielded job: unbound secret shapes never reach launch, bash_output, or the spill log; spill is 0600', async () => {
    const launch = payload(
      await bash.handler(
        { command: `sleep 0.3; ${SHAPE_COMMAND}`, timeout: 10_000, yield_after_ms: 25 },
        ctx(),
      ),
    );
    expect(launch).toMatchObject({ status: 'running', yielded: true });
    const bashId = String(launch.bash_id);
    const taskId = String(launch.task_id);

    let seen = JSON.stringify(launch);
    let terminal: Record<string, unknown> | null = null;
    for (let attempt = 0; attempt < 250 && !terminal; attempt += 1) {
      const next = payload(await bashOutput.handler({ task_id: taskId, bash_id: bashId }, ctx()));
      seen += JSON.stringify(next);
      if (next.status !== 'running') terminal = next;
      else await new Promise((resolve) => setTimeout(resolve, 20));
    }

    expect(terminal).toMatchObject({ status: 'completed', exit_code: 0 });
    expectRedacted(seen, 'launch + bash_output results');
    expectPrivateSpill(launch.log_path);
  });
});
