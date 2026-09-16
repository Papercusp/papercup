# Storewolf Transformer — architecture audit & interview guide

**September 14, 2026 · WI-10001436 · Separate from the paused overall Storewolf audit**

## Executive summary

**Transformer is a rule-based product-configuration and fulfillment-options engine, not a neural-network Transformer.** It answers: *“Which available products can satisfy this requested configuration, possibly after a permitted upgrade or a superior-spec substitution, and at what modeled cost?”*

Its strongest design choice is to separate **expensive, mostly static compatibility compilation** from **query-time inventory and pricing**. It compiles product comparisons and feasible transformations into compact indexes, then combines those indexes with source quantities/costs and fulfillment constraints. “Goodness” and “cost” are separate structures: technically better does not necessarily mean cheaper, and some configurations are incomparable. [S1–S5]

**Audit verdict:** a substantial, domain-specific precomputed search engine, with reproducible correctness and failure-reporting weaknesses. The implementation supports a strong interview discussion of partial orders, graph/index compilation, compression, and process partitioning. It does **not** justify claims of globally optimal inventory allocation, general shortest-path planning, or verified production reliability.

### Deliverables

- `architecture.svg` — rendered, standalone diagram; open in a browser or image viewer.
- `architecture.mmd` — editable Mermaid version.
- This report — architecture, findings, worked example, and interview script.
- `audit-probes.test.cjs` — safe, repeatable source characterizations.
- `evidence.json` — source hashes, scope, and verification results.

## Scope and evidence

Inspected the actual local working code, not just its README or filenames:

| Subject | Recorded revision |
|---|---|
| `~/storewolf-central-server`, branch `old_node_fetch` | `05f961f453907daa662369cb90c4d480369f5b02` |
| Its `Services/Transformer` submodule | `db4b5abcfb3062576dee5b650da1f03451cd5cd2` |
| Resolved dependency `~/Storewolf-Libs` | `de7721eccf882e87d242162ae833b00f1dfc3914` |

Transformer and the resolved library were clean when inspected. The parent application has pre-existing working-tree changes; individual evidence-file hashes identify the actual bytes read. This is **not an attestation of what is deployed**.

Application/production scope stayed read-only. No service boot, real RPC, inventory fetch, spreadsheet download, marketplace action, deployment, or application database write. The probes use Node's test runner, source methods evaluated in a controlled VM, fake process/SharedMap boundaries, and a real **in-memory** SQLite database. Passing a characterization reproduces a defect; it does not bless it.

## 1. Mental model and terminology

| Term | Meaning here |
|---|---|
| Spec object / group ID | A product configuration with fields such as series, CPU, RAM, drives, graphics, OS, and form factor. |
| Full Transformer SKU | The configuration plus condition, location, and handling-time information. Configuration-level and fulfillment-level identities are distinct. |
| Comparison / “goodness” | A partial-order-like relation: lower, equal, higher, or incomparable. Mixed improvements across properties can be incomparable. |
| Upgrade | A physical change permitted by the source's upgrade rules, with modeled part and overhead costs. Costs can include negative part deltas, not just positive purchase costs. |
| “Impersonation” | The code's term for fulfilling a lesser/equivalent specification using a qualifying superior configuration without that physical change. In an interview, say **superior-spec substitution**, not identity impersonation. Actual sales-policy permissibility still requires business rules. |
| Stripper | A synthetic stripped-down configuration derived by removing upgradeable properties; useful for grouping/expansion, not a physical stock reservation. |
| Category | A coarse partition built using series-rank reachability, with hardcoded special-case splits. Not identical to either an upgrade group or a Rankifier's internal index group. |
| Rankifier | A compiled query structure. The goodness instance indexes comparison relations; the cost instance indexes fulfillment transformations and associated weights. |

Evidence: [S2–S5]. Do not collapse the different kinds of “group” into one identifier.

## 2. Build / compile flow

