# Organization legal holds, key shred, rotation and backup retention
URL: /internal/docs/agent-insights/organization-legal-hold-keys-and-backups

P-017e conflict rules: preserve held data and historical backups, audit shred refusal, and distinguish organization artifacts from host snapshots.

## Scope and decision

This is the assumed internal engineering profile of enterprise-readiness D-009/D-010, implemented by P-017e WI-6554700010013233 and decision D-027. It is not evidence of an external customer's retention requirements or assurance certification.

## Organization key shred

An active legal hold wins over a request to crypto-erase the organization. `createOrganizationKeyService().shred` authorizes the actor, checks the confirmation id, and resolves every owned `customer_workspaces.id` plus the explicitly supplied workspace ids. The customer `id` is the data-plane slug; the row's `workspace_id` identifies the hosting control workspace. An empty or incomplete caller scope cannot hide an owned held workspace. Deleted customer-workspace rows remain in the census because their historical content can survive in a backup.

The transaction takes SHARE locks on the customer-workspace mapping and legal-hold tables before its final check. This serializes the check and key destruction against mapping changes and all hold writers, including the low-level `placeLegalHold` writer. The rare destructive transaction performs only local database work while holding these locks; it does not call a KMS. It also locks custody before changing keys.

Any active hold vetoes shred, even if its live retained row counts are zero. Live emptiness cannot prove that a historical backup contains no held content. The refusal commits an `organization.keys.shred_refused` organization audit event containing the workspace and hold identities, source/container and retained counts. Only after that commit does the service throw `OrganizationKeyShredRefusedError` with code `legal-hold-active`, `holdIds` and `auditEventId`. Throwing inside the transaction would roll the refusal audit back, so the transaction returns a refusal and the outer method throws it. Custody, wrapped DEKs and existing backup decryption remain intact. After release the existing confirmed shred path may proceed and its receipt includes the discovered workspace scope.

This guards Papercusp's local key-shred operation. It cannot stop a customer from destroying their KEK directly in their own KMS, or recover such a destroyed external key.

## DEK rotation and held documents

Rotation is allowed: older DEKs become decrypt-only and remain available. The compare-and-swap reseal sweep decrypts the old envelope, preserves its title/text, seals under the new active DEK and rebuilds blind terms. It changes only `sealed_content` and `blind_terms`, so the hold's identity/content protection remains in force. The recurrence test uses a non-chat source document (not a chat-derived exemption), verifies the new envelope opens to the same title/text and that the database still refuses its deletion while the hold remains active.

## Organization backup artifacts

`exportOrganizationBackup` currently produces sealed export streams; this surface has no scheduled artifact store or pruner. `organizationBackupRetentionDecision(scope, activeHolds)` supplies the retention veto that a future artifact pruner must enforce. An artifact with any workspace intersecting an active hold must be kept, including when it may be the only historical copy. This deliberately retains all potentially covered artifacts rather than trying to infer redundancy from live counts. Releasing the last intersecting hold removes only this veto; ordinary age/count retention still decides when to prune.

The caller must obtain fresh `holdConflicts` for the artifact's complete workspace scope immediately before deletion. A cached decision is not a deletion authorization. Host Kopia snapshots and host database-dump rotation belong to a separate backup plane; they do not automatically gain a hold veto from this pure organization-artifact decision. Their integration/scope investigation is tracked separately as EI-25985604292707665 and must retain accountable ownership. `lib/storage/retention-policy.ts` describes host disk policy, not organization artifact pruning.

## Recurrence checks

Use the canonical runner:

```bash
npm run test:file -- packages/operator-core/lib/data-governance/organization-keys.integration.test.ts packages/operator-core/lib/data-governance/organization-backup-sealing.test.ts packages/operator-core/lib/data-governance/organization-document-reseal.integration.test.ts
```

The key test omits the held customer slug from caller input, verifies the committed refusal audit and unchanged custody/DEKs, opens a backup through a cold service, then releases the hold and observes both pruning eligibility and successful shred. The backup unit cases cover intersecting/nonintersecting holds and release. The reseal case proves held non-chat content remains readable and deletion stays blocked. Restore/e-discovery stays on P-017d; receipt-on-persistence work P-017f is separate.
