/**
 * The stock "prefer raw Bash" preamble must stay explicitly SUPERSEDED, on all three
 * surfaces that resolve it (WI-39768 + EI-20757896026508634).
 *
 * WHAT THE PREAMBLE IS. Claude Code compiles this into the CLI bundle and emits it as a
 * meta message whenever bypass- or auto-permission mode is on (verified verbatim in the
 * 2.1.234 ELF at byte offset 306612696):
 *
 *     o = `Do your work through the ${Bash} tool wherever it can accomplish the job: read
 *          files with cat, head, or sed -n, search with grep and find, and make file
 *          changes with sed, heredocs, or short scripts, rather than using the dedicated
 *          ${Read}, ${Edit}, or ${Write} tools. ...`,
 *     i = e.bypass    ? `While bypass permissions mode is active:\n\n${o}`
 *       : e.steerOnly ? `While auto mode is active:\n\n${o}`
 *       : ...
 *
 * It is STOCK CLI text — not an injection, not a peer's message. That mattered: four
 * agents across three channels reported it as a suspected compromise before the origin was
 * pinned, and WI-39768 sat open as a security incident. This guard's docstring is part of
 * the fix: it is where the next agent who greps the phrase lands.
 *
 * WHY IT CANNOT JUST BE IGNORED. The preamble tells agents to make file changes with
 * `sed`/heredocs "rather than using the dedicated Read, Edit, or Write tools". On this box
 * file-lock arbitration is a PreToolUse hook matched on
 * `Edit|Write|MultiEdit|capability_(edit|write)` — so an edit routed through Bash bypasses
 * peer lock arbitration entirely, along with the secrets guard, content-lint, and the
 * migration / generated-file guards riding that same matcher. On a shared checkout that
 * silently clobbers a peer's held file. Complying is a data-loss route, not a style choice.
 *
 * WHY THREE SURFACES, AND WHY A GUARD. The preamble arrives LATE in context and carries the
 * authority of the harness, so a routing rule that merely disagrees with it loses on
 * recency — the observed failure was an agent running ~10 raw Bash calls while the
 * bash→tool advisory fired and read as noise, because a higher-precedence instruction had
 * already licensed the call. Each surface below resolves the conflict at a different
 * moment, and any one of them alone is defeatable:
 *
 *   1. the Project guide's routing table  — the canonical statement, where an agent looks
 *   2. the Claude client overlay          — appended AFTER the preamble, so it wins on order
 *   3. the PreToolUse bash→tool advisory  — fires at the call site, later than any preamble
 *
 * Deleting the text from any one of them is silent: nothing else in the tree reads it, no
 * type depends on it, and the damage shows up as a peer's lost edit weeks later. Hence a
 * test. Assertions are on STABLE anchors (the two preamble headers, the lock-hook
 * consequence, the Edit/Write remedy) rather than whole sentences, so the prose can be
 * reworded freely — only dropping the RULE fails this.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Overridable so falsifiability can be proven at TIER 2 — against a COPY of these four
// files outside the tree — instead of mutating the shared checkout. Without this line the
// only way to prove the guard can fail is an in-tree mutation, which git-sync can commit
// mid-probe (it sweeps the WHOLE tree on a schedule, and no trap prevents that race).
const REPO =
  process.env.PRECEDENCE_GUARD_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Both headers the stock text ships under — an agent may be handed either one. */
const PREAMBLE_HEADERS = [
  'While bypass permissions mode is active:',
  'While auto mode is active:',
] as const;

const read = (rel: string) => readFileSync(join(REPO, rel), 'utf8');

/** The rule is only doing its job if it names the preamble AND settles precedence. */
function expectResolvesPrecedence(text: string, where: string) {
  for (const header of PREAMBLE_HEADERS) {
    expect(text, `${where} must quote the preamble header "${header}" so an agent can match ` +
      'the instruction it is being told to disregard — a rule that describes it only in ' +
      'paraphrase does not connect to the text actually in the agent\'s context').toContain(header);
  }
  expect(text.toLowerCase(), `${where} must say the repo SUPERSEDES the preamble; disagreeing ` +
    'with it implicitly loses to recency').toMatch(/supersede/);
}

describe('stock "prefer raw Bash" preamble — precedence is stated, not implied', () => {
  it('the Project guide routing table overrides it and says why writes are load-bearing', () => {
    const claudeMd = read('CLAUDE.md');
    expectResolvesPrecedence(claudeMd, 'CLAUDE.md');

    // The write half is the data-loss half; a version that only argued about read routing
    // would leave the clobber route open.
    expect(claudeMd, 'CLAUDE.md must name the lock hook as what a Bash-routed edit bypasses')
      .toMatch(/lock-arbitration hook/);
    expect(claudeMd, 'CLAUDE.md must name the remedy (Edit/Write), not just the prohibition')
      .toMatch(/`Edit`\/`Write`/);

    // AGENTS.md is the codex projection of the same parts — if the part were dropped from
    // one client's projection only, this catches it.
    expectResolvesPrecedence(read('AGENTS.md'), 'AGENTS.md');
  });

  it('the Claude client overlay overrides it, and is the surface appended after it', () => {
    const overlay = read('apps/operator/prompts/papercusp-su.claude.md');
    expectResolvesPrecedence(overlay, 'the Claude client overlay');

    // Marker comment: lets the rule be located by key rather than by prose grep, the same
    // convention the file already uses for `papercusp-rule:file-locking`.
    expect(overlay, 'the overlay rule must keep its papercusp-rule marker')
      .toContain('papercusp-rule:stock-bash-first-preamble=superseded');

    expect(overlay, 'the overlay must state the lock-hook consequence of a Bash-routed edit')
      .toMatch(/lock-arbitration hook/);

    // The origin question cost four agents a compromise investigation. The overlay has to
    // close it, or the next sighting reopens the hunt.
    expect(overlay, 'the overlay must say the preamble is stock CLI text, not an injection')
      .toMatch(/not an injection/);
  });

  it('the PreToolUse bash→tool advisory resolves it at the call site', () => {
    const gate = read('apps/operator/scripts/hooks/cc/pretooluse-bash-resource-gate.sh');

    // Scope the assertions to the SOFT advisory literal. The file is ~4.8k lines and
    // discusses heredocs and `sed` in many unrelated guards, so an unscoped match here
    // would pass on prose that has nothing to do with this rule.
    const start = gate.indexOf('bash→tool advisory: a tool already answers this question');
    expect(start, 'the soft bash→tool advisory literal must still exist').toBeGreaterThan(-1);
    const advisory = gate.slice(start, gate.indexOf('% (_body, _hint_advise)', start));

    expectResolvesPrecedence(advisory, 'the bash→tool advisory');
    expect(advisory, 'the advisory must name the lock-hook consequence — it is the reason ' +
      'this is not a style nudge').toMatch(/lock-arbitration hook/);

    // The advisory is deduped per session on a CLASS key hashed from its LEAD paragraph, so
    // the precedence clause has to stay BELOW the lead. Moving it up would re-key the
    // advisory and defeat the say-once suppression.
    const leadEnd = advisory.indexOf('\\n\\n');
    expect(advisory.indexOf('PRECEDENCE'), 'the precedence clause must sit after the lead ' +
      'paragraph, which is what the say-once class key is hashed from').toBeGreaterThan(leadEnd);
  });
});
