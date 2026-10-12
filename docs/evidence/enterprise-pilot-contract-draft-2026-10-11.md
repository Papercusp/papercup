# Enterprise pilot contract — preparation draft

11 October 2026 · P-003 / WI-10007898 · `papercusp-enterprise-readiness-roadmap-2026-10-09`

Status: **prepared for buyer discovery; not an approved pilot or a completed P-003**. Avi's continuation directive authorizes engineering work through verified shipment; it supplies no customer interview, customer acceptance, certification, contractual approval or funded customer allowance. P-002 remains a prerequisite. No prospect has been contacted through this work.

12 October continuation: roadmap D-008 selects the support-to-engineering handoff, Slack, one allowlisted workspace and current-build qualification as the internal engineering profile. Avi's full typed direction is `session_turn:codex:01a130a1-42a3-74a3-bf78-e6ae93d51d07:18` (file-backed origin unknown/unenrolled). Independent source preparation proceeds under WI-6554700010009188; actual buyer discovery, IdP setup, trial, legal/security approval and final qualification remain required. Strategy-choice waiting no longer parks engineering preparation.

The first identity unit reuses the existing signed WorkOS receipt, ordered entity cursor, `external_identities`, local membership and session-closure surfaces. Directory bindings use provider `workos-dsync` and the JSON tuple `[external_organization_id,directory_id,directory_user_id]`; an approved group binding is the local identity profile's `authorized_directory_groups` array. Provider emails, names and roles do not bind or grant access. The adapter acts only on active bound identities and closes the matching organization membership's sessions.

Directory binding administration is prepared under WI-6554700010009205. An authenticated active WorkOS organization owner/admin uses `PUT /api/hosted/organizations/:organizationId/members/:userId/directory-binding` with `{externalOrganizationId,directoryId,directoryUserId,authorizedGroupIds,purpose}`. The path organization must match the session, the external organization must match the local organization's WorkOS reference, and the target must already have a local organization membership. Group IDs are explicit opaque directory group identifiers, with at most 100 per binding; an empty array authorizes only directory-user revocation. The server never consumes provider email or role fields to link identities or grant privileges. Directory coordinates must come from the organization's supported IdP setup; this endpoint does not discover or attest that setup.

The same path accepts `DELETE` with `{externalOrganizationId,directoryId,directoryUserId,purpose}`. Removal keeps an inactive identity reference and audit history, clears its authorized groups, and prevents later assignment or automatic reactivation through this endpoint. `PUT` updates groups only for the same immutable subject and local user. Both operations recheck administrator authority inside the database transaction and append actor, purpose and old/new mapping evidence atomically. They do not alter local roles or membership status, revoke an existing membership by themselves, or complete full P-004, actual IdP qualification, access review, or customer acceptance.

Directory access-review export is prepared under WI-6554700010009269. An authenticated active WorkOS organization owner/admin posts `{purpose}` to `/api/hosted/organizations/:organizationId/members/access-review`. The path organization must match the session; the transaction rechecks the active organization, current actor role, membership and user lifecycle before exporting. The JSON download includes local membership roles/status, user lifecycle, derived effective permissions, and that organization's approved immutable directory coordinates/groups. It excludes email, arbitrary identity profiles and directory references from other organizations, even when a person belongs to both. Inactive users or memberships have no effective permissions in the review.

The export labels its scope `local-memberships-and-directory-bindings`; it is not a census of workspace/tool grants, an IdP attestation or a completed access-review process. It uses one database statement for the exported membership snapshot, includes its generation timestamp, and records actor, purpose, population count and scope in append-only organization audit before returning success. Responses use `Cache-Control: no-store`. More than 1,000 members or 100 directory identity references per member causes a conflict rather than a silently truncated review; malformed bindings or audit failures fail closed. This unit adds no role authority, member mutation or periodic schedule and does not complete P-004/customer qualification.

Authority: roadmap Decisions D-002, D-003, D-006, D-007 and D-008. Source continuation: `session_turn:codex:01a12cd3-b523-79e0-a48b-f6e045265f67:8`. The [buyer-discovery packet](enterprise-buyer-discovery-packet-2026-10-09.md) and [capability/reuse census](enterprise-capability-reuse-census-2026-10-09.md) remain the evidence inputs. This document adds a concrete implementation and qualification contract without closing discovery or changing the roadmap's requirements, dependency graph or acceptance rubric.

## Product shaping and proposed first journey

Audience hypothesis: a developer-tools or infrastructure company whose support and engineering teams repeatedly reconstruct issues from Slack and repository context. The engineering/support lead is the proposed buyer; IT/security, the department reviewer and finance have distinct approval responsibilities. None is recruited or committed.

