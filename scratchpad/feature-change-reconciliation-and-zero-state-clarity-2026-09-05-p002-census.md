# P-002 — frozen feature/change census and September 1 reconciliation

Plan `feature-change-reconciliation-and-zero-state-clarity-2026-09-05`, item
`P-002`, work-item `WI-2146346`. This is a read-only census: no backlog row,
claim spec, or fleet member was mutated while producing it. In particular,
fleet `nonp2p-feature-change-drain-2026-09-04-v3` remains frozen on claim-spec
revision 16 under D-001.

## Frozen population

- Watermark: `2026-09-05T17:09:11.920530Z`
- Maximum selected-row `updatedAt`: `2026-09-05T17:07:29.753Z`
- Scope: workspace `papercusp-workspace`, harness `papercusp`
- Predicate: `kind IN ('feature','change')`, `state NOT IN
  ('done','passed','resolved','closed','deprecated','dropped')`, observation
  lane excluded, and `updatedAt <= watermark`
- Selected rows: **2,261** = **172 feature** + **2,089 change**
- Ordered-ID input: ascending lexical IDs joined with a literal comma and no
  trailing delimiter
- Ordered-ID MD5: `69800bcfff7b9cb82f9345a8efcb57e0`
- Ordered-ID SHA-256:
  `62b68aa60cc8e1a93b758b793709878779e0df896b542be518cab1f0977af1de`
- Manifest anomalies: **0**

| kind | state | rows |
|---|---|---:|
| change | open | 2,014 |
| change | todo | 16 |
| change | blocked | 20 |
| change | needs-human | 39 |
| feature | open | 28 |
| feature | blocked | 139 |
| feature | needs-human | 5 |
| **total** |  | **2,261** |

The exact canonical export invocation recovered from the session tool ledger
was:

```text
work_items:export {
  harness: "papercusp",
  toDir: "/tmp/papercusp-fc-reconcile-p002.qbJPrd",
  terminalOnly: false,
  includeObservations: false
}
```

It returned `written=66724`, `missing=[]`, and
`truncatedByLimit=false`. The subsequent frozen filter excluded 56,192 rows
whose kind was neither `feature` nor `change`, and 8,271 terminal feature/change
rows. Those numbers close exactly: `56,192 + 8,271 + 2,261 = 66,724`.
`excluded.observation=0` means observations were already excluded by the
canonical export call; it does **not** claim the underlying store contains no
observations.

### Independent writer-table query

The export was cross-checked against the two stores that write the unified
surface. The query fixed `p.wm` once, selected exact feature/change kinds,
applied the shared six-state terminal vocabulary, and used the issue view's
stored `lane` column for the observation exclusion:

```sql
WITH p AS (
  SELECT clock_timestamp() AS wm
),
feature_rows AS (
  SELECT feature_id AS id, item_kind AS kind, status AS state
    FROM harness_shared.harness_features_consolidated, p
   WHERE workspace_id = 'papercusp-workspace'
     AND harness_slug = 'papercusp'
     AND item_kind = 'feature'
     AND updated_ts <= (extract(epoch FROM p.wm) * 1000)::bigint
     AND status <> ALL (
       ARRAY['done','passed','resolved','closed','deprecated','dropped']
     )
),
change_rows AS (
  SELECT issue_id AS id, kind, state
    FROM harness_shared.engineer_issues, p
   WHERE workspace_id = 'papercusp-workspace'
     AND scope = 'harness:papercusp'
     AND kind = 'change'
     AND lane IS DISTINCT FROM 'observation'
     AND updated_at <= p.wm
     AND state <> ALL (
       ARRAY['done','passed','resolved','closed','deprecated','dropped']
     )
),
corpus AS (
  SELECT * FROM feature_rows
  UNION ALL
  SELECT * FROM change_rows
),
ordered AS (
  SELECT string_agg(id, ',' ORDER BY id) AS ids
    FROM corpus
)
SELECT
  (SELECT wm FROM p) AS watermark,
  count(*)::int AS total,
  count(*) FILTER (WHERE kind = 'feature')::int AS feature,
  count(*) FILTER (WHERE kind = 'change')::int AS change,
  md5(ordered.ids) AS id_md5,
  encode(digest(ordered.ids, 'sha256'), 'hex') AS id_sha256
FROM corpus CROSS JOIN ordered
GROUP BY ordered.ids;
```

The independent query returned the same 2,261 IDs, kind/state buckets, MD5,
and SHA-256 as the file-backed export. Writer/source semantics were checked in:

- `packages/operator-core/lib/agent-tools/work_items/export.ts:65-79` and
  `:184-195` — explicit all-state/non-observation export knobs, unbounded
  file-backed enumeration, and truncation reporting.
- `packages/operator-core/lib/work-items.ts:1240-1312` — feature-family writer
  view, workspace/harness filters, and mapped feature rows.
