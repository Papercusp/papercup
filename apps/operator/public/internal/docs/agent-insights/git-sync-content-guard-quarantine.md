# git-sync quarantines a broken doc/code file instead of committing it
URL: /internal/docs/agent-insights/git-sync-content-guard-quarantine

Symptom: your .mdx or .ts is sitting dirty and git-sync keeps NOT committing it, while everything else in the tree commits fine — no error to you. Root cause: the git-sync content guard (EI-438) runs content detectors before each auto-commit and EXCLUDES (quarantines) any dirty file that fails one — an .mdx that won't MDX-compile (a bare `<word>` placeholder parsed as an unclosed JSX tag) or a curly quote used as code in .ts/.tsx — so a broken file never reaches staging. Fix: run npm run lint:mdx / lint:smart-quotes to see the exact error, or read the git-sync-content-error escalation; a content-fixer agent is auto-dispatched to repair it.

## Symptom

One of your files — most often an `.mdx` under `apps/operator-docs/`, sometimes a
`.ts`/`.tsx` — stays **dirty in the shared tree and git-sync never commits it**, even
though every *other* dirty file commits normally on the same tick. There is no error
surfaced to you; the file just sits uncommitted indefinitely.

## Root cause: the git-sync content guard (EI-438)

Before its `git add -A`, the git-sync routine runs a **content guard**: every dirty
file is checked by a registered content detector, and a file that **fails** is
**excluded from the commit and left dirty** — *quarantined* — so the broken file never
reaches `staging`. (Before this, git-sync auto-committed the broken file first, and the
break only surfaced hours later when CI rejected the whole docs build — EI-438.)

Five detectors ship today (each wrapping the same pure implementation its CI lint
calls, so the guard and CI can never disagree):

* **`mdx`** — an `.mdx` under `apps/operator-docs/src/content/docs/` that won't compile
  with the MDX core. The classic cause is a bare `<word>` placeholder written in prose
  outside a code span — e.g. `` `<date>` ``, `` `<id>` ``, `` `<slug>` `` — which MDX
  parses as a JSX element open tag with no matching close, hard-failing the entire
  `astro build`.
* **`smart-quotes`** — a curly quote (`' ' " "`) used where a straight code delimiter
  belongs in a `.ts`/`.tsx` file (a copy-paste through a smart-quoting surface), which
  is a hard esbuild/tsc parse failure.
* **`ts-parse`** — a `.ts`/`.tsx` file that does not **parse at all** (WI-6683). The
  general form of the class `smart-quotes` catches one narrow instance of: a stray
  backtick, an unterminated string or template, a truncated file from a concurrent-edit
  interleave. This is checked with a pure `ts.createSourceFile` parse, so it is
  **syntactic only** — it can never quarantine your file over a type error, an
  unresolved import, or a missing dependency. It is quarantined harder than a type
  error deserves *because a parse break is not local*: every consumer of the package
  fails to resolve anything through the broken module, so one typo hard-fails the whole
  fleet's typecheck and reds the green-checkpoint for people who never touched it.
* **`shell-syntax`** — a `.sh` script that fails a real `bash -n` parse (EI-13192) —
  typically a concurrent-edit interleave that duplicated or truncated a block.
* **`conflict-markers`** — a committed git conflict marker (`<<<<<<<`, `>>>>>>>`,
  `|||||||` at line start) in **any** tracked file (EI-1836): a language-agnostic hard
  build breaker that froze the whole fleet's builds twice.

## How to tell + fix

1. **Run the matching lint locally** — it names the exact file + position:

   ```bash
   npm run lint:mdx                  # for an .mdx
   npm run lint:smart-quotes         # for a .ts/.tsx curly quote
   npm run lint:no-conflict-markers  # for a committed conflict marker
   bash -n path/to/script.sh         # for a .sh
   ```

   For **`ts-parse`** there is no whole-tree lint to run — the quarantine message
   already carries the exact `line:col` and the TypeScript diagnostic code, and
   `npm run lint:tsc -- --files=<your file>` shows it in context. A parse error is
   always the FIRST error reported for the file; fix that one and the cascade of
   downstream nonsense errors disappears with it.

2. **Or read the escalation.** git-sync writes a `git-sync-content-error` escalation on
   the phase `git-sync-content` (its own row — it never clobbers a merge-conflict
   escalation) listing the offending files + errors. It also dispatches a
   **`content-fixer`** agent to repair them, mirroring the merge-resolver.

3. **The fix is mechanical:** backtick the placeholder (`` `<date>` ``) or escape it
   (`\<date>`) for MDX; replace the curly quote with a straight `'`/`"` for code
   (escape it instead if it is a real apostrophe inside a string). On the next git-sync
   tick the now-valid file passes the detector and commits normally, and the escalation
   clears.

If the `content-fixer` cannot repair a file after **5 consecutive ticks**, git-sync
stops auto-dispatching and surfaces it to a human (one broadcast) — it never loops
forever, and the file stays quarantined (so `staging` is never at risk) until a human
fixes it.

## Notes

* **It fails open.** A detector (or a file read) that *throws* is skipped, never a
  blocker — a content-check bug can never wedge the whole fleet's commit.
* **Kill-switch.** The flag `papercusp-git-sync-content-guard` (default **ON**) gates
  it; flip it OFF in `/admin/features` to make git-sync commit exactly as before this
  guard existed (no quarantine, no escalation, no fixer), with no deploy.
* Plan + design: `git-sync-content-guard-2026-06-13`. Code:
  `packages/operator-core/lib/harness/git-sync/{content-guard,run-git-sync,git-sync-action}.ts`
  * the shared detectors in `packages/operator-core/lib/content-lint/`.