1. **Supply specs and a named rule set.** `Transformer.create` accepts rule objects or spreadsheet inputs. Rule families cover ranking, upgrade compatibility/cost, grouping, handling, and miscellaneous overheads. Spreadsheet import is an available build path, not something every query performs. [S1]
2. **Construct the comparator.** `Computer.js` mixes explicitly ranked properties, custom comparators (RAM, paired disks, color), and hybrid manual/custom CPU comparisons. Properties outside the configured lists are not part of the comparison universe. Rank rules become directed graphs; upgrade rules become directed, weighted property edges. [S2]
3. **Partition the configuration population.** `SKUTransformerMaster` categorizes specs, drops entries without a category or upgrade group, indexes categories by size, and routes a category to a child process. Series reachability drives categorization; special cases split some XPS and OptiPlex configurations. [S3]
4. **Compile pair relations inside each category.** `SKUTransformer` compares configurations, expands feasible condition/location/handling variants, and builds goodness and cost relations. The visible loop processes configuration slices of 100, while category compilation uses a 14,000-spec admission heuristic. These are code constants, **not measured capacity limits or throughput figures**. [S4]
5. **Build compact lookup structures.** BitSets are used during compilation; grouped local integer indexes and Roaring bitmaps represent forward/reverse relations. Weight compression helpers also exist, but the audited online path retrieves weights from SQLite. [S4–S6]
6. **Persist and reload.** The normal category-build path writes SQLite weights and FBE-encoded configuration/index data. A JSON category map locates children. Startup loads rule files, creates the comparator, spawns category children, and loads their FBE state. This normal path is distinct from the defective standalone save wrapper in finding F1. [S1, S3–S6]

### Why precompute?

**Interpretation of the design:** compatibility changes less frequently than available quantity or acquisition cost, so expensive comparisons can be reused across many stock queries. Partitioning reduces the pair-comparison population; integer indexes and bitmap set operations avoid repeatedly evaluating every property.

**Trade-off:** compilation can be expensive and the compiled model must remain consistent with rule files, schema/code, and SQLite weights. This audit did not benchmark compilation or prove completeness of the category boundaries.

## 3. Runtime query flow

There are two important entry paths:

- **Order sourcing:** `OrderProcessor` calls `queryWithInstockInventory`. Transformer obtains quantity/cost maps from `Synchronizer.generateUpdatesTwo`, then runs stock queries. The checked order request explicitly uses `combine:true, bySource:true`. [S7]
- **Listing expansion:** `Synchronizer` calls `Transformer.enlargeListings` with an existing inventory map. Transformer sets positive-quantity filtering and `transformableFromAny:"ALL"`, then queries the model. Synchronizer performs subsequent pending-order removal, listing conversion, and pricing. Transformer is not the entire listing or order-management workflow. [S8]

The query then:

1. Resolves configuration IDs/full SKUs and ASIN/UPC associations using DataStore.
2. Expands `"ALL"` against available property-map keys.
3. Partitions filters and stock-map views by category.
4. Dispatches category queries through the process router.
5. Uses goodness filters when requested, and forward/reverse transformation indexes for `transformableFrom/To` constraints.
6. Applies `Any`/`All` set semantics, obtains per-pair SQLite weights, and attaches dynamic cost, quantity, and source fields.
7. Filters by stock, cost, condition, location, and handling constraints; selects/sorts within requested result groups.
8. Produces grouped `FROM`/`TO` result maps backed by SharedMap, plus stats. Optional enrichment adds upgrade/substitution breakdowns and human-readable summaries. [S3–S7, S9]

**Cost model:** for an ordinary returned path, `finalCost = originalCost + transformCost`. A physical part change can add a part-price delta, an absolute-delta percentage overhead, a property-specific fixed cost, and a fixed upgrade charge. `CHEAPEST` compares source cost plus path weight; `LIGHTEST` compares transformation weight alone. They answer different questions. [S2, S4]

### A concrete example

Illustrative synthetic rules, not a claim about current inventory:

- Requested target: a specified laptop with **16 GB RAM**.
- Source A: compatible **8 GB** laptop, acquisition cost **300**.
- Allowed RAM change: part delta **20**, overhead **10%**, fixed upgrade cost **5**.
- Modeled transformation cost: `20 + round(abs(20) × 0.10) + 5 = 27`.
- Modeled final cost: `300 + 27 = 327`.
- Source B already meets/exceeds the target and costs **340**, with zero substitution cost.

`CHEAPEST` can choose A **if** its condition, location, handling, stock, and other rules permit the path. `LIGHTEST` can prefer B's zero-change path. The comparator/upgrade arithmetic is exercised by the probes; this worked example is not an end-to-end inventory run.

**Important boundary:** returning alternatives for several targets is not proof those targets can all be fulfilled simultaneously. The inspected selector chooses within result groups; it is not a stock-consuming, cross-order assignment solver. Reservation/allocation belongs in a separate verified workflow. [S4, S5, S8]

