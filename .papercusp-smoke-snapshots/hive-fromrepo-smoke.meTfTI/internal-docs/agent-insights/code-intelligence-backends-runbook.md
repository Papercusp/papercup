# Code intelligence: which backend answers which question, and how to operate them
URL: /internal/docs/agent-insights/code-intelligence-backends-runbook

The operator runbook for the five code-intelligence backends (rg, LSP, GitNexus, ast-grep, packers): the ratified routing contract, the exact pinned versions and where they live, how to re-provision each, and — the part that costs hours when missed — the five failure modes that return a CONFIDENT WRONG ANSWER rather than an error. Measured at HEAD 2026-08-21 under plan code-intelligence-routing-lsp-gitnexus-2026-08-20.

> Authored as P-019 of `code-intelligence-routing-lsp-gitnexus-2026-08-20`. The
> routing contract is D-001; the exact backend/version record with every rejected
> alternative is **D-048** on that plan. This page is the operational half: how to
> call each backend, how to repair it, and how it lies to you.

## 1. The routing contract — question class decides the backend

Each row is a *question class*, not a preference. Picking by habit rather than by
question is what the contract exists to stop.

| the question                                 | the authority                                                | not                                                                   |
| -------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------- |
| definition, references, type truth           | `lsp:query` — real compiler semantics                        | a grep for the declaration: it cannot resolve shadowing or re-exports |
| call chains, impact radius, topology         | `gitnexus.context` / `gitnexus.impact` (dot form, not colon) | `gitnexus.query` — see §3.1                                           |
| structural code patterns (shape, not text)   | the ast-grep facade                                          | a regex that approximates an AST                                      |
| an exact keyword or phrase                   | `search:fulltext`                                            | `ILIKE '%…%'`                                                         |
| a paraphrased concept                        | `search:semantic`                                            | keyword search that misses the wording                                |
| exhaustive exact-text sweep                  | plain `rg` / `grep` — still the right tool                   | a graph query, which is indexed and can lag                           |
| packaging evidence for a reviewer or a model | `code:pack` — strictly POST-retrieval                        | a raw packer binary; it skips the pinned version and the secret rails |

The LSP surface registers as **one** tool with an `op` enum, not seven separate
tools (D-011) — so it is `lsp:query { op: … }`, and a missing `op` is the usual
first-call mistake.

## 2. What is installed, and where

Exact versions, read from the live install and recorded in full in D-048:

| backend                                     | version                     | location                                                               |
| ------------------------------------------- | --------------------------- | ---------------------------------------------------------------------- |
| typescript-language-server                  | 6.0.0                       | `~/.papercusp/vendor/lsp`                                              |
| tsserver (via transitive `@typescript/old`) | stock typescript 6.0.3      | `~/.papercusp/vendor/lsp/node_modules/@typescript/old/lib/tsserver.js` |
| rust-analyzer                               | 1.97.1 (8bab26f 2026-07-14) | rustup component, `stable-x86_64-unknown-linux-gnu`                    |
| gitnexus                                    | 1.6.9                       | `~/.papercusp/vendor/gitnexus/node_modules/.bin/gitnexus`              |
| repomix                                     | 1.18.0                      | `~/.papercusp/vendor/repomix`                                          |
| code2prompt                                 | 4.2.0                       | `~/.papercusp/vendor/code2prompt/bin/code2prompt`                      |

Two things about this table bite people:

**The two TypeScript versions are both correct.** The vendored `typescript`
dependency is `@typescript/typescript6@6.0.2`, which ships **no** `tsserver.js`.
The language server is therefore pointed at the *transitive* `@typescript/old`
— stock typescript, resolved here to 6.0.3 — which does ship it (D-009). Seeing
6.0.2 and 6.0.3 side by side looks like drift and is not. `@typescript/old` is an
alias rather than a publishable package (`npm view` 404s it), so the adapter must
`require.resolve` it and fail loudly if absent; an npm rehoist can move it.

**Everything is vendored under `~/.papercusp/vendor`, never shared workspace
`node_modules`.** This is load-bearing on a shared tree, not tidiness: a bare
install into the workspace rewrites `node_modules/.bin` underneath every peer
agent's in-flight test run.

Re-provision with the same isolation:

```bash
npm install --prefix ~/.papercusp/vendor/lsp \
  typescript-language-server@6.0.0 'typescript@npm:@typescript/typescript6@6.0.2'
npm install --prefix ~/.papercusp/vendor/gitnexus gitnexus@1.6.9
```

## 3. The five failure modes that return a confident wrong answer

