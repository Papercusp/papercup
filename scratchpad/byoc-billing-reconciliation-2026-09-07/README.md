# R4/R5 provider billing observation

Recorded 2026-09-07 around 15:00 UTC under WI-10000392; related producer follow-up WI-2144021.

Source: the authenticated Google Cloud Billing Reports page for the existing canary billing account, reached through the dedicated CDP9333 browser. No credentials are included here. The report was filtered to the exact `papercusp_run_id` values `p018-canary-20260905-r4` and `p018-canary-20260905-r5`, grouped by that same label, with the current-month charge period and all savings included. The page states September 1–7, 2026 for observed usage; its chart period extends through September 30. Forecast values were not used.

`r4-r5-report.csv` contains the downloaded provider CSV. The original download is `/tmp/byoc-desktop-b.fExZCD/billing-r4-r5.csv` (SHA-256 `61daf4b6fa9fe5e51808488922f046538ccfd00828f7c128303ecba884d1c1bd`). A screenshot of the filtered report is `/tmp/byoc-desktop-b.fExZCD/billing-r4-r5-report.png`.

| Run | Reported list cost, USD | Other savings, USD | Unrounded net subtotal, USD |
| --- | ---: | ---: | ---: |
| r4 | 0.01 | -0.01 | 0.000000 |
| r5 | 0.00 | -0.00 | 0.000000 |

The gross/list-cost and savings columns are rounded to cents even in this export. The six-decimal column is the **net subtotal**, not unrounded gross usage. Therefore r4 has reported positive usage offset by savings; r5's displayed gross zero does not establish an exact zero usage charge. Neither row establishes that further delayed provider adjustments cannot arrive.

This advances the prior “no provider report extracted” state. It does not claim that the persisted deferred-spend obligations have been finalized. The current `WorkspaceHostSpendSettlement` type accepts only `status: "deferred"`; the teardown runner records that obligation, while `lateObservedSpend` is an appendable provider-evidence input to the canary ledger. A fabricated `status: "settled"` or replaying a destroy operation is not a valid reconciliation path. Keep the original teardown/orphan evidence intact.

## Exact provider amounts recovered

Subsequent authenticated report reloads exposed the source query and its typed response. The `BillingData` operation queries `cloud_billing_data.public.costs.v2`; the request aliases `usage_cost AS usageCostMicros` and the savings/subtotal columns likewise. Both the chart and table query independently returned the same run-scoped amounts. The selected query metadata and raw integer strings are preserved in `provider-micros.json`, without authentication or tracking data.

| Run | Gross usage, USD | Other savings, USD | Net subtotal, USD |
| --- | ---: | ---: | ---: |
| r4 | 0.008651 | -0.008651 | 0.000000 |
| r5 | 0.001001 | -0.001001 | 0.000000 |

Amounts divide the provider's micros by 1,000,000. The original CSV remains unchanged: its rounded r5 gross zero concealed a real sub-cent charge. The gross-precision gap is now resolved. Neither this query nor the CSV asserts that future delayed adjustments cannot occur.

Still required: define the existing ledger's supported post-teardown reconciliation path under WI-2144021 and attach the per-run provider evidence through that path. Do not silently replace provisional zero spend with net-after-credit zero or mark the persisted billing wall resolved from this observation alone.
