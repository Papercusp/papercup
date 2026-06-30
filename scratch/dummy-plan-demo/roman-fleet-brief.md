# Fleet member kickoff — dummy-fleet-roman-numerals-2026-06-30

You are a MEMBER of the desktop fleet **dummy-roman-fleet** (harness `papercusp`).
Your one job: implement the plan `dummy-fleet-roman-numerals-2026-06-30` end-to-end,
then report and stop. This is a throwaway SCRATCH demo — no production code, no flags,
no DB, no tests in the repo suite.

**AUTO MODE IS ON for this launch.** Act on your own judgment. Do NOT stop to ask the
owner for approval or to pick a route — the route is already decided (you implement it
yourself, now). Loop continuously until the plan is done; do not end your turn to ask
"should I continue?".

## Steps
1. `coord:orient { intent: "implement dummy roman-numeral plan", planSlug: "dummy-fleet-roman-numerals-2026-06-30", planItems: ["P-001","P-002","P-003"] }` — this claims your lane (all 3 items).
2. `plans:get { slug: "dummy-fleet-roman-numerals-2026-06-30" }` — read the full item specs.
3. **P-001** → flip it `wip` (`plans:set-status`), then create `scratch/dummy-plan-demo/roman.mjs`:
   - `toRoman(n)`: integer 1–3999 → standard subtractive Roman numeral string
     (4→"IV", 9→"IX", 1994→"MCMXCIV"); throw `RangeError` for non-integers or out of 1–3999.
   - `fromRoman(s)`: inverse, case-insensitive, parse a canonical numeral → integer;
     throw on invalid / non-canonical input (e.g. "IIII").
   - Pure ESM functions, no deps. Flip P-001 `done`.
4. **P-002** → `wip`, then create `scratch/dummy-plan-demo/roman.test.mjs`
   (`node:test` + `node:assert/strict`) covering: toRoman of 1=I, 4=IV, 9=IX, 40=XL,
   90=XC, 400=CD, 900=CM, 2024=MMXXIV, 3999=MMMCMXCIX; fromRoman round-trips each;
   `fromRoman("xiv")===14`; a RangeError from toRoman(0) and toRoman(4000); a throw
   from fromRoman("IIII"). Flip P-002 `done`.
5. **P-003** → `wip`, run `node --test scratch/dummy-plan-demo/roman.test.mjs`, confirm
   the suite is green. Flip P-003 `done`.
6. `coord:send { to: ["*"], summary: "dummy-fleet-roman-numerals complete", body: "<n>/<n> tests green" }` and END your turn.

git-sync owns commit/push — do NOT `git add`/`commit`/`push`. Just leave the files in the tree.
