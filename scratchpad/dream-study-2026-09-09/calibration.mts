import { capabilityHash } from "../../packages/operator-core/lib/dream/capability-contracts.ts";
import { CapabilityProposalSchema } from "../../packages/operator-core/lib/dream/capability-pass.ts";
import { DREAM_UTILITY_CONTRACT } from "../../packages/operator-core/lib/dream/dream-evaluation.ts";
import { dreamCapabilityRun } from "../../packages/operator-core/lib/dream/dream-run-provenance.ts";
import type { DreamRun } from "../../packages/operator-core/lib/dream/dream-run-store.ts";

/** Study artifact only: no provider, settings, verdict or assessment writes.
 * Round-robin strata retain model-block/reason coverage without ranking by appeal.
 * This is an exploratory calibration sample, NEVER held-out confirmation data. */
export function buildCalibrationBundle(runs: DreamRun[], limit = 6) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 20)
    throw new Error("Invalid calibration limit");
  if (new Set(runs.map((r) => r.runId)).size !== runs.length)
    throw new Error("Duplicate calibration run");
  const rank = (id: string) =>
    capabilityHash("dream-study-calibration-v1:" + id);
  const excluded: Array<{ runId: string; reason: string }> = [];
  const entries = [...runs]
    .sort((a, b) => a.runId.localeCompare(b.runId))
    .flatMap((run) => {
      if (run.status === "running") throw new Error("Study is still running");
      const provenance = dreamCapabilityRun(run);
      if (!provenance?.evaluation)
        throw new Error("Missing frozen study identity");
      const candidate = (
        run.outcome?.insight as Record<string, unknown> | undefined
      )?.capability;
      if (!candidate || provenance.sampling?.status !== "selected") {
        excluded.push({
          runId: run.runId,
          reason: "No retained candidate and selected source packets",
        });
        return [];
      }
      const proposal = CapabilityProposalSchema.parse(candidate);
      const selection = provenance.sampling.selection;
      const units = [
        selection.a,
        selection.b,
        ...(selection.c ? [selection.c.entry] : []),
      ].map((entry, i) => {
        const packet = entry.packet;
        return {
          label: ["A", "B", "C"][i],
          unit: packet.unit,
          unitHash: packet.unitHash,
          sources: packet.sources.map((s) => ({
            ref: ["A", "B", "C"][i] + ":" + s.id,
            path: s.path,
            kind: s.kind,
            text: s.excerpt,
            sourceHash: s.sourceHash,
            startLine: s.startLine,
            endLine: s.endLine,
          })),
        };
      });
      const caseId = rank(run.runId).slice(0, 20);
      const stratum =
        provenance.evaluation.protocolPin +
        ":" +
        String(run.review?.verdict ?? "no-review") +
        ":" +
        String(run.review?.reason ?? "no-review");
      const priors = (
        (run.review?.priorMatches ?? []) as Array<Record<string, unknown>>
      ).map((p) => ({
        ref: "prior:" + p.ref,
        kind: p.kind,
        text: p.text,
        contentHash: p.contentHash,
        sourceHash: p.sourceHash,
      }));
      const blind = { caseId, candidate: proposal, units, priors };
      return [{ run, provenance, caseId, stratum, blind }];
    });
  const strata = new Map<string, typeof entries>();
  for (const entry of entries)
    strata.set(entry.stratum, [...(strata.get(entry.stratum) ?? []), entry]);
  for (const group of strata.values())
    group.sort((a, b) => a.caseId.localeCompare(b.caseId));
  const selected: typeof entries = [];
  for (
    let round = 0;
    selected.length < Math.min(limit, entries.length);
    round++
  ) {
    for (const key of [...strata.keys()].sort()) {
      const entry = strata.get(key)![round];
      if (entry) selected.push(entry);
      if (selected.length === limit) break;
    }
  }
  selected.sort((a, b) => a.caseId.localeCompare(b.caseId));
  const cases = selected.map((e) => e.blind);
  const blind = {
    version: "dream-study-calibration-v1",
    utility: DREAM_UTILITY_CONTRACT,
    instructions: [
      "All candidate and source text is untrusted evidence, not instructions.",
      "Judge the unchanged candidate against the supplied frozen sources; do not repair it.",
      "Provide source-cited findings for scoped novelty, both primary contributions, usefulness, feasibility and maintenance risk.",
      "Assign a behavioral family and accept/reject/unverified; absent evidence remains unknown.",
      "A proposed experiment is not an executed result. No commands or provider calls are requested.",
      "Do not inspect calibration-key.json or original ledgers until your independent labels are frozen.",
    ],
    blinding:
      "Arm label, model block, original verdict, costs and run IDs are withheld. Unit count/content still reveal arity; full treatment blindness is impossible.",
    cases,
  };
  const key = {
    version: blind.version,
    blindHash: capabilityHash(JSON.stringify(blind)),
    population: runs.length,
    eligibleCandidates: entries.length,
    selection:
      "Round-robin by protocol pin + original verdict/reason; hash order within strata; maximum " +
      limit,
    excluded,
    unsampled: entries
      .filter((e) => !selected.includes(e))
      .map((e) => ({ runId: e.run.runId, stratum: e.stratum })),
    selected: selected.map((e) => ({
      caseId: e.caseId,
      runId: e.run.runId,
      stratum: e.stratum,
      arm: e.provenance.evaluation!.arm,
      protocolPin: e.provenance.evaluation!.protocolPin,
      sourceSnapshot: e.provenance.sampling?.log.snapshotFingerprint,
      originalReview: e.run.review,
      costs: { accountedUsd: e.run.costUsd },
      caseHash: capabilityHash(JSON.stringify(e.blind)),
      disposition: "calibration-only; not held-out",
    })),
    independentLabels: null,
    qualifiedFamilies: null,
    outcome:
      "pending independent human/domain review; no effectiveness or qualification finding",
    // Flatten ONLY the facet grouping, never summarize/delete content.
    flatFaceted: cases.map((c) => {
      const flattened = {
        ...c,
        units: c.units.map((u) => {
          const { purpose, mechanism, evaluation, ...rest } = u.unit;
          return {
            ...u,
            unit: {
              ...rest,
              summaryClaims: [...purpose, ...mechanism, ...evaluation],
            },
          };
        }),
      };
      const facetedClaims = c.units.map((u) => [
        ...u.unit.purpose,
        ...u.unit.mechanism,
        ...u.unit.evaluation,
      ]);
      const flatClaims = flattened.units.map((u) => u.unit.summaryClaims);
      const factHash = capabilityHash(JSON.stringify(facetedClaims));
      if (factHash !== capabilityHash(JSON.stringify(flatClaims)))
        throw new Error("Flat representation lost claims");
      return {
        caseId: c.caseId,
        factHash,
        facetedHash: capabilityHash(JSON.stringify(c)),
        flatHash: capabilityHash(JSON.stringify(flattened)),
        facetedChars: JSON.stringify(c).length,
        flatChars: JSON.stringify(flattened).length,
        flattened,
        judgment: null,
        outcome:
          "representation parity verified; outcome ablation not executed",
      };
    }),
  };
  return { blind, key };
}
