/**
 * structured-body-gate-completeness.test.ts — D-104: the structured-body gate is
 * APPLIED everywhere it should be, and its refusal stays actionable.
 *
 * Plan: unified-agent-state-plane-2026-07-27, ruling **D-104** (owner directive
 * 2026-07-28, interactive: *"WE SHOULD NOT ALLOW JUST A STRING I WANT TO ENFORCE
 * THE STRUCTURE THAT IS THE WHOLE POINT OF IT"*).
 *
 * ⚠ WHY THIS FILE EXISTS — the gap it closes is the one this plan already paid
 * for once. `send.test.ts` proves the gate BEHAVES: a string body is refused, a
 * sectioned one is accepted. Nothing proved the gate is REACHED from every
 * surface that takes a message body. That is the identical shape as WI-6444 on
 * this same plan, where `unknownHoist` was declared on all six nullable cells AND
 * enforced at registration while being read by NOTHING — both halves green, the
 * property still absent end-to-end. The lesson recorded there is explicit:
 * *"nothing tested REACHABILITY from a declaration to the read path."* A gate
 * that one tool applies is not a gate; it is a convention, and D-016 already
 * names what happens to a rule that can be satisfied by not participating.
 *
 * ⚠ WHAT THIS DELIBERATELY DOES NOT DECIDE. Whether `coord:escalate` /
 * `coord:handoff` / `coord:emit` / `coord:promote` / `coord:message-agent` SHOULD
 * carry sectioned bodies is a plan-level ruling, not a thing a test may settle by
 * quietly asserting it. They ride DIFFERENT envelopes (message-agent opens a
 * conversation — `openConversation`, kind 'discussion'; the others append their
 * own escalation/handoff/event envelope, not the directed `messages` envelope
 * D-104 governs). So they are listed below as ACKNOWLEDGED-UNGATED with a reason
 * each, and the test's actual job is narrower and more useful: a body-taking
 * coord tool that is in NEITHER list fails, so a new one cannot ship having
 * silently skipped the gate. Changing a verdict here is a one-line edit next to
 * the reason it overturns — which is the point.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

/** Strip comments so a structural scan reads CODE, not prose about code. */
const codeOnly = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

/** `agent-tools/coordination/tools` — where the agent-callable coord tools live. */
const TOOLS_DIR = fileURLToPath(new URL('./tools/', import.meta.url));

/**
 * A zod `body:` argument declaration inside a tool's args SCHEMA.
 *
 * Anchored to a schema-shaped right-hand side (`z.…` or `messageBodyArg`) on
 * purpose: a bare `body:\s*\S+` also matches ordinary handler code that happens
 * to forward a body (`body: msg.body,` in send.ts, `body: args.note` elsewhere),
 * which reports a tool as unclassified because of a line that declares nothing.
 * Verified against the tree: the loose form produced 7 hits, 6 of them false.
 */
const BODY_ARG = /^\s*body:\s*((?:z\.|messageBodyArg)[^\n]*)$/gm;

/**
 * Tools whose `body` MUST flow through `messageBodyArg` — the directed-message
 * surface D-104 governs. A file here that stops using the gate reds.
 */
const GATED = ['send.ts'] as const;

/**
 * Tools that take a `body` but ride a DIFFERENT envelope. Each carries the reason
 * it is out of scope, so overturning one is an edit next to its justification
 * rather than a silent deletion. These are NOT assertions that a plain string is
 * the right long-term shape for them — only that D-104 did not rule on them.
 */
const ACKNOWLEDGED_UNGATED: Record<string, string> = {
  'escalate.ts': 'escalation envelope to a human, not a directed agent message — D-104 did not rule on it',
  'handoff.ts': 'handoff envelope (transfers WORK, not a message) — D-104 did not rule on it',
  'emit.ts': 'event envelope on the coord event surface — D-104 did not rule on it',
  'promote.ts': 'promotion envelope — D-104 did not rule on it',
  'message-agent.ts':
    "opens a CONVERSATION (openConversation, kind 'discussion'), a different substrate from the " +
    'directed `messages` envelope; its own notWhen routes one-off notes to coord:send',
};

function discoverBodyTakingTools(): Array<readonly [string, string]> {
  const out: Array<readonly [string, string]> = [];
  for (const name of readdirSync(TOOLS_DIR, { encoding: 'utf8' })) {
    if (!name.endsWith('.ts') || name.endsWith('.d.ts')) continue;
    if (name.includes('.test.')) continue;
    let text: string;
    try {
      text = codeOnly(readFileSync(join(TOOLS_DIR, name), 'utf8'));
    } catch {
      continue;
    }
    BODY_ARG.lastIndex = 0;
    if (BODY_ARG.test(text)) out.push([name, text] as const);
  }
  return out;
}

