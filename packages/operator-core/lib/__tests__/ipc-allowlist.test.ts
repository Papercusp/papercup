/**
 * Guard for the IPC direct-dispatch allowlist — the set of tools declaring
 * `expose: { ipc: true }`.
 *
 * THE CONTRACT (host-bootstrap.ts builds the IPC server's allowlist from this):
 * a tool is IPC-eligible ONLY if it is SELF-CONTAINED — every auth/session,
 * budget/cost-cap, and persistence side-effect lives in the HANDLER, not the
 * HTTP route — because direct dispatch (`endpoint_invoke`) bypasses the route
 * entirely. Marking a route-dependent tool eligible silently breaks it the
 * moment IPC is on (the footgun closed for `oracle:chat` + `agent_chats:chat`,
 * whose routes own session/cost/persistence).
 *
 * This test locks the justified set + the footgun exclusions so neither drifts
 * by accident. To CHANGE the eligible set you must edit BOTH the tool's
 * `expose` and the list below — which forces a reviewer to weigh the
 * self-containment claim. Source-text parsed (not a runtime registry load) to
 * mirror tools-md-sync.test.ts and stay dependency-light.
 *
 * Plan: calltool-endpoint-seam-2026-06-01 (Phase D/E) + the expose.ipc footgun
 * closed in desktop-ipc-transport-completion-2026-05-20.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
// The agent-tools tree moved here in the SP1 C4 carve (2026-06-04); was
// apps/operator/lib/agent-tools (which no longer exists → ENOENT walk).
const TOOLS_DIR = join(REPO, 'packages/operator-core/lib/agent-tools');

/** Self-contained tools deliberately eligible for direct dispatch. Each entry
 *  carries WHY — every one owns its full lifecycle in the handler. */
const EXPECTED_IPC_ELIGIBLE = new Set<string>([
  'dev:ipc_echo', // pure echo test tool — no deps at all
  // (operator:scan removed with the scanner teardown — unify-agent-launches D-005)
  'operator:converse', // self-contained: prompt+budget+spend+mem0 in the handler
  'operator:delegate', // self-contained since the IPC-allowlist migration (2026-05-12)
  'architect:chat', // self-contained since the IPC-allowlist migration (2026-05-12)
  'brainstorm:chat', // self-contained since the IPC-allowlist migration (2026-05-12)
]);

/** Route-dependent tools that must NEVER be IPC-eligible (the closed footgun). */
const MUST_NOT_BE_ELIGIBLE = ['oracle:chat', 'agent_chats:chat'];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

/** Tool names whose `defineTool({...})` block declares `expose: { ipc: true }`. */
function ipcEligibleFromSource(): Set<string> {
  const eligible = new Set<string>();
  for (const file of walk(TOOLS_DIR)) {
    const src = readFileSync(file, 'utf8');
    // Each defineTool(...) call becomes one block (from this call to the next).
    for (const block of src.split(/defineTool\s*\(/).slice(1)) {
      if (!/\bipc:\s*true\b/.test(block)) continue;
      const m = block.match(/name:\s*['"]([^'"]+)['"]/); // first name = the tool id
      if (m) eligible.add(m[1]!);
    }
  }
  return eligible;
}

describe('IPC direct-dispatch allowlist (expose:{ipc:true})', () => {
  const eligible = ipcEligibleFromSource();

  it('matches the justified self-contained set (change both expose + this list, with justification)', () => {
    expect([...eligible].sort()).toEqual([...EXPECTED_IPC_ELIGIBLE].sort());
  });

  it('never includes a route-dependent tool (the closed footgun)', () => {
    for (const name of MUST_NOT_BE_ELIGIBLE) {
      expect(eligible.has(name)).toBe(false);
    }
  });
});
