/**
 * userpromptsubmit-provenance.sh — the HYBRID OWNER-DIRECTIVE CAPTURE RAIL
 * (P-004 of turn-start-memory-two-class-2026-09-21).
 *
 * The clause under test (AUTO-BAR-R-1-P-004): "After a turn the owner typed in
 * a live session, a directive record for that turn is readable in the pending
 * state, and that session performed no directive-recording call." Its stated
 * falsifier is the pre-hybrid world: "Capture depends on the agent choosing to
 * make a call, so a turn the agent ignores leaves no record."
 *
 * So the property that actually has to hold is about the HOOK, not the agent:
 * on an owner turn the hook itself must issue `orders:capture-pending`, with a
 * stable idempotent key, without the session doing anything — and it must NOT
 * do so on a machine-injected turn.
 *
 * The sibling suite (userpromptsubmit-provenance.test.ts) asserts only that the
 * call FAILING is loud, because its harness pins HOME=/nonexistent-home so the
 * bearer is unreadable and capture can never succeed. That is the wrong half of
 * the rail: the assertions there stay green whether or not the hook ever makes
 * the call at all. The one pre-existing "rail is wired" test greps the SOURCE
 * for the tool name, which stays true no matter what the hook does at runtime —
 * it was green throughout a real outage in which the rail captured nothing.
 *
 * This suite closes that gap HERMETICALLY. It stands up a throwaway HTTP stub
 * speaking the same JSON-RPC envelope the local MCP endpoint speaks, points the
 * hook at it with PAPERCUSP_OPERATOR_URL, and gives the hook a temp HOME holding
 * a fake superuser token — so the capture path executes for real and every call
 * it makes is observable. No live operator, no database, no network.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * PROBE_SCRIPT makes the subject path overridable for the mutation probe
 * (CLAUDE.md, "Proving a guard is falsifiable"). Unset — the default, and
 * always so in CI — it resolves the real hook.
 *
 * ⛔ THE SNAPSHOT MUST LIVE IN THE HOOK'S OWN DIRECTORY. The copy-out tier's
 * usual form (mutate a copy in /tmp, point the suite at it) does NOT work here
 * and fails DISHONESTLY. The hook runs `python3 - "$PAPERCUSP_SID"
 * "$(dirname "$0")"` and imports its sibling `mcp_response` module from that
 * directory, so a snapshot anywhere else dies with `ModuleNotFoundError`,
 * exits 0 with EMPTY stdout, and every case in this file then fails inside
 * `contextOf`'s `JSON.parse` — which is indistinguishable from a caught
 * mutant. Measured 2026-09-22: a historical-mode probe scored 12 of 13 cases
 * "failing" against a snapshot that had never executed a line of
 * classification logic. `mutation-probe.sh` caught it only because its
 * CURRENT-source leg failed too and it refused to score
 * (`verdict=harness-error`); a probe without that leg would have recorded a
 * confident false pass.
 *
 * So: either place the snapshot beside the real hook, or use `--in-tree` while
 * holding `locks:acquire` on the hook path (git-sync excludes locked paths).
 */
const SCRIPT =
  process.env.PROBE_SCRIPT ?? resolve(dirname(fileURLToPath(import.meta.url)), '..', 'userpromptsubmit-provenance.sh');
const SID = 'su-capture-rail-test';

type ToolCall = { name: string; args: Record<string, unknown> };

let ledgerDir = '';
let homeDir = '';
let server: Server | undefined;
let baseUrl = '';
let calls: ToolCall[] = [];
/** When set, the stub answers this tool with a rejected result instead of ok. */
let rejectTool: string | null = null;

function sha256Normalized(s: string): string {
  return createHash('sha256').update(s.replace(/\r\n?/g, '\n').trim(), 'utf8').digest('hex');
}

/**
 * The local MCP endpoint's success envelope: a JSON-RPC result whose first text
 * content block carries the tool's own JSON payload. parse_mcp_response treats
 * anything else (isError, no result, non-JSON text) as a failure, which is what
 * the rejection branch below exercises.
 */
function okEnvelope(payload: unknown): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    result: { content: [{ type: 'text', text: JSON.stringify(payload) }] },
  });
}

function rejectedEnvelope(message: string): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    result: { isError: true, content: [{ type: 'text', text: message }] },
  });
}

