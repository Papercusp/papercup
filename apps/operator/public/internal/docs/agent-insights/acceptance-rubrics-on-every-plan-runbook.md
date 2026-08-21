# Plan completion — code-truth audit, acceptance grading, and ship verdict
URL: /internal/docs/agent-insights/acceptance-rubrics-on-every-plan-runbook

Runbook for shipping a plan through per-item code-truth audit, incremental citation re-verification, post-implementation rubric vetting, independent grading, the implementer's accept/reject verdict, and the scoped force path.

## The completion contract

A plan is not ready to ship merely because its implementation tasks are terminal. The completion path has two independent evidence families, in this order:

1. the implementer audits every plan item against the actual source tree;
2. the implementer authors and vets a post-implementation acceptance rubric;
3. a non-implementer grades the finished work;
4. the rubric author reads that grading and records an explicit `accept` or `reject` verdict;
5. `plans:set-plan-status { status:'shipped' }` re-verifies the evidence and closes the plan.

The order is intentional. The audit finds code-truth gaps while the implementation is still warm. The rubric is authored afterward against as-built reality. The independent grading supplies the honesty leg that a self-audit cannot.

## 1. Finish or deliberately drop every item

`todo`, `blocked`, and `needs-human` items refuse shipping. Finish the work, or record an intentional departure:

```text
plans:set-status {
  slug:'<plan-slug>',
  item:'P-012',
  status:'dropped',
  note:'<why the plan changed>'
}
```

A dropped item is terminal and does not need code evidence. Departing from the plan is allowed; doing it silently is not.

## 2. Run the per-item code-truth audit

Use `plans:audit` after implementation. Read the code itself—never a work-item, doc, or memory of writing it—and submit only items that are new, reopened, text-changed, or whose evidence changed:

```text
plans:audit {
  slug:'<plan-slug>',
  items:[
    {
      itemId:'P-001',
      verdict:'implemented',
      citations:[
        { kind:'code', path:'packages/example/lib/feature.ts', symbol:'buildFeature' },
        { kind:'test', path:'packages/example/lib/feature.test.ts' }
      ]
    },
    {
      itemId:'P-002',
      verdict:'not-code',
      note:'Investigation conclusion is the durable deliverable.',
      citations:[
        { kind:'doc', ref:'agent-insights/example', reason:'No code artifact exists for this finding.' }
      ]
    }
  ],
  findings:[
    { summary:'Out-of-scope defect', disposition:'filed', ref:'WI-12345' }
  ]
}
```

Only `code` and `test` citations count as verification. Their exact repo-relative paths must resolve; optional `line` must be in range and optional `symbol` must literally exist. `doc` and `none` are explicit declarations of non-verification and are counted as such. A PG-canonical doc citation needs `ref` plus `reason`; `none` needs `reason`. An `implemented` verdict requires at least one resolving `code` or `test` citation. `not-code` and `dropped` require explanatory notes.

Each submitted item stores its own `auditedSha`, `auditedAt`, and item-text hash. Each verifying citation stores a Git-compatible blob SHA. Unlisted items with prior audit history carry forward mechanically with their original provenance; they are not falsely re-stamped by a pass that did not inspect them. An item with no prior audit remains uncovered.

At ship time the gate folds the newest audit entry per item across all passes. It rechecks only what can have changed: item status, item text, citation resolution, and the cited blob bytes. If `audit_coverage_stale` names items, re-run `plans:audit` for only those items. Do not copy unchanged entries into a new pass. If no items are listed, no new audit pass is required.

Citation roots follow the plan's harness. For sibling-repository path shapes, see [Plans audit citations across sibling repositories](/internal/docs/agent-insights/plans-audit-sibling-repo-citations).

## 3. Author and vet the acceptance rubric

After the audit is clean, author the as-built definition of done:

```text
rubrics:propose {
  rubricRef:'<acceptance-rubric-slug>',
  kind:'acceptance',
  subjectPlan:'<plan-slug>',
  classRef:'plan-class-feature-ship',
  characteristic:'<umbrella-domain>',
  title:'<acceptance title>',
  criteria:[<3-7 outcome criteria tracing to the plan goal and Decisions>]
}
```

