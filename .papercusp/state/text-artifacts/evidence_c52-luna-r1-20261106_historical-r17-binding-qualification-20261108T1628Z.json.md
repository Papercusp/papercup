---
rel_path: "evidence/c52-luna-r1-20261106/historical-r17-binding-qualification-20261108T1628Z.json"
updated_at: 1794155307606
_body: "content"
---

{
  "schema": "luna-r1-r17-bindings-v1",
  "createdAt": "2026-11-08T16:26:55.638Z",
  "workItem": "WI-6554700010045700",
  "target": "WI-6554700010045908",
  "revision": {
    "id": 84934,
    "seq": 139,
    "contentHash": "befcde988f6e46124fd0c6228b03c413aa2a23fea5da5b48c152fa8d9a953860",
    "actualSHA256": "befcde988f6e46124fd0c6228b03c413aa2a23fea5da5b48c152fa8d9a953860"
  },
  "parser": {
    "path": "packages/operator-core/lib/spec-conformance/conformance-contract.ts",
    "sha256": "db62f8ff4198a461983ca89cce4e27869822ca6022eb5949bb10115a53341bd5"
  },
  "parse": {
    "ok": true,
    "present": false,
    "contract": {}
  },
  "requirement": {
    "barKey": "R-17",
    "title": "The live sync-batch routines judge 95 percent of slots",
    "doneWhen": "executable",
    "doneWhenCheck": {
      "kind": "probe",
      "probe": {
        "kind": "sql",
        "sql": "WITH r AS (SELECT name, COALESCE(metadata->'sync_delta'->'coverage', metadata->'sync_lint_guards'->'coverage', '{}'::jsonb) AS cov FROM harness_shared.routines WHERE workspace_id='papercusp-workspace' AND name IN ('sync-batch-delta-check','sync-batch-lint-guards')), t AS (SELECT r.name, (r.cov ? 'alarmOpenSinceMs') AS alarm_open, EXISTS (SELECT 1 FROM harness_shared.work_items w WHERE w.workspace_id='papercusp-workspace' AND w.condition_key = CASE r.name WHEN 'sync-batch-delta-check' THEN 'sync-delta-coverage-low' ELSE 'sync-lint-guards-coverage-low' END AND w.status NOT IN ('done','dropped','resolved','closed') AND (w.payload->'_conditionUpsert'->>'lastSeenAt')::timestamptz > now() - interval '4 hours') AS alarm_fresh, count(s.slot) AS slots, count(s.slot) FILTER (WHERE s.evaluated) AS ev, count(s.slot) FILTER (WHERE NOT s.accounted) AS unaccounted FROM r LEFT JOIN LATERAL (SELECT floor((e->>'atMs')::numeric / 300000) AS slot, bool_or(COALESCE((e->>'evaluated')::boolean, false)) AS evaluated, bool_or(COALESCE(e->>'status','') <> '') AS accounted FROM jsonb_array_elements(COALESCE(r.cov->'ticks','[]'::jsonb)) e WHERE (e->>'atMs')::bigint > (extract(epoch from now())*1000)::bigint - 86400000 AND (e->>'atMs')::bigint <= (extract(epoch from now())*1000)::bigint GROUP BY floor((e->>'atMs')::numeric / 300000)) s ON true GROUP BY r.name, r.cov) SELECT count(*)::int AS routines, COALESCE(min(slots), 0)::int AS min_slots, COALESCE(min(CASE WHEN slots > 0 THEN ev::float8 / slots ELSE 0 END), 0)::float8 AS min_ratio, COALESCE(sum(unaccounted), 0)::int AS unaccounted_slots, count(*) FILTER (WHERE COALESCE(ev::float8 / NULLIF(slots, 0), 0) < 0.95 AND NOT (alarm_open AND alarm_fresh))::int AS low_without_current_alarm, (CASE WHEN count(*) = 2 AND bool_and(slots >= 276 AND unaccounted = 0 AND (ev::float8 / NULLIF(slots, 0) >= 0.95 OR (alarm_open AND alarm_fresh))) THEN 1 ELSE 0 END)::int AS accounted FROM t;",
        "maxRows": 50,
        "schemaRevision": "projected-tool-registry-v1:c6e029400f58e1d0",
        "expect": {
          "path": "$.rows[0].accounted",
          "op": "eq",
          "value": 1
        }
      }
    },
    "falsifiers": {
      "bound": [],
      "pending": []
    },
    "unenforced": null,
    "status": "executable"
  },
  "applicable": true,
  "problems": [],
  "bindingPopulation": {
    "doneWhen": [
      "R-17:done-when"
    ],
    "bound": [],
    "pending": []
  },
  "sources": [
    "evidence/c52-luna-r1-20261106/historical-r17-qualification-20261108T1632Z.json",
    "evidence/c52-luna-r1-20261106/historical-r17-capture-20261108T1625Z.json",
    "evidence/c52-luna-r1-20261106/historical-r17-deviation-and-falsifiers-20261108T1630Z.json"
  ],
  "findings": [
    "Current canonical parser successfully parses retained revision139 with SHA256 equal to its recorded content hash.",
    "R-17 has exactly one runnable binding R-17:done-when, no bound or pending falsifiers, and no unenforced declaration. No R-17 falsifier result is required by this saved contract.",
    "Saved ledger23523773 passes the sole binding before saved alarm closure; no ledger or event requery was made.",
    "Acceptance wording and SQL implement owner-rescoped slot accounting/current alarms; the old title remains but does not change the parsed check. This is not evidence of 95 percent judged coverage."
  ],
  "disposition": "Historical closure supported against the sole owner-rescoped binding in the saved contract; underlying historical execution/runtime qualification remains limited. Final original R1 remains OPEN.",
  "limitations": [
    "Parser and closure policy are current canonical source, not attestation of the historical loaded runtime.",
    "Ledger commit_sha/configuration_snapshot are null; exact historical probe implementation and raw slot/alarm observations are not retained in this packet.",
    "No durable fix, delivered 95-percent coverage, main/deploy, full R1 or full8R26 acceptance inferred."
  ],
  "constraints": [
    "No fresh tests, source edits, control mutations, live gate operations or peer monitoring.",
    "Completed92 assessments and20 pair qualifications unchanged; all12parent/12loop checks preserved."
  ]
}