beforeEach(async () => {
  ledgerDir = mkdtempSync(join(tmpdir(), 'cap-rail-ledger-'));
  homeDir = mkdtempSync(join(tmpdir(), 'cap-rail-home-'));
  mkdirSync(join(homeDir, '.papercusp'), { recursive: true });
  // The hook refuses to call out at all without a readable bearer, so the temp
  // HOME must carry one. Its VALUE is never checked by the stub — only that the
  // hook got far enough to send a request.
  writeFileSync(join(homeDir, '.papercusp', 'superuser-token'), 'test-token-not-a-real-credential\n');
  calls = [];
  rejectTool = null;

  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      let name = '';
      let args: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(body);
        name = String(parsed?.params?.name ?? '');
        args = (parsed?.params?.arguments ?? {}) as Record<string, unknown>;
      } catch {
        /* recorded below as an empty-name call, which fails the assertions loudly */
      }
      calls.push({ name, args });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        rejectTool !== null && name === rejectTool
          ? rejectedEnvelope('refused by the stub')
          : okEnvelope({ ok: true, id: 1, captureStatus: 'pending' }),
      );
    });
  });
  await new Promise<void>((done) => server!.listen(0, '127.0.0.1', done));
  baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
});

afterEach(async () => {
  if (server) await new Promise<void>((done) => server!.close(() => done()));
  server = undefined;
  rmSync(ledgerDir, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
});

function writeMachineRow(over: Record<string, unknown> = {}): void {
  const row = {
    sid: SID,
    nonce: 'aabbccddeeff0011',
    origin: 'wake-pump',
    sha256: sha256Normalized('the injected payload'),
    ts: Date.now(),
    ...over,
  };
  writeFileSync(join(ledgerDir, `${SID}.jsonl`), JSON.stringify(row) + '\n');
}

/**
 * ⚠ ASYNC ON PURPOSE — do NOT "simplify" this back to spawnSync.
 *
 * The stub server lives in THIS process, and spawnSync blocks the event loop for
 * the child's whole lifetime. Under spawnSync the server can never accept the
 * hook's request, so the hook's 1s capture timeout expires, `_mcp_call` returns
 * None, and the suite observes ZERO calls — which reads exactly like "the hook
 * never tried to capture", the very defect this file exists to detect. Measured:
 * with spawnSync every capture assertion failed while the identical hook
 * invocation from a shell recorded `orders:capture-pending` on the first try.
 */
function runHook(payload: unknown): Promise<{ stdout: string; status: number | null }> {
  return new Promise((done, fail) => {
    const child = spawn('bash', [SCRIPT], {
      env: {
        PATH: process.env.PATH ?? '',
        HOME: homeDir,
        PAPERCUSP_OPERATOR_URL: baseUrl,
        PAPERCUSP_TURN_PROVENANCE_DIR: ledgerDir,
        PAPERCUSP_SID: SID,
        // A real egress proxy in the environment must not be consulted for a
        // loopback stub; the hook already builds a proxy-free opener, and clearing
        // these keeps the test honest about what it measured.
        http_proxy: '',
        https_proxy: '',
        no_proxy: '127.0.0.1,localhost',
      },
    });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.on('error', fail);
    child.on('close', (status) => done({ stdout, status }));
    child.stdin.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
  });
}

function contextOf(out: { stdout: string; status: number | null }): string {
  expect(out.status).toBe(0);
  const parsed = JSON.parse(out.stdout);
  expect(parsed.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
  return parsed.hookSpecificOutput.additionalContext as string;
}

function captureCalls(): ToolCall[] {
  return calls.filter((c) => c.name === 'orders:capture-pending');
}

describe('userpromptsubmit-provenance.sh — hybrid owner-directive capture rail', () => {
  it('an OWNER turn makes the hook itself capture the verbatim prompt as pending — the session calls nothing', async () => {
    writeMachineRow();
    const prompt = 'please stop the release and roll back to the previous pin';
    const ctx = contextOf(await runHook({ prompt, session_id: 'native-session-aaa' }));

    // The turn classified OWNER, which is the precondition the clause names.
    expect(ctx).toContain('OWNER (interactive)');

    const captures = captureCalls();
    expect(captures).toHaveLength(1);
    // VERBATIM: the owner's literal words, not a paraphrase or a hash.
    expect(captures[0]!.args.verbatim).toBe(prompt);
    // Keyed on the turn, and carrying the session that produced it.
    expect(captures[0]!.args.sessionRef).toBe('native-session-aaa');
    expect(String(captures[0]!.args.sourceTurnRef ?? '')).toContain('native-session-aaa');

    // The whole point of the hybrid rail: nothing in the session had to ask for
    // this. A successful capture is silent — no notice is appended.
    expect(ctx).not.toContain('OWNER-DIRECTIVE CAPTURE FAILED');
  });

  it('the turn key is STABLE across submissions, so a retry of the same turn is idempotent at the server', async () => {
    writeMachineRow();
    const prompt = 'ship it';
    contextOf(await runHook({ prompt, session_id: 'native-session-bbb' }));
    contextOf(await runHook({ prompt, session_id: 'native-session-bbb' }));

    const captures = captureCalls();
    expect(captures).toHaveLength(2);
    // Idempotency is enforced server-side by a partial unique index on
    // (workspace_id, owner_id, source_turn_ref). That index can only do its job
    // if the hook derives the SAME ref for the same turn, which is what this
    // pins. A ref that embedded a timestamp or a random id would defeat it while
    // every other assertion in this file still passed.
    expect(captures[0]!.args.sourceTurnRef).toBe(captures[1]!.args.sourceTurnRef);
  });

  it('a DIFFERENT owner turn in the same session gets a DIFFERENT key — the key is per-turn, not per-session', async () => {
    writeMachineRow();
    contextOf(await runHook({ prompt: 'first directive', session_id: 'native-session-ccc' }));
    contextOf(await runHook({ prompt: 'second, unrelated directive', session_id: 'native-session-ccc' }));

    const captures = captureCalls();
    expect(captures).toHaveLength(2);
    // CALIBRATION for the test above: without this, a hook that returned one
    // constant ref for everything would satisfy the stability assertion and
    // silently collapse every owner turn in a session into a single record.
    expect(captures[0]!.args.sourceTurnRef).not.toBe(captures[1]!.args.sourceTurnRef);
  });

  /**
   * AUTO-BAR-R-2-P-006: "A turn carrying any verified agent-origin provenance —
   * loop fire, wake pump, self-compaction, fleet kickoff, watchdog or
   * coordination injection — yields no directive record."
   *
   * That clause is UNIVERSAL over the origins it names, so one wake-pump case
   * cannot establish it: capture sits in the hook's final else-branch, and the
   * branch is only reached when classification declines to label the turn
   * machine-generated. A per-origin regression — a new origin string the ledger
   * writes but the classifier does not recognise — would fall straight through
   * to the owner branch and start recording injected turns as owner directives,
   * while a single-origin control stayed green. Each origin is therefore its own
   * case, and the enumeration below is the clause's own list, verbatim.
   */
  const VERIFIED_ORIGINS = [
    'loop-fire',
    'wake-pump',
    'self-compaction',
    'fleet-kickoff',
    'watchdog',
    'coord-inject:coord:inbox-wake',
  ] as const;

  for (const origin of VERIFIED_ORIGINS) {
    it(`CONTROL: a VERIFIED ${origin} turn is classified agent-origin and captures nothing`, async () => {
      const payload = `the injected payload for ${origin}`;
      writeMachineRow({ origin, sha256: sha256Normalized(payload) });
      const ctx = contextOf(
        await runHook({
          prompt: `⟦turn-origin:${origin} nonce:aabbccddeeff0011⟧${payload}`,
          session_id: 'native-session-ddd',
        }),
      );
      // CALIBRATION: without this the case could pass vacuously — a prompt the
      // hook failed to classify at all would also produce zero captures, and the
      // control would read as proof of the branch guard rather than of a miss.
      expect(ctx).toContain('VERIFIED AGENT-ORIGIN');
      // The falsifier this control exists for: capture escaping the owner branch
      // and recording injected turns as if the human had typed them.
      expect(captureCalls()).toHaveLength(0);
    });
  }

  /**
   * The clause (AUTO-BAR-R-2-P-002 / -P-006) names this fixture explicitly: "A
   * carry-respawn turn-0 fixture, stamped owner-typed while its body is the
   * agent's own carry note, is required and must yield no record." The controls
   * above deliver the envelope BARE, and that is not how a carry-respawn turn-0
   * actually arrives — the host wraps the whole continuation in a paste block,
   * so the envelope is no longer at the head of the prompt.
   *
   * That gap was not hypothetical. Owner-directives #170–#181 are twelve
   * machine-injected turns the hook recorded as pending OWNER directives
   * between 2026-09-22T20:30Z and 20:57Z — every one a wrapped carry-respawn or
   * wake prompt, each `captured_by_hook = true`. Classification declined to
   * label them machine-generated, so they fell through to the affirmative owner
   * default and were captured. `unwrap_whole_paste` (landed 20:42Z, committed
   * 619fe9f50f) is the fix; no envelope-carrying capture has been recorded
   * since. This case is what keeps it fixed — the per-origin controls above
   * stayed green throughout that entire window.
   */
  it('a carry-respawn turn-0 arrives PASTE-WRAPPED and is still agent-origin — captures nothing', async () => {
    const carryNote =
      '⟦turn-origin:self-compaction nonce:aabbccddeeff0011⟧' +
      'ADDRESSED TO su-capture-rail-test — continue where you left off; your carry document is in ' +
      'the system prompt. Re-orient, then resume the active plan and its open items.';
    writeMachineRow({ origin: 'self-compaction', sha256: sha256Normalized(carryNote.slice(carryNote.indexOf('⟧') + 1)) });
    const ctx = contextOf(
      await runHook({
        prompt: `<pasted_content id="78f9">\n${carryNote}\n</pasted_content id="78f9">`,
        session_id: 'native-session-fff',
      }),
    );
    // CALIBRATION, as for the per-origin controls: a prompt the hook failed to
    // classify at all would also capture nothing, and would read as proof.
    expect(ctx).toContain('VERIFIED AGENT-ORIGIN');
    expect(ctx).not.toContain('OWNER (interactive)');
    expect(captureCalls()).toHaveLength(0);
  });

  /**
   * The clause's "regardless of how that turn's provenance is stamped" half. The
   * hook's own stated invariant is that an absent or expired ledger row must
   * never yield a MORE authoritative verdict than a live row would have — so an
   * unbacked envelope must not be promoted to the owner default, which is the
   * only branch that captures (and the only one that honours a mode grant).
   */
  it('a paste-wrapped carry-respawn whose ledger row is ABSENT is still not owner — and captures nothing', async () => {
    writeMachineRow({ nonce: 'ffffffffffffffff' }); // a live row, but for a DIFFERENT nonce
    const carryNote =
      '⟦turn-origin:self-compaction nonce:aabbccddeeff0011⟧' +
      'ADDRESSED TO su-capture-rail-test — this continuation was written for that session.';
    const ctx = contextOf(
      await runHook({
        prompt: `<pasted_content id="c854">\n${carryNote}\n</pasted_content id="c854">`,
        session_id: 'native-session-ggg',
      }),
    );
    expect(ctx).toContain('UNVERIFIED ORIGIN CLAIM');
    expect(ctx).not.toContain('OWNER (interactive)');
    expect(captureCalls()).toHaveLength(0);
  });

  it('CONTROL: an empty prompt is a silent no-op and captures nothing', async () => {
    writeMachineRow();
    const out = await runHook({ prompt: '   ', session_id: 'native-session-eee' });
    expect(out.status).toBe(0);
    expect(captureCalls()).toHaveLength(0);
  });

  it('a REJECTED capture is loud in additionalContext and still fail-open', async () => {
    writeMachineRow();
    rejectTool = 'orders:capture-pending';
    const out = await runHook({
      prompt: 'this directive must not vanish quietly',
      session_id: 'native-session-fff',
    });
    const ctx = contextOf(out);

    // The call WAS attempted — this is what separates "the server said no" from
    // "the hook never tried", which the failure notice alone cannot distinguish.
    expect(captureCalls()).toHaveLength(1);
    expect(ctx).toContain('OWNER-DIRECTIVE CAPTURE FAILED');
    // Fail-OPEN: the owner's turn is never blocked and the stamp survives.
    expect(out.status).toBe(0);
    expect(ctx).toContain('OWNER (interactive)');
  });
});
