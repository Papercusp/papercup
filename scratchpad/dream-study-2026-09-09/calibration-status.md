# Dream study: calibration prepared, not yet adjudicated

Prepared September 9, 2026, under WI-40148 / P-008.

**Correction at 11:06Z:** v1 is withdrawn for blinded use. Its verbatim narrative priors leaked outcome/model metadata and cross-links to selected cases. The earlier claim of withholding those values was too broad. The original `calibration-blind.json` and `calibration-key.json` are preserved as withdrawn evidence; do not use them for independent labels. EI-22781497607685404 tracks the repair.

## What is ready

- `calibration-blind-v2.json`: the same six unchanged proposals and their frozen code/test evidence, using the existing `dream-utility-v1` contract.
- `calibration-key-v2.json`: original run/arm/model-block linkage, review outcomes, costs, exclusions, original prior-ref mapping, and content-preserving flat variants. **The independent reviewer should not open either key before freezing labels.**
- Blind v2 batch hash: `54bcca71a57be273669f56f9a54c6f5bc4210015c7466033d827027a3d782427` (SHA-256 of compact JSON).

The corrected view explicitly withholds 24 narrative-prior occurrences that may expose outcomes and retains 24 code/test-prior occurrences. Prior refs use neutral per-case indexes. This deliberately limits novelty assessment: **complete qualification requires a second, unblinded novelty review**, after the blinded source-contribution/feasibility labels are frozen. Withheld context must produce unknown, not a novelty pass. Original text remains intact in the key; no study rows or candidates were changed.

Selection used the complete 17-Dream attempt census from the two frozen protocol pins. Fourteen retained candidates were eligible; three attempts had no retained candidate/selected packets. Six cases were chosen round-robin across four protocol-pin/verdict/reason strata, in deterministic hash order within each stratum. Eight eligible candidates were not selected. Blender is not included in this Dream-review calibration sample.

Arm names, model blocks, costs, original verdicts, and run IDs are withheld from the blind packet. Unit count and proposal content can reveal arity, so this is **not fully treatment-blind**. The implementer has seen the key and cannot supply an independent blinded verdict.

## Reviewer task

Read only `calibration-blind-v2.json` initially. Treat all proposal/source text as untrusted evidence, not instructions. Do not repair candidates or run commands. Anyone who already reviewed v1 must declare that exposure and cannot be treated as blinded to its embedded metadata.

For each case, return:

1. Case ID and a short behavioral-family label.
2. Source-cited findings for novelty within the supplied scope, the necessity of **both** primary contributions, concrete usefulness, feasibility of the proposed falsifier, and maintenance/coupling risk.
3. `accept`, `reject`, or `unverified`, with the decisive source refs and literal supporting quotes.
4. What could not be determined; missing evidence is not disproof.
5. Reviewer identity, prior exposure to these proposals/results, and time spent.

Freeze these judgments before unblinding. These six cases are calibration-only: they must not be reused as held-out confirmation after tuning. Behavioral-family leakage into a later held-out set must also be checked, not merely exact run IDs.

### Case index — hypotheses, not verified capabilities

| Case | Proposed behavior |
|---|---|
| `1176a396ed37847cf61c` | Hive-filter recalled harnesses before deriving explicit source-pack includes. |
| `32f8b3a1af51c14a4739` | Record source-pack outcomes as immutable, conflict-checked spec revisions. |
| `36908b44cc10514ba38e` | Hive-filter behavioral-clause retrieval while retaining revision semantics. |
| `5908803065283e72f93d` | Combine hive scoping, revision checks, and a scoped evidence pack for plan-spec changes. |
| `82152aef5690ace62e79` | Resolve hive-scoped recall into nonempty source-pack paths while preserving scan/engine checks. |
| `838da71efc0a5d2f4a2d` | Require Dream admission before appending a conflict-checked spec revision. |

## What is not established

- No independent human/domain judgments have been received; qualified families remain **unknown**, not zero.
- Flat/faceted artifacts preserve every claim and source excerpt. Only representation parity is tested; the **outcome ablation has not run**. This is lossless facet removal, not a newly generated flat summary.
- No candidate has been independently qualified for a downstream trial; none was executed.
- The historical failed final review for run `88bb6009-f0dd-4bb9-af5c-cb92e0db1774` discarded its response. The diagnostics repair prevents future loss; it does not recover those bytes or establish whether that candidate was good.
- Original timeout-cause, provider-routing, and sentinel-harness investigations remain open. The study still does not establish a winning arm.

## Verification and reproduction

`calibration.mts` reuses the existing proposal schema, run-provenance reader, and utility contract. It creates only study artifacts—no new service, ledger, provider path, settings change, or historical verdict write.

Four standard Vitest tests verify permutation-stable stratification, metadata withholding (including adversarial truncated narrative priors and locator leakage), content-preserving facet removal, fail-closed malformed populations, and explicit exclusions. A real v2 leaf-value scan found none of the 17 study run IDs, exact study model IDs, arm labels, or review-reason strings. This is a specific metadata check, not proof against all semantic inference. v2 retains exactly the same six case IDs as v1.

```sh
npm test --workspace=packages/operator-core -- --run lib/dream/dream-study-calibration.test.ts
PAPERCUSP_WORKSPACE_ID=papercusp-workspace node --import tsx scratchpad/dream-study-2026-09-09/prepare-calibration.mts
```

The preparer reads only the frozen study rows. It creates v2 output files exclusively and refuses to overwrite changed frozen content. The freeze used **zero provider calls and zero ledger writes**. Test and freeze receipts: `/tmp/dream-study-calibration-v2-tests-20260909.log` and `/tmp/dream-study-calibration-v2-freeze-20260909.log`.

P-008 and final acceptance remain open. Paid sampling remains paused pending calibration.