This is the section worth reading before you trust a result. Every entry fails
*toward* a plausible answer, so nothing throws and nothing looks broken.

### 3.1 `gitnexus.query` returns unranked noise, not an empty set

A nonsense symbol yields \~20 confident-looking rows, and a wrong argument name
yields byte-identical output — proving the search term is never applied
(measured, D-021). It is the one intent whose failure looks exactly like success.
Use `gitnexus.context` / `gitnexus.impact`. Guidance that puts `gitnexus.query`
in recommendation position is a lint failure (D-042).

### 3.2 A language server queried before project load returns the WRONG location

Not an error — a plausible wrong answer (D-010). Readiness must come from the
server's own progress signal, never from an idle heuristic: a server still
indexing answers "no references" indistinguishably from one that is genuinely
ready (WI-40224). rust-analyzer declares `requiresProgressSignal`.

### 3.3 GitNexus line numbers are ZERO-indexed

Every other surface here is 1-indexed. Normalize before citing, or every citation
lands one line off — close enough to look right in review (D-008).

### 3.4 `Unknown namespace(s): gitnexus` means the bridge has not deployed

It does **not** mean "no call chains exist". Fall back to `rg` + `lsp:query` for
that question class until the pinned-resolver fix deploys, and never read the
absence as evidence about the code.

> A related structural trap, fixed but worth knowing: widening the language union
> without adding a `LANGUAGE_SPECS` entry once resolved a new language to the
> *rust-analyzer* binary while labelling its documents `rust` (WI-40250). The
> `Record<LspLanguage, LanguageSpec>` is exhaustive by construction — do not relax
> it to `Partial<…>` or an index signature.

### 3.5 A STALE GitNexus index answers from the commit it last indexed

`gitnexus` answers happily against whatever it indexed last and does not warn at
query time, so a stale index is indistinguishable from a fresh one in the result.
Measured 2026-08-21: `Indexed commit: 1b6621f` against `Current commit: ce1545d`,
status `stale`, on a 5.3G index built \~50 minutes earlier. On a tree this active,
under a git-sync routine that commits continuously, the index goes stale within
the hour.

The consequence that costs you: any *correctness* measurement taken against a
stale index measures INDEX LAG and reports it as routing quality. Check with
`gitnexus status` (want `Indexed commit` == `Current commit`) and re-run
`gitnexus analyze` IMMEDIATELY before measuring — not at the start of a session
that will still be running an hour later.

## 4. Performance you should expect

Measured at HEAD, two runs:

|                  | TypeScript        | rust-analyzer       |
| ---------------- | ----------------- | ------------------- |
| cold start       | 3,917ms / 3,418ms | 10,760ms / 11,322ms |
| steady-state RSS | 66.7 MB           | 2,817 MB            |

The rust cold start exceeds the nominal budget. That is an **accounted, bounded**
exceedance rather than a regression, and it is deliberately not pinned in both
directions because it drifts \~562ms run to run (D-046).

**Warm-start latency is dominated by PROJECT LOAD, not by query cost.** A
definition on a warm server took 21,305ms — and the cause was established by a
discriminating experiment rather than inference: the same query, asked first on a
cold server with no references call anywhere before it, reproduced the timing
almost exactly, which made the rival explanation impossible by construction
(D-047). Loading `operator-core` costs \~21.7s against \~3.9s for a small package,
while adopting a *second* project on an already-warm server costs only 539ms.

The practical consequence: warm-up, if it is ever added, must be **per-project
and demand-driven**. An eager version is actively harmful — tsserver serialises,
so prewarming projects nobody asks about delays the queries someone is waiting on.

## 5. Verifying a backend is genuinely answering

The recurring mistake is accepting a green suite that silently skipped.

* **Check the binaries resolve at the exact paths the specs use** — and pair the
  check with a positive control on a path you know exists. An `ls` of a missing
  path and an `ls` of a present one both print nothing useful once the exit code
  is discarded, so an absence claim without a control is not evidence.
* **Run the live suites:** the bakeoff (`code-intel-bench.integration.test.ts`)
  exercises both real servers; the facade and acceptance-corpus suites cover
  routing and fixtures. A bakeoff that reports success having *skipped* both
  servers looks identical to one that passed.
* **Check the GitNexus index is FRESH, not merely present** — `gitnexus status`
  must show `Indexed commit` == `Current commit`. A stale index answers without
  erroring (§3.5), so "gitnexus responded" is not evidence the answer is current.
* **Know what the corpus does not cover.** Interface implementations / type
  definitions and rename preview are UNEVALUATED. Do not claim coverage the
  corpus does not have.
