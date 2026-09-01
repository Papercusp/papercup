# P-002 — bounded candidate ledger

Plan `feature-change-dedup-supersession-audit-2026-09-01`, item `P-002`, driven
from `WI-2140611`. Companion to the P-001 report
(`scratchpad/feature-change-dedup-supersession-audit-2026-09-01.md`), which
defines the frozen corpus, its fixed watermark, and the canonical
export/census recipe reused here. **No work-item was mutated to produce this
ledger** — every query below is read-only (`dev:pg_query`).

Corpus definition (same as P-001): `kind` in {`feature`,`change`}, `state` not
in `done|passed|resolved|closed|deprecated|dropped`, `payload.lane` distinct
from `observation`, `updatedAt <= 2026-09-01T15:49:00Z`, scope
`harness:papercusp`. Re-running this recipe LIVE (2026-09-01T19:20Z) returns a
*smaller* corpus (2758: 151 feature / 2607 change) than the P-001 capture
(2808: 175 feature / 2633 change) because items that close after the
watermark get `updated_at` bumped past it and drop out of the `<=` filter —
expected drift, not a defect (documented in the P-001 report).

## 1. Exact full-identity duplicates (title AND summary/body identical)

```sql
-- corpus CTE as above, corpus_i.summary := engineer_issues.body
SELECT title, summary, count(*) n, array_agg(id ORDER BY id) ids
FROM corpus GROUP BY title, summary HAVING count(*) > 1 ORDER BY n DESC, title;
```

2 groups / 4 rows (down from 5 groups/10 rows at the P-001 capture — 3 pairs
already closed since):

| title | ids |
|---|---|
| Gym champion promoted: judge@h-pao cycle 4 — consider generalizing | EI-20633190770661743, EI-21034970555768887 |
| Gym champion promoted: reviewer@tx cycle 1 — consider generalizing | EI-20630508792138742, EI-21032654515383704 |

Both are the recurring `gym-champion` escalation pattern already characterized
in the P-001 checkpoint: no inbound/outbound typed links, no assignee, no plan
coverage — the earlier prior-work checkpoint judged this shape safe to
soft-deprecate one side of each pair onto a canonical survivor.

## 2. Exact title-only duplicates (same title, summary/body may differ)

```sql
SELECT title, count(*) n, string_agg(id, ',' ORDER BY id) ids
FROM corpus GROUP BY title HAVING count(*) > 1 ORDER BY n DESC, title;
```

31 groups / 105 rows. Full list (title — n — ids):