- `packages/operator-core/lib/work-items.ts:1315-1369` — issue-family inclusion,
  observation exclusion routing, and the uncapped exporter reader.
- `packages/operator-core/lib/work-items.ts:565-634` and `:683-695` — the
  canonical `id`/`kind`/`state`/`origin`/timestamp mappings exposed in each
  exported JSON row.
- `packages/operator-core/lib/issues-engineer.ts:1594-1616`, `:1655-1679`, and
  `:1916-1963` — nonterminal filtering, the stored-lane observation predicate,
  and the issue-family writer view.

## September 1 ledger re-read

Every unique ID named by the September 1 disposition/preservation evidence was
re-read from the same 66,724-row export. The union contains **149 unique IDs**:
**103 open**, **28 done**, **17 dropped**, and **1 closed**. Exactly **102** are
members of the new frozen corpus. Canonical ordered `(id,state,origin,
inFrozenCorpus,updatedAt)` digest:
`015badd7d6c141d530255b0f5e61589f6cf53de05337a30e62fe3aaa36b5aca9`.

### Current state of all 149 legacy IDs

- **closed (1):** `EI-13260`
- **done (28):** `EI-15209`, `EI-18704153588567089`, `EI-18704693819205504`, `EI-18706598360690343`, `EI-18807865001148074`, `EI-19355852537459957`, `EI-19367241616429861`, `EI-19371085414676865`, `EI-19372875698016854`, `EI-19378791966545578`, `EI-19380717740164754`, `EI-19403437795858863`, `EI-19476667582235542`, `EI-19482333314440433`, `EI-21105767650350924`, `EI-21228851463024785`, `EI-21377394191283993`, `EI-21437105324720310`, `EI-21445547407321199`, `EI-22017366996728883`, `EI-22064465906366039`, `WI-1729084`, `WI-2140428`, `WI-37550`, `WI-41421`, `WI-4668`, `WI-5070`, `WI-5824`
- **dropped (17):** `EI-16253`, `EI-18652033720958396`, `EI-18708450915370408`, `EI-19367242336402442`, `EI-20607941335084548`, `EI-21032653764630066`, `EI-21032654515383704`, `EI-21034969848193785`, `EI-21034970555768887`, `EI-21179583380286320`, `EI-21307443231120520`, `EI-21307735047443422`, `EI-21310384042360263`, `EI-21445553292915949`, `WI-37545`, `WI-4429`, `WI-5071`
- **open (103):** `EI-16781`, `EI-17086`, `EI-18122065313437201`, `EI-18131254473884852`, `EI-18627323536245796`, `EI-18663336225784320`, `EI-18688823981210413`, `EI-18710400650958331`, `EI-18710402934363497`, `EI-18808557559542053`, `EI-20628294919542209`, `EI-20630508400046931`, `EI-20630508792138742`, `EI-20633190285018439`, `EI-20633190770661743`, `EI-21032952013504206`, `EI-21100293164081665`, `EI-21100343234455150`, `EI-21102269168719801`, `EI-21102856384784046`, `EI-21112863677994892`, `EI-21142451677468687`, `EI-21144932575595702`, `EI-21168075558015506`, `EI-21188486922004498`, `EI-21220573084661667`, `EI-21231099679405430`, `EI-21233987092541116`, `EI-21235315526411601`, `EI-21235337127214716`, `EI-21235978651311018`, `EI-21244018999158741`, `EI-21245024976109669`, `EI-21245064718450327`, `EI-21247852936351249`, `EI-21251299341964970`, `EI-21267949738060555`, `EI-21282321535683380`, `EI-21306609190488053`, `EI-21310982417845325`, `EI-21311804649406700`, `EI-21314192235547135`, `EI-21314354387488322`, `EI-21314557748931901`, `EI-21334452585920532`, `EI-21342094406892720`, `EI-21346506582938240`, `EI-21347000068692101`, `EI-21347478429458022`, `EI-21351266573814755`, `EI-21355219214052051`, `EI-21355545965507141`, `EI-21358833651129756`, `EI-21363849760957097`, `EI-21367490817748322`, `EI-21377354811408647`, `EI-21383507254341839`, `EI-21394481656888796`, `EI-21396350167450849`, `EI-21397281334924438`, `EI-21400146324354078`, `EI-21406859916557132`, `EI-21408046388868041`, `EI-21417770374012983`, `EI-21432292014997928`, `EI-21433578092251529`, `EI-21439577921490497`, `EI-21486791553049885`, `EI-21490325147773661`, `EI-21550844654434010`, `EI-21552938316984596`, `EI-21558966320649488`, `EI-21558975771243556`, `EI-21574265409857102`, `EI-21593945047950180`, `EI-21599258539596497`, `EI-21635594635356802`, `EI-21654324886734126`, `EI-21668664086784093`, `EI-21682233754672379`, `EI-21696638048808065`, `EI-21709351942929077`, `EI-21729002427493138`, `EI-21840917995336245`, `EI-21842321260727539`, `EI-21849732447435850`, `EI-21859151359032147`, `EI-21882109955775946`, `EI-21936979751883941`, `EI-22016288006003950`, `EI-22017527397374129`, `EI-22017709462510990`, `EI-22022131877507159`, `EI-22024947521575871`, `EI-22028578055885035`, `EI-22035692059948916`, `EI-22037200469005058`, `EI-22043021882345674`, `EI-22050666099288069`, `EI-22057804176244287`, `WI-40735`, `WI-41458`, `WI-5823`