Problem hypothesis: preparing an engineering handoff consumes repeated searching, review and rework. Proposed outcome: a reviewer accepts a cited problem summary, reproduction or next-action checklist and suggested responsible role from a permission-authorized support case. The buyer must establish frequency, representative cases, current effort, accepted output and willingness to pay before these become validated requirements.

Proposed journey:

1. An employee selects an explicitly allowed source case inside one pilot workspace.
2. The workflow reads only context the employee and organization permit; current source permissions are checked at disclosure time.
3. It prepares a cited handoff with source references, uncertainty, proposed next actions and measured cost. Sensitive content remains inside the selected processing contract.
4. A distinct department reviewer accepts, rejects or requests rework. Review time and the reason are recorded alongside the case.
5. An authorized administrator can revoke access, stop the workflow, inspect the action evidence and restore the previous approved workflow version.

The initial workflow prepares and reviews output. Customer replies, issue assignment, source-system writes, code changes and production actions require a separately defined sensitive-action scope and approvals. This boundary does not waive the roadmap's separation-of-duties requirement: P-006 still exercises a named sensitive action in a controlled qualification environment.

## Proposed release boundary and decisions to bind

The smallest first profile reuses the existing Slack organization connector, hosted identity and local grants, policy/approval machinery, budget reservations and audit/disclosure ledgers. A selected buyer can replace the connector or require a private deployment; that changes the contract and estimates before implementation.

| Choice | Proposed engineering default | Evidence or decision still required |
| --- | --- | --- |
| Segment and workflow | Developer-tools support-to-engineering preparation | Attributable buyer discovery and accepted case/output definition, P-002 |
| First connector | Existing Slack organization adapter; repository context only where separately authorized | Actual source systems, permissions, freshness and write requirements |
| Directory | Extend the existing WorkOS verified-receipt/local-grant path | Named supported IdP, group-to-local-role mapping and delegated administrator |
| Hosting | Qualify one exact candidate/current-build profile first | Buyer selects hosted versus customer-cloud profile, region and allowed providers |
| Data scope | One explicitly named pilot workspace and allowlisted sources | Classified stores, approved inference/embedding/log/backup routes and retention |
| Employee authority | Read allowed sources and prepare a handoff | Authorized employee/reviewer principals and any sensitive execution action |
| Pilot population | At least 30 comparable cases; at least three independent design partners remain required by the roadmap | Real organizations, authorized contacts and approved trial records |
| Workflow version | One approved plan/recipe/template version with rollback | Version identity, promotion authority and reviewer acceptance |
| Support | Bounded setup and named incident escalation | Accountable support owner, coverage, commercial/legal terms and recovery objectives |

The broader roadmap retains P-013 through P-021. This draft neither drops them nor represents them as implemented. Any advanced control the selected buyer requires becomes a prerequisite to its trial and integrated release qualification. Full finance, additional connectors, MDM, private networking, key custody, legal hold and independent assurance each require their own scoped evidence.

## Threat, authority and processing contract

The supported profile must name the employee, organization administrator, department reviewer, sensitive-action approvers, service identity, operator and external provider. Provider identity alone never grants local privileges. Organization/department/workspace policy is inherited through the existing enforcement boundary; a lower scope cannot grant authority denied by its parent.

Every transport and backend used by this profile must be enumerated before a universal policy claim. The release evidence must include a permitted journey and attempted override, group removal, user deactivation, expired exception, expired grant, replay, self-approval and unauthorized source disclosure. The proposed access-closure target is 60 seconds from accepted revocation to denied access; the buyer and actual implementation must establish the final bound and its measurement before qualification. This is not a statement of current runtime behavior.

| Processing path | Contract to record | Qualification evidence |
| --- | --- | --- |
| Source read and stored copy | Source owner, ACL/mapping identity, source version, revocation and delete treatment | Allowed and denied users; permission change, deletion and stale/replayed events |
| Search and embeddings | Stores, provider/region, authorization filter and deletion behavior | Restricted-content canaries, current ACL checks and permitted retrieval |
| Model inference | Approved provider/model/region and outbound disclosure policy | Permitted processing plus attempted forbidden provider/egress path |
| Workflow output and audit | Audience, redaction, action/policy/version references and retention | Accepted and denied action correlation; secret canary and export access denial |
| Logs and telemetry | Allowed metadata, redaction, access and retention | Declared secret-canary population, export replay/deduplication and recovery |
| Backups and restores | Location, access/key custody, retention, deletion/hold conflicts and restored authorization | A qualified restore and offboarding exercise on the exact candidate profile |