1. `loop:checkpoint tool-call failure (invalid_args)` — 10 — EI-21220573084661667, EI-21247852936351249, EI-21342094406892720, EI-21346506582938240, EI-21358833651129756, EI-21394481656888796, EI-21397281334924438, EI-21400146324354078, EI-21729002427493138, EI-22017709462510990
2. `coord:presence tool-call failure (invalid_args)` — 9 — EI-21231099679405430, EI-21244018999158741, EI-21251299341964970, EI-21267949738060555, EI-21351266573814755, EI-21355219214052051, EI-21355545965507141, EI-21406859916557132, EI-22035692059948916
3. `facts:assert tool-call failure (invalid_args)` — 5 — EI-21245024976109669, EI-21439577921490497, EI-21840917995336245, EI-22017527397374129, EI-22064465906366039
4. `work_items:get tool-call failure (invalid_args)` — 5 — EI-21363849760957097, EI-21558966320649488, EI-21574265409857102, EI-21842321260727539, EI-21849732447435850
5. `coord:inbox tool-call failure (invalid_args)` — 4 — EI-21235315526411601, EI-21306609190488053, EI-21882109955775946, EI-22037200469005058
6. `coord:send tool-call failure (invalid_args)` — 4 — EI-21310982417845325, EI-22028578055885035, EI-22043021882345674, EI-22050666099288069
7. `improvements:capture tool-call failure (invalid_args)` — 4 — EI-21282321535683380, EI-21396350167450849, EI-21408046388868041, EI-21490325147773661
8. `release:trace tool-call failure (invalid_args)` — 4 — EI-21235978651311018, EI-21347000068692101, EI-21347478429458022, EI-21432292014997928
9. `work_items:checkpoint tool-call failure (invalid_args)` — 4 — EI-21550844654434010, EI-21936979751883941, EI-22022131877507159, EI-22057804176244287
10. `work_items:complete tool-call failure (invalid_args)` — 4 — EI-21314192235547135, EI-21314354387488322, EI-21314557748931901, EI-21635594635356802
11. `coord:presence tool-call failure (invalid_input)` — 3 — EI-21235337127214716, EI-21245064718450327, EI-21599258539596497
12. `facts:list tool-call failure (invalid_args)` — 3 — EI-21228851463024785, EI-21377394191283993, EI-22017366996728883
13. `Gym champion promoted: worker@gymloopharness cycle 1 — consider generalizing` — 3 — EI-18688823981210413, EI-20628294919542209, EI-21032952013504206
14. `improvements:capture toolFailure shorthand requires title and body` — 3 — EI-21102856384784046, EI-21112863677994892, EI-21168075558015506
15. `sessions:search tool-call failure (invalid_args)` — 3 — EI-21696638048808065, EI-21859151359032147, EI-22024947521575871
16. `capability:read tool-call failure (invalid_args)` — 2 — EI-21383507254341839, EI-21433578092251529
17. `coord:feed tool-call failure (invalid_args)` — 2 — EI-21486791553049885, EI-21668664086784093
18. `coord:inbox unanswered filter key mismatch` — 2 — EI-21142451677468687, EI-21367490817748322
19. `coord:presence targeted lookup rejects intuitive owners array` — 2 — EI-21100343234455150, EI-21188486922004498
20. `docs:search tool-call failure (harness_required)` — 2 — EI-21307443231120520, EI-21310384042360263
21. `Gym champion promoted: judge@h-pao cycle 4 — consider generalizing` — 2 — EI-20633190770661743, EI-21034970555768887
22. `Gym champion promoted: reviewer@tx cycle 1 — consider generalizing` — 2 — EI-20630508792138742, EI-21032654515383704
23. `Gym champion promoted: validator@beta cycle 1 — consider generalizing` — 2 — EI-20630508400046931, EI-21032653764630066
24. `Gym champion promoted: worker@h-pao cycle 3 — consider generalizing` — 2 — EI-20633190285018439, EI-21034969848193785
25. `loop:status rejects documented harness argument` — 2 — EI-21144932575595702, EI-21593945047950180
26. `loop:status tool-call failure (invalid_args)` — 2 — EI-21233987092541116, EI-21558975771243556
27. `Operator chat TTFT: reuse the brain session across turns (session-resume + delta-only prompts) — kill the per-turn cold claude-code spawn` — 2 — WI-5070, WI-5071
28. `rubrics:get tool-call failure (invalid_args)` — 2 — EI-21311804649406700, EI-21377354811408647
29. `sessions:read tool-call failure (invalid_args)` — 2 — EI-21334452585920532, EI-21417770374012983
30. `Tool schema mismatch encountered during WI-41055 supervision` — 2 — EI-21445547407321199, EI-21445553292915949
31. `work_items:create tool-call failure (invalid_args)` — 2 — EI-21654324886734126, EI-22016288006003950

Note: most rows here are **independently-filed observations of the same
recurring tool-failure class** (title-templated by the observation harvester),
not necessarily hand-authored duplicates — P-003 must check `distinct
summaries`/bodies (mostly all-distinct per group; see raw query) and
`lane`/`source` before treating any group as a true duplicate rather than N
independent repro reports of one bug class.

## 3. Explicit typed duplicate/revises links touching the corpus

`harness_shared.coord_links`, `rel` in {`duplicates`,`revises`}, at least one
endpoint id present in the frozen corpus (kind-checked: `feature`↔`feature`,
`issue`↔`change`):

```sql
SELECT l.rel, l.src_ref, l.dst_ref,
  (EXISTS(SELECT 1 FROM corpus c WHERE c.id=l.src_ref)) AS src_in_corpus,
  (EXISTS(SELECT 1 FROM corpus c WHERE c.id=l.dst_ref)) AS dst_in_corpus
FROM harness_shared.coord_links l
WHERE l.workspace_id='papercusp-workspace' AND l.rel IN ('duplicates','revises')
  AND EXISTS (... corpus membership on either endpoint with kind check ...)
ORDER BY l.rel, l.src_ref;
```