### September 1 disposition pairs now

All 15 old disposition targets are terminal and outside the frozen corpus:
**12 dropped + 3 done**. The paired survivor side is **8 open + 7 done**;
the eight open survivors are the only members of the frozen corpus.

| # | Survivor | Current | Origin | In corpus | Disposition target | Current | Origin | In corpus |
|---:|---|---|---|:---:|---|---|---|:---:|
| 1 | `EI-20633190770661743` | open | local | yes | `EI-21034970555768887` | dropped | local | no |
| 2 | `EI-20630508792138742` | open | local | yes | `EI-21032654515383704` | dropped | local | no |
| 3 | `EI-18710402934363497` | open | local | yes | `EI-18652033720958396` | dropped | local | no |
| 4 | `EI-18808557559542053` | open | local | yes | `EI-19476667582235542` | done | local | no |
| 5 | `EI-19367241616429861` | done | local | no | `EI-19367242336402442` | dropped | local | no |
| 6 | `EI-19371085414676865` | done | local | no | `EI-19378791966545578` | done | local | no |
| 7 | `EI-19355852537459957` | done | local | no | `EI-19403437795858863` | done | local | no |
| 8 | `EI-18807865001148074` | done | local | no | `EI-20607941335084548` | dropped | local | no |
| 9 | `WI-4668` | done | remote | no | `WI-4429` | dropped | local | no |
| 10 | `WI-5070` | done | local | no | `WI-5071` | dropped | local | no |
| 11 | `EI-20630508400046931` | open | local | yes | `EI-21032653764630066` | dropped | local | no |
| 12 | `EI-20633190285018439` | open | local | yes | `EI-21034969848193785` | dropped | local | no |
| 13 | `EI-21445547407321199` | done | local | no | `EI-21445553292915949` | dropped | local | no |
| 14 | `EI-21102269168719801` | open | local | yes | `EI-21179583380286320` | dropped | local | no |
| 15 | `EI-21552938316984596` | open | local | yes | `EI-21307735047443422` | dropped | local | no |

### Other legacy buckets

- Canonical hub `EI-13260`: closed, outside the corpus.
- Its 18 inbound `duplicates` rows: 8 open + 8 done + 2 dropped; the eight
  open rows are in the corpus.
- Exact-title ledger: 31 groups enumerate **100** unique IDs; 86 open, 8
  dropped, 6 done; 86 in the corpus.
- Seven fuzzy-pair rows touch **12** unique IDs; 8 open, 2 done, 2 dropped;
  eight in the corpus.
- Named preservation list: 12 IDs; 3 open, 7 done, 1 dropped, 1 closed; two
  in the corpus.

This supersedes the September 1 P-002 prose headlines of 105 exact-title rows
and nine fuzzy IDs. Per D-005, strict parsing of the 31 final ID columns yields
100 IDs—the title of group 30 itself mentions `WI-41055`, which is context, not
a candidate—and parsing only the two ID columns of the seven fuzzy rows yields
12 distinct IDs. P-003/P-004 must use these explicit enumerations, not the old
headlines.

## Artifacts and post-compaction validation

| artifact | purpose | checksum / validation |
|---|---|---|
| `/tmp/papercusp-fc-reconcile-p002.qbJPrd/` | 66,724 full canonical JSON rows | 66,724 JSON files |
| `/tmp/p002-corpus-manifest.json` | 2,261 frozen records + ordered IDs | file SHA-256 `baf49444656cc1abce75b691728f1ae2ebbf120baa9eb72374d745457c3feb96` |
| `/tmp/p002-sep1-status-ledger-v2.json` | all 149 legacy IDs and bucket summaries | file SHA-256 `95e4bacad53f7db4c8fb821fcbe118effa0b4eff4c17f85c04de5ea178becada`; canonical status digest `015badd7d6c141d530255b0f5e61589f6cf53de05337a30e62fe3aaa36b5aca9` |

After the carry respawn, the existing artifacts—not a new export—were checked:
all JSON parsed, the manifest equations summed to 2,261, all 2,261 selected IDs
resolved to nonempty exported files, the directory still held 66,724 JSON
files, the comma-joined ordered ID list independently reproduced both stored
hashes, and anomalies remained empty. P-003 therefore starts from this exact
manifest and watermark.