Customer-cloud and vendor-hosted deployments have different threat models. A sealed BYOC channel can protect content in transit through the control plane; an operator of a vendor-hosted VM can access its live workload. Encryption does not establish a model provider's processing policy or a legal compliance claim. Record those properties separately.

Unselected provider, store, region, key lifecycle, private-network path or source system remains **unknown or outside the selected profile**, never implicitly supported. Export/delete/restore receipts must declare their exact store population, exclusions and hold conflicts.

## Proposed success, cost and stop criteria

These thresholds are planning hypotheses from the discovery packet plus explicit engineering proposals. They are not customer-approved targets, observed results, a price, a purchase authorization or an SLA.

| Measure | Proposed acceptance contract | How the trial records it |
| --- | --- | --- |
| Comparable cases | At least 30 eligible cases with matched baseline and exclusions explained | Per-case provenance, input/output, reviewer decision and baseline category |
| Useful output | At least 80% accepted outputs | Accepted/eligible denominator; rejections and missing decisions remain visible |
| Review effort | Median reviewer time at least 30% below comparable baseline | Recorded paired baseline and trial time; missing human measurements remain unknown |
| Repeat use | Report repeat use and rework separately | Dated authorized trial observations; no threshold invented after the result |
| Access closure | Proposed 60-second upper bound after accepted revocation | Recorded start/end and final deny across every selected transport |
| Spend | A buyer/finance-funded finite allowance; no unbounded overages or continuing liabilities | Reserve/admit/refuse evidence and distinct model, hosting, subscription and review costs |
| Recovery | Buyer-selected RTO/RPO and a successful restore exercise | Exact artifact/profile, timestamps, recovered state and authorization/data checks |
| Operations | Named setup/support/incident owner and finite exposure | Admin setup time, incidents, support effort and unresolved prerequisites |

Stop immediately on an unauthorized action, source-ACL breach or restricted-content canary disclosure. File and own remediation, verify it and re-authorize the trial boundary before resuming. Stop or narrow if costs exceed the finite funded boundary, an unknown retained liability cannot be bounded, or a required connector, deployment, legal, security or support prerequisite cannot be met. A missing bill, reviewer measurement or customer response does not become zero cost or acceptance.

## Reuse seams and implementation sequence

The existing census establishes source seams; source presence alone does not prove supported runtime behavior. The identity receipt adapter and budget policy were reopened on 11 October during this preparation. The remaining links are reuse references from the 9 October census and require current-source/runtime qualification in their implementation lanes.

| Lane | Existing surface to extend | Required qualification |
| --- | --- | --- |
| P-004 identity | [WorkOS receipt projection](../../packages/operator-core/lib/auth/hosted/workos-lifecycle-postgres.ts), existing local access-closure sink | Creation/mapping/removal/deactivation, replay/out-of-order events, forbidden elevation and actual IdP setup |
| P-005/P-006 policy and actions | [Hive policy store](../../packages/operator-core/lib/hive-policy-store.ts), [connected-app enforcement](../../packages/operator-core/lib/connected-apps/enforce.ts), [hosted governance](../../packages/operator-core/lib/auth/hosted/governance.ts) | Inherited policy, backend/transport population, expiry, distinct approvers, delegation and allowed controls |
| P-007/P-016/P-017 data | [Documents corpus](../../packages/operator-core/lib/data-sources/documents-corpus.ts), [disclosure ledger](../../packages/operator-core/lib/personal-vault/disclosure-ledger.ts), [chat retention/holds](../../packages/operator-core/lib/data-sources/chat-retrieval-units.ts) | Exact processing/store population, source ACL and canaries, export/delete/restore and any selected advanced control |
| P-008 evidence | [Operator audit](../../packages/operator-core/lib/operator-audit.ts), [decision ledger](../../packages/operator-core/lib/decision-model-ledger.ts), hosted audit writer | Action correlation, redaction, selected SIEM ingestion, tamper/replay/recovery and access denial |
| P-009/P-014 finance | [Hosted budget policy](../../packages/operator-core/lib/auth/hosted/billing/budget-policy.ts), [reservation store](../../packages/operator-core/lib/auth/hosted/billing/budget-store.ts) | Atomic concurrent parent/child limits, bounded unreconciled/retained liabilities, cost classes and outcome reconciliation |
| P-011/P-013 connectors | [Slack organization connector](../../packages/operator-core/lib/data-sources/slack-org-connector.ts), existing corpus/live-search/admission surfaces | Permission propagation/revocation, deletion, retry/throttling, separate write authorization and selected private reachability |
| P-012 workflow | [Template store](../../packages/operator-core/lib/cupboard/template-store.ts), [recipe capture](../../packages/operator-core/lib/agent-tools/code/capture-recipe.ts), existing plans/approvals/budgets | Employee and administrator journey, department acceptance, version promotion and rollback |
| P-010/P-018/P-019/P-021 operations | [BYOC authorization](../../packages/operator-core/lib/workspace-host/byoc-client-authorization.ts), [sealed channel](../../packages/operator-core/lib/workspace-host/byoc-sealed-channel.ts), existing distribution/backup paths | Exact candidate install/configure/restore/offboard, selected MDM/private network, recovery and actual support commitments |