## 4. Concurrency and storage boundaries

- The active master uses **forked Node child processes**, through `Util/ProcessRouterParent` and the resolved Storewolf-Libs implementation. It is not merely `Promise.all` pretending to parallelize CPU work. [S3, S10]
- One category child owns a `SKUTransformer`; request results travel through serialized IPC and named SharedMaps. `SharedMap` is backed by **LMDB**, not a plain JavaScript `Map`, and supports views/wait/drop operations. [S10]
- FBE files persist configurations and forward/reverse index structures; per-category SQLite holds queried transformation weights. These are distinct storage roles. [S6]
- Worker/pool files and alternative WeightGetter implementations exist, but filenames do not establish that the audited path uses them. In the checked creation path `skuTransformerPool` is assigned the instance itself; the master/process-router path is the active partition boundary. [S4]
- SharedMap result transport assumes the store is reachable by participating processes. This is not evidence of a stateless, arbitrarily distributed service design. A multi-host deployment was not examined.

## 5. Findings and prioritized remediation

All findings below are registered under **WI-10001436** as audit findings, not implemented fixes. Priorities describe potential impact, not measured production incidents.

### F1 — High: standalone save can destroy the prior artifact before failing

`saveTransformerToFileFBE({name})` removes the existing model directory, recreates it, then evaluates undeclared `transformerName` and `rankifierName`. The isolated probe observes `rm → mkdir → ReferenceError`, with file operations intercepted. The master-side `saveToFileFBE` implementation is also commented out. [S11]

**Impact:** invoking this wrapper against a real existing artifact is unsafe. This does **not** establish that normal category compilation fails; that uses `SKUTransformer.saveToFileFBE`.

**Proposed fix/guard:** one supported save contract; write a new version to a temporary location, validate it, then atomically switch the active model. A failure-injection test must prove the old artifact remains usable.

### F2 — High: missing weight rows can attach a cost to the wrong path

`getWeightsFromTos` returns only `weight`, ordered by requested-pair CASE positions, then packs returned rows by array offset. If a requested pair has no SQLite row, later rows shift left. `queryPathRoarings` assumes `allWeights[i]` belongs to `allPathsArr[i]`. The real in-memory SQLite probe requests `[(0,0),(1,1)]` with only `(1,1,77)` present; weight 77 appears at offset 0. A complete-row positive control preserves order. [S5, S6]

**Impact:** a missing-row integrity failure can become an incorrect cost, not just a missing candidate. Missing rows in the live database were not measured.

**Proposed fix/guard:** return both keys with every weight; join by `(fromIndex,toIndex)` or explicit request ordinal. Reject/mark missing pairs. Test a missing first/middle/last row, duplicates, and batch boundaries.

### F3 — High: category failure is indistinguishable from an empty result

The master's per-category `catch` logs and continues, returning a normal response without failed-category metadata. A rejected child query in the probe yields an empty `TO.SKU`, `totalPathCount:0`, and no error. Separately, `queryWithInstockInventory` catches a thrown Synchronizer call and continues with its initially empty object. [S3, S7]

**Impact:** partial coverage can look like “no stock/no alternatives.”

**Proposed fix/guard:** fail the request or return explicit `partial`, successful/failed categories, and retryable errors. Add one-failed-shard and all-failed-shards tests with positive success controls.

### F4 — High: process RPC has no child-exit settlement

The resolved process router retains successful request callbacks. Its child-exit listener only logs; it does not reject pending requests. The fake-child probe confirms both retention after success and non-settlement after an emitted exit. [S10]

**Impact:** category failure can hang a caller; retained callbacks grow across requests. No production leak magnitude was measured.

**Proposed fix/guard:** delete callback entries on settlement, track child ownership, reject pending work on exit/disconnect/send failure, and enforce bounded request deadlines. Test success, error, exit, duplicate replies, and cancellation.

### F5 — Medium: paired-drive comparison is asymmetric

`compareHardDrives` considers direct and swapped drive pairing. Its positive branch repeats `possibility1 == -1` instead of checking `possibility2 == 1`. The probe finds:

```text
['250SSD','1000SSD'] vs ['2000SSD','500SSD'] → -1
['2000SSD','500SSD'] vs ['250SSD','1000SSD'] → undefined
```