64 rows (60 `duplicates`, 4 `revises`) as of 2026-09-01T19:20Z. `src_in_corpus`
/`dst_in_corpus` distinguish three shapes P-003 must handle differently:
- **both `true`** (open↔open, e.g. `EI-18710402934363497→EI-18652033720958396`,
  `EI-18808557559542053→EI-19476667582235542`,
  `EI-19367241616429861→EI-19367242336402442`,
  `EI-19378791966545578→EI-19371085414676865`,
  `EI-19403437795858863→EI-19355852537459957`): the strongest soft-deprecation
  candidates — an explicit typed claim between two still-open rows.
- **one `true`, one `false`** (the large majority, e.g. every
  `→EI-13260` edge, and most `revises` rows): a still-open row explicitly
  claims to duplicate/revise an ALREADY-terminal row — supersession residue;
  P-003 should confirm the terminal side's disposition (was it closed AS this
  duplicate, or independently) before treating the open side as closable.
- `revises` edges include two work-plan-adjacent targets worth flagging by
  name: `WI-40735 → learning-loop-identity-consumption-acceptance` (dst is a
  slug, not a WI/EI id — likely a plan or goal ref, needs P-003 resolution)
  and `WI-41458 → WI-41421`.

Full row set is queryable verbatim via the SQL above (`dev:pg_query`); omitted
here only to keep this ledger from re-embedding all 64 rows twice — re-run is
cheap (< 1s) and exact.

## 4. High-similarity title clusters beyond exact/typed matches

Token-overlap candidate generation (≥3 shared significant tokens, length≥5)
refined by `pg_trgm` `similarity()`, corpus-restricted:

```sql
WITH ... corpus AS (...),
tokens AS (SELECT id, regexp_split_to_table(lower(regexp_replace(title,'[^a-zA-Z0-9]+',' ','g')), '\s+') AS tok FROM corpus),
sig_tokens AS (SELECT id, tok FROM tokens WHERE length(tok) >= 5),
pairs AS (SELECT a.id id_a, b.id id_b, count(*) shared FROM sig_tokens a JOIN sig_tokens b ON a.tok=b.tok AND a.id<b.id GROUP BY a.id,b.id HAVING count(*)>=3)
SELECT p.id_a, p.id_b, round(similarity(ca.title,cb.title)::numeric,3) sim
FROM pairs p JOIN corpus ca ON ca.id=p.id_a JOIN corpus cb ON cb.id=p.id_b
WHERE similarity(ca.title,cb.title) > 0.9 ORDER BY sim DESC;
```

(A naive corpus×corpus self-join on `similarity()` times out at 28s on ~2758
rows; the token-overlap pre-filter above is the reproducible, non-timing-out
form — full counts at other thresholds: >0.5 → 1215 pairs, >0.6 → 873, >0.75 →
443, >0.9 → 177. 177 is the bounded set enumerated below.)

Of the 177 pairs at similarity > 0.9, **170 are sim = 1.000 and are exactly
the pairwise decomposition of the 31 exact-title groups in §2** (no new
information). The genuinely NEW near-duplicate candidates (sim < 1.0, not
already in §2 or §3) are:

| id_a | id_b | sim |
|---|---|---|
| EI-21105767650350924 | EI-21437105324720310 | 0.967 |
| EI-21682233754672379 | EI-21709351942929077 | 0.940 |
| EI-21102269168719801 | EI-21179583380286320 | 0.935 |
| EI-21100293164081665 | EI-21102856384784046 | 0.925 |
| EI-21100293164081665 | EI-21168075558015506 | 0.925 |
| EI-21100293164081665 | EI-21112863677994892 | 0.925 |
| EI-21307735047443422 | EI-21552938316984596 | 0.914 |

(The last three rows share `EI-21100293164081665` with group #14 in §2 —
likely a 4th near-duplicate of that `improvements:capture toolFailure
shorthand` cluster, title-paraphrased rather than identical.)

## Summary counts (for P-003 sizing)

| bucket | groups/edges | rows/ids touched |
|---|---|---|
| §1 exact full identity | 2 | 4 |
| §2 exact title-only | 31 | 105 |
| §3 explicit `duplicates`/`revises` links | 64 edges | ~104 distinct ids |
| §4 new fuzzy near-duplicates (sim<1.0, not in §1–3) | 7 pairs | 9 distinct ids |

No work-item was created, claimed, linked, or mutated by this ledger — P-003
is the validation + soft-deprecation pass.