After buyer discovery, bind the selected scope in P-003. Then run identity → central policy → sensitive-action/data controls → audit/onboarding. Budget work and selected connector preparation can advance independently after scope is bound. The connector, approvals and budgets converge in the departmental workflow; the workflow and onboarding converge in actual partner trials. Integrated acceptance, the concrete rollout decision and exact final shipment follow. This sequence preserves the existing plan dependencies.

## Preliminary implementation estimates

Planning ranges below are engineering estimates, not measured velocity or committed dates. They assume one connector, one IdP, one hosting profile, reuse of the named surfaces and dedicated engineering time. They exclude buyer response time, provider credentials, independent review queues, paid assurance/certification, legal negotiation and customer trial elapsed time. Additional mandatory profiles increase the estimate.

| Work package | Indicative engineer-days | What changes the range |
| --- | --- | --- |
| Buyer evidence intake and final pilot contract, P-002/P-003 | 2–4 after evidence arrives | Quality of baseline, scope and source permissions |
| Directory, inherited policy and sensitive actions, P-004/P-005/P-006 | 12–22 | IdP/group mapping, existing dispatch census and approval semantics |
| Data processing/retention and audit export, P-007/P-008 | 10–20 | Store population, chosen SIEM and restore/delete conflicts |
| Bounded finance, connector and one workflow, P-009/P-011/P-012 | 12–22 | Existing adapter fit, cost reconciliation and reviewer journey |
| Onboarding/recovery and integrated qualification, P-010/P-022 | 8–16 | Candidate profile, operational prerequisites and detector coverage |
| Trial analysis, release decision and final artifact qualification, P-015/P-023/P-024 | 4–8 engineering effort plus external elapsed time | Trial evidence, independent acceptance, actual deployment and rollback |

These ranges are not additive staffing promises and do not authorize a fleet. P-013/P-014 and any selected P-016–P-021 package need a scope-specific estimate. A complete engineering estimate and accountable staffing remain P-003 acceptance work after discovery.

## Evidence and completion contract

Use the existing canonical test framework and ledger. Add real fixture/assertion, hostile or mutation, and permitted-user controls in each implementation lane; a proposed detector filename is not a running detector. Preserve the exact acceptance rubric revision and requirement bindings, and obtain independent meta-vetting plus its separate grading-integrity audit before downstream acceptance proof/cards and final grading.

For operator-API qualification, select `dev:pipeline_position { path, testClass: "operator-api" }`, verify the containing current-build artifact and use the returned route with private test identities/data. The maintained route currently identifies the staging operator on port 3170; its database/workspace is shared, not isolated. Other classes, including background, migration, desktop and candidate-install/upgrade, must use their own returned route. A route marked gap is not executable.

Current-build preparation and qualification do not depend on final green main. Final release evidence does: P-024 must identify the exact served/released artifact, supported install/upgrade, rollout and rollback. Before any LIVE_GATE_OPS action, read ownership and respect the single live operator. No such operation was performed for this draft.

Every final coverage statement must enumerate checked, not checked and not applicable entries, retain explicit unknowns and give each residue an owner. Real buyer/partner acceptance, provider/setup evidence, qualified legal/security/support commitments and shipped-artifact identity remain separate gates. This draft supplies none of those observations.

## Open evidence and immediate continuation

- P-002: a real buyer/contact or dated, permission-approved interview notes identifying one recurring workflow, procurement conditions and buying authority. The existing owner question remains pending.
- P-003: bind the choices above to that evidence, replace provisional thresholds where needed, enumerate required advanced prerequisites and record the concrete implementation boundary.
- WI-10007954: independent exact-current-rubric metaattestation and separate grading-integrity audit. Historical amendment approval and transferred author claims do not satisfy this.
- Later gates: authorized partner trials and acceptance, actual selected IdP/connector/deployment qualification, finance funding, qualified assurance/legal/support inputs and exact final release evidence.

Until these inputs arrive, this is preparation under the existing P-003 work-item. Its blocked status and the roadmap's unshipped status remain accurate. The next action is to incorporate attributable buyer evidence and current independent review, then advance the existing plan; it is not to manufacture discovery or reclassify this draft as shipment.