The reverse should be `+1` for this synthetic dominance case. [S2]

**Proposed fix/guard:** correct the branch; property-test reversal symmetry, slot permutation, equality, and genuinely incomparable pairs. Regenerate affected indexes after a comparator change.

### F6 — Medium: a convenience-query response branch calls missing `inflate`

`TransformerInterface.inflate` is commented out; the checked base interface supplies no such static helper. `queryWithInstockInventory` still calls it on the branch outside `combine && bySource && res.ALL`. The isolated method probe reaches a TypeError. [S7]

**Scope qualification:** the checked OrderProcessor default takes the `combine:true, bySource:true` branch instead. Do not infer every order-sourcing request fails.

**Proposed fix/guard:** settle one response contract for object/shared-map formats and implement it at a single boundary. Exercise combined, per-source, empty, and error responses through the real interface.

### Additional source-level risks; not production-confirmed defects

- **Model coherence:** detailed query enrichment checks some recomputed costs against stored weights, but several “not transformable” checks only log. The inspected load/save flow does not establish an atomic manifest binding rules, source version, FBE data, and SQLite weights. [S4, S6]
- **Resource bounds and count semantics:** candidates are materialized before sorting/selection. Above 100,000 paths, SKUTransformer strips requested detail and reduces returned alternatives. `totalPathCount` is incremented before later selection/culling, so it is **not the final response length**. This is source-derived, not a load benchmark. [S4, S5]
- **Partition completeness:** series traversal and hardcoded splits should be checked against an unpartitioned reference on a bounded dataset; current review does not prove all permitted cross-series transformations remain reachable. [S3]
- **Test discoverability:** this submodule's package test script is the placeholder that exits with “no test specified.” Its `Tests` directory contains saved requests/results rather than a directly wired local test runner. That does not prove the parent project has no tests. [S12]
- **API evolution:** commented helpers, alternative pool paths, and methods expecting richer SharedMaps need a supported-contract inventory before promising that every exposed helper is usable.

## 6. Interview-ready explanation

### About 90 seconds

> “Storewolf sells products with many configurations, especially computers. The interesting problem is that the item a customer requests isn't always the exact item we need to source. An available machine might already exceed the requested specification, or it might satisfy it after an allowed RAM or storage change.
>
> Transformer models that as a rule-based compatibility and cost problem. It separates whether one configuration is technically comparable from whether there is a valid fulfillment transformation. Some configurations are incomparable—for example, better RAM but worse storage—so a single score isn't enough.
>
> The expensive part is compiled ahead of time. We partition configurations, evaluate the relevant relations, and store compact forward and reverse indexes using integer IDs and bitmaps. At query time we combine those indexes with inventory quantity, source cost, condition, location, and handling constraints. We can then return the cheapest modeled alternatives along with the changes that explain them.
>
> Category work is isolated into child processes; persisted indexes and SQLite weights avoid rebuilding the model on every query. The trade-off is maintaining consistency between the compiled model and live rules. The engineering improvements I'd prioritize are atomic model publication, keyed weight lookups, and explicit partial-failure reporting. And I would distinguish finding a cheap option from globally allocating stock across multiple orders.”

Use “I designed/implemented…” only for components you actually owned. The code alone cannot establish personal attribution, revenue uplift, production scale, or historical reasons for every choice.

### Likely follow-up questions

**Why not query the product table directly?**  
Because feasibility is not just equality on product columns: custom comparisons, allowed physical changes, condition/location/handling, and source costs all matter. Precomputation moves repeated domain-rule evaluation out of the online path. A relational implementation could still be viable; this is a trade-off, not proof SQL cannot solve it.

**Is this Dijkstra or a shortest-path graph engine?**  
No. The inspected property upgrade lookup uses direct adjacency/edge weights. The online layer enumerates indexed source-to-target pairs, filters them, and selects within groups. Calling it a generic shortest-path planner would overstate the implementation. [S2, S5]

**Why two Rankifiers?**  
Comparison and fulfillment cost are different relations. The goodness index supports better/worse queries; the cost index supports feasible transformations with modeled weights. [S4]

**What does “cheapest” guarantee?**  
Minimum modeled final cost among the candidates considered in a result group under the requested rules—subject to the implementation risks above. Not optimal allocation across all orders, and not a guarantee that the model includes every real-world cost.