Use the class that matches the work: `plan-class-feature-ship`, `plan-class-bugfix`, `plan-class-migration`, or `plan-class-investigation`. A pure investigation may use `criteria:[]` with the investigation class. Add structured checks wherever an outcome is objectively executable.

Vet the rubric's current revision against `meta-acceptance-rubric`: open a `consult:get_feedback` critique, improve the rubric, then emit the meta-scorecard with `subject:{ kind:'rubric', ref:'<rubric-id>' }` and `vettingConsult:'<conversation-id>'`. Any later rubric edit invalidates the attestation. The detailed method is [Acceptance rubric vetting](/internal/docs/agent-insights/acceptance-rubric-vetting).

## 4. Independent grading, then the implementer's verdict

A non-implementer grades every criterion with concrete evidence:

```text
scorecards:emit {
  rubricRef:'<acceptance-rubric-slug>',
  ratings:{ <every criterion key>: { rating, evidence } }
}
```

The grader must differ from the rubric author. After that grading exists, the rubric author reads it and re-emits the complete ratings with the plan-level call:

```text
scorecards:emit {
  rubricRef:'<acceptance-rubric-slug>',
  ratings:{ <every criterion key>: { rating, evidence } },
  acceptance:{
    verdict:'accept',
    reasoning:'<why the independent evidence meets this plan-specific bar>'
  }
}
```

The author owns the passing threshold; there is no universal numeric cutoff. `reject` is a real terminal judgment for that scorecard and blocks shipping until the work or grading is addressed and a newer author verdict is recorded.

The four first-party plan-class rubrics include a citation spot-check criterion. The independent grader should sample the implementer's resolving audit citations rather than trusting the coverage summary alone.

## 5. Ship

```text
plans:set-plan-status { slug:'<plan-slug>', status:'shipped' }
```

A successful ship auto-retires the acceptance rubric.

## Refusal codes and the repair they demand

Code-truth family, controlled by `PLAN_ITEM_COMPLETION_GATE` and `PLAN_CODE_AUDIT_GATE` (both default ON):

* `plan_items_unfinished` — finish or drop the named items.
* `acceptance_unaudited` — run the first code-truth audit.
* `audit_coverage_stale` — re-audit only the named missing/reopened/text-changed/blob-changed items.
* `audit_citations_unresolved` — repair and re-audit only the named broken citations.

Rubric family, controlled independently by the acceptance-rubric gates:

* `acceptance_rubric_missing` — author the post-implementation rubric.
* `acceptance_rubric_unvetted` — critique and attest the current rubric revision.
* `acceptance_ungraded` — obtain a complete non-synthesized grading.
* `self_graded_only` — obtain a grading from someone other than the rubric author.
* `acceptance_not_recorded` — the author must record the post-grading accept/reject call.
* `acceptance_rejected` — address the rejection, then record a newer verdict.

## Forced shipping is scoped and loud

`plans:set-plan-status { status:'shipped', force:{ reason:'...' } }` may waive only the four code-truth checks. It does not waive rubric existence, vetting, independent grading, or the author's acceptance verdict. Every waived check, reason, actor, and time is appended to the plan's permanent `forcedPast` marker and returned by plan reads. Use force to record a deliberate exception, never to disguise one.

## What the mechanics prove—and what they do not

The citation resolver proves that a cited path exists at audit and ship time, optional line/symbol anchors resolve, and cited bytes did not move unnoticed. It does not prove that a real file actually implements the item. That remaining semantic judgment is why the independent grader spot-checks citations and why the author must explicitly accept or reject the grading.

Audit verdicts record findings; they do not independently block shipping. Item lifecycle is the blocking truth: in-scope gaps must be fixed or the item deliberately dropped with a reason. Out-of-scope findings never make a plan uncloseable, but a `filed` finding must name the work-item that owns it.
