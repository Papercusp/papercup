# A source file that greps as \"binary\" — the NUL-byte corruption class
URL: /internal/docs/agent-insights/source-file-reads-as-binary-nul-byte

When grep says \"binary file matches\" on a .ts/.tsx file, a raw NUL byte has corrupted it. It survives review, grep, git diff and tsc, and breaks behaviour only at runtime. How to spot, confirm, and durably fix it.

## The symptom

`grep` prints **`binary file matches`** for a plain `.ts` / `.tsx` file — or returns
*nothing at all* for a symbol you can plainly see in the file. `file foo.tsx` says
`data` instead of `Unicode text`. `git diff` renders `Binary files … differ` instead
of a hunk.

That file contains a **raw NUL byte** (`U+0000`). In a text source a NUL is *always*
corruption — no language here needs one.

## Why this class is dangerous

A NUL defeats **every** check we normally rely on, and fails **silently** at each:

| Layer               | What it does                                          | Why it misses                                        |
| ------------------- | ----------------------------------------------------- | ---------------------------------------------------- |
| Code review         | renders as nothing                                    | `'\0all'` looks identical to `' all'`                |
| `grep` / `git grep` | reclassifies the file binary, suppresses line matches | an audit sweep skates straight past the file         |
| `git diff`          | "Binary files differ"                                 | no reviewable hunk                                   |
| `tsc`               | passes                                                | a NUL is a *legal* character inside a string literal |
| Unit tests          | pass                                                  | only if no test covers the affected path             |

So the damage lands **at runtime only**. Nothing goes red; behaviour just quietly stops
being what the code appears to say.

> Related but different: \[EI-1886] — under a non-UTF-8 locale, `grep` also
> false-empties on files containing ordinary UTF-8 punctuation (em-dash). Same
> *symptom* ("binary"/empty), different cause. Rule out the locale first:
> `grep -a` or the ripgrep-based Grep tool. If `grep -a` finds your symbol and the
> file has no NULs, it was the locale, not corruption.

## Confirming it

Shell args cannot carry a NUL, so ask node:

```bash
node -e '
const fs=require("fs"), NUL=String.fromCharCode(0);
const s=fs.readFileSync(process.argv[1],"utf8");
console.log("NULs:", s.split(NUL).length-1);
s.split("\n").forEach((l,i)=>{ if(l.indexOf(NUL)>=0) console.log((i+1)+": "+JSON.stringify(l)); });
' path/to/file.tsx
```

`JSON.stringify` is the point — it prints the byte as a visible `�`.
(`cat -v` also shows it, as `^@`.)

Quick count without node: `tr -dc '\000' < file | wc -c`.

## The real-world case (worth internalising)

`/adv/HUD`'s "all fleets" chip uses the sentinel `' all'` — a **leading space**,
chosen deliberately because a real `fleetSlug` is kebab and can never contain one.
`HudView.tsx` declared it; `HudBoard.tsx` re-spelled the same literal itself.

HudBoard's copy had its leading space corrupted to a NUL. Therefore
`slug === ALL_FLEETS` never matched, so clicking "all fleets" fell through to the
*toggle-one-fleet* branch and pushed a junk slug **into** the filter — the button
whose entire job is to **clear** the filter emptied the board instead. It shipped,
typechecked, and greped clean.

## The durable fix — two parts

**1. Kill the duplication, not just the byte.** The root cause was not the NUL; it was
that a **whitespace-ish sentinel was spelled out in two places**. Such a literal is
invisible in a diff, so the copies can drift without anyone seeing it. Give it exactly
one exported definition and import it everywhere:

```ts
// hud-board-model.ts — one definition, imported by HudBoard and HudView
export const ALL_FLEETS = ' all';
export const SOLO_FLEET_KEY = ' solo';
```

Then assert against the **imported constant** in the test, never a re-typed literal —
a drifted copy then cannot pass:

```ts
fireEvent.click(screen.getByRole('button', { name: /all fleets/ }));
expect(props.onToggleFleet).toHaveBeenCalledWith(ALL_FLEETS);
```

**2. Guard the class.** `apps/operator/app/_lints/no-nul-bytes.test.ts` fails if any
text source under `apps/operator/app` or `apps/operator-vite/src` contains a raw NUL.
The next corrupted file reds a test instead of shipping a dead code path.

## Generalising

Any **invisible-character sentinel** — leading/trailing space, non-breaking space,
zero-width joiner — carries this risk. If you need one:

* define it **once**, export it, import it — never re-spell it inline;
* say in a comment *why* it is invisible-but-deliberate, so the next reader does not
  "tidy" it away;
* prefer a **visible** sentinel (`'__all__'`, or better a typed
  `null` / discriminated union) when the design allows. An invisible sentinel is a
  correctness hazard, not a clever trick.

## Still open

How the NUL was *written* is unproven. The leading candidate is shell-append (`cat >>`)
edits that bypass the file-lock hook, where a truncated or interleaved concurrent write
can emit a stray NUL. The lint catches the next occurrence; it does not stop the writer.
If you confirm the vector, link it and fix the writer.