**How does it scale?**  
The design partitions pair evaluation, uses compact indexes, and moves categories to child processes. Compilation still has pairwise work within partitions, and online candidate materialization can be large. Quote measured workload, memory, latency, and dataset size only after benchmarking; this audit supplies no production performance numbers.

**How would you test it properly?**  
Build a small brute-force reference evaluator; compare indexed results to it across rule sets. Add comparator algebra tests, exhaustive tiny-world `Any`/`All` cases, weight-join integrity tests, model-version mismatch rejection, and injected child failures. Validate actual end-to-end response formats without live commerce side effects.

**What would you change first?**  
Protect saved artifacts, fix keyed cost association, and stop representing shard/process failures as valid emptiness or indefinite waits. Then measure and address model coherence, partition completeness, and query resource bounds. These are proposals, not changes made by this audit.

## 7. Source index

`T` = `~/storewolf-central-server/Services/Transformer`  
`A` = `~/storewolf-central-server`  
`L` = resolved `~/Storewolf-Libs`

| Ref | Primary source locations |
|---|---|
| S1 | `T/Transformer.js:420–558`, `573–633`, `1365–1430` — lifecycle, rules, query interface |
| S2 | `T/SpecObjComparator.js:59–88`, `540–611`, `773–848`, `813–825`, `1038–1256`, `1268–1464`; `T/ComparatorConfigs/Computer.js:10–43`, `128–157` — comparisons, direct upgrade edges, costs and condition policy |
| S3 | `T/SKUTransformerMaster.js:32–74`, `149–215`, `262–310`, `383–637`, `696–745`; `T/SpecObjComparator.js:335–385` — partitioning, child load/query, partial errors |
| S4 | `T/SKUTransformer.js:55–117`, `360–381`, `666–718`, `755–815`, `983–1037`, `1099–1157`, `1197–1202`, `1240–1327`, `1475–1611` — compilation and online policy |
| S5 | `T/Rankifier.js:196–271`, `286–374`; `T/RankifierFunctions.js:780–947`, `1188–1421` — grouped indexes, filtering, ranking and stats writer |
| S6 | `T/SKUTransformer.js:201–298`, `386–505`; `T/Rankifier.js:79–152`; `T/WeightGetterByCategoryGroup.js:28–68`, `165–175` — FBE/SQLite persistence and keyed-weight risk |
| S7 | `T/Transformer.js:75–100`, `903–1033`, `1072–1102`; `A/Services/OrderProcessor/OrderProcessor.js:62–87`, `656–673`; `A/lib/StoreWolfInterface.js` — inventory wrapper and actual order caller |
| S8 | `T/Transformer.js:54–72`, `1542–1574`; `A/Services/Synchronizer/Synchronizer.js:2427–2450` — expansion and downstream responsibilities |
| S9 | `T/SKUTransformerMaster.js:414–485`; `T/SKUTransformer.js:703–718`, `827–883` — DataStore/ASIN/UPC normalization |
| S10 | `T/SKUTransformerChild.js:1–9`; `A/Util/ProcessRouterParent.js:1–25`; `L/ProcessRouterParent.js:14–70`; `L/ProcessRouterChild.js:11–31`; `L/SharedMap.js:18–59`, `89–134` — actual process and LMDB boundaries |
| S11 | `T/Transformer.js:383–405`; `T/SKUTransformerMaster.js:256–261`; `T/SKUTransformer.js:201–234` — defective save wrapper versus normal category save |
| S12 | `T/package.json:5–8`; `T/Tests/ExamplePayloads`; `T/Tests/TestData` — local test contract and sample data |

## Verification and limits

Run from the Papercusp report repository:

```sh
node --test docs/reports/storewolf-transformer-audit-2026-09-14/audit-probes.test.cjs
```

Ten focused checks cover four positive controls and six defect characterizations. The initial run had one incorrect audit-fixture expectation (`undefined` versus actual `0` for the failed-category path count); it was corrected to match the writer and observed result, not by changing application behavior.

The evidence record contains the final run result and diagram validation. The SVG is a locally generated report asset, not an externally published page. Public documentation searches returned no usable content and were not used as evidence.

**Not exercised:** production startup, real persisted-model roundtrip, native Roaring/FBE behavior under a full model, live inventory freshness, real IPC/LMDB concurrency, full application RPC/auth, exhaustive partition correctness, deployment state, and load/performance. Remaining risks stay open; completion of this audit is not completion of their remediation.