const bodyTools = discoverBodyTakingTools();

describe('D-104 — the structured-body gate is applied across the coord tool surface', () => {
  it('is non-vacuous: the scan read real tool code and found the body-taking tools', () => {
    // The corpus floor. A predicate that stops matching (a rename, a refactor of
    // the args schema into a helper) would empty this list and turn every
    // assertion below into a green no-op — the exact failure mode the sibling
    // suite message-sender-completeness.test.ts guards for its own scan.
    expect(bodyTools.length).toBeGreaterThanOrEqual(GATED.length + Object.keys(ACKNOWLEDGED_UNGATED).length);
    for (const [name, text] of bodyTools) {
      expect(text.length, `${name} scanned as empty`).toBeGreaterThan(200);
    }
    expect(bodyTools.map(([n]) => n)).toContain('send.ts');
  });

  it('every body-taking coord tool is CLASSIFIED — a new one cannot skip the gate silently', () => {
    const unclassified = bodyTools
      .map(([n]) => n)
      .filter((n) => !GATED.includes(n as never) && !(n in ACKNOWLEDGED_UNGATED));
    expect(
      unclassified,
      'a coord tool takes a `body` but is in NEITHER the GATED list nor ACKNOWLEDGED_UNGATED. ' +
        'Decide which it is: route it through `messageBodyArg` (D-104) or add it to ' +
        'ACKNOWLEDGED_UNGATED with the reason its envelope is out of scope. This is the ' +
        '"reachability was never tested" failure WI-6444 on this plan already cost us once.',
    ).toEqual([]);
  });

  it('every GATED tool actually routes `body` through messageBodyArg', () => {
    for (const file of GATED) {
      const entry = bodyTools.find(([n]) => n === file);
      expect(entry, `${file} no longer declares a body arg — the pin went stale`).toBeDefined();
      const text = entry![1];
      BODY_ARG.lastIndex = 0;
      const decls = [...text.matchAll(BODY_ARG)].map((m) => m[1]);
      expect(decls.length, `${file} declares no body arg`).toBeGreaterThan(0);
      for (const decl of decls) {
        expect(
          decl,
          `${file} declares \`body: ${decl}\` — a GATED tool must use messageBodyArg so the ` +
            'D-104 refusal applies. Both axes (the shorthand and items[]) must carry it; gating ' +
            'only one moves the traffic to the ungated one rather than closing the hole.',
        ).toContain('messageBodyArg');
      }
    }
  });

  it('every ACKNOWLEDGED_UNGATED pin still names a real body-taking tool — it cannot go stale', () => {
    const found = bodyTools.map(([n]) => n);
    for (const name of Object.keys(ACKNOWLEDGED_UNGATED)) {
      expect(
        found,
        `${name} is pinned as acknowledged-ungated but no longer declares a body arg — remove the pin`,
      ).toContain(name);
    }
  });
});

describe('D-104 — the refusal stays ACTIONABLE, not merely correct', () => {
  const fieldsSrc = codeOnly(
    readFileSync(fileURLToPath(new URL('./message-fields.ts', import.meta.url)), 'utf8'),
  );

  it('messageBodyArg KEEPS z.string() in its union so the refusal can teach', () => {
    // The union looks like dead weight and is the obvious "cleanup": drop
    // z.string() and let z.array() reject the string. That silently downgrades
    // the refusal to zod's "expected array, received string", which tells an
    // agent what it did wrong but not what to do instead — and the whole reason
    // the gate is a tier-2 mechanism rather than prompt guidance (D-016) is that
    // the message has to carry the fix. Nothing else pins this; without it the
    // regression is invisible because the gate still REFUSES, just uselessly.
    // NB: the declaration wraps as `= z\n  .union([...])`, so the `z` and the
    // `.union(` are separated by a newline — a `z\.union\(` pattern misses it.
    const union = /messageBodyArg[\s\S]{0,120}?\.union\(\s*\[\s*z\.string\(\)/;
    expect(
      union.test(fieldsSrc),
      'messageBodyArg no longer accepts z.string() in its union. It is there ON PURPOSE — to CATCH ' +
        'the string and refuse it with a message that teaches the shape. Removing it makes zod emit ' +
        '"expected array, received string" instead, which is a correct refusal that helps nobody.',
    ).toBe(true);
  });

  it('the refusal names the exact minimum shape an agent should write', () => {
    // Pinned as a SHAPE the caller can paste, not a sentiment. If this snippet
    // drifts out of the message, the refusal has stopped being a fix and gone
    // back to being a complaint.
    expect(fieldsSrc).toContain('body: [{ text:');
  });
});
