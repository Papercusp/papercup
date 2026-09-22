/**
 * Production wiring for {@link createHostedWorkspaceAdmission}.
 *
 * `workspace-admission.ts` owns the ADMISSION ORDERING and its idempotency, and takes every
 * effect as an injected dependency so those properties can be tested without a database.
 * This file is the other half: the real Postgres/DBOS effects, assembled once.
 *
 * WHY THE SQL LIVES HERE AND USES `withWorkspace`. `harness_shared.customer_workspaces` has
 * FORCE ROW LEVEL SECURITY and the control-plane role `harness_app` is NOT `bypassrls`, so
 * the policy added by migration 1193 only admits a statement whose transaction has
 * `app.workspace_id` set. `withWorkspace(id, fn)` is precisely that: it takes the
 * `getOrgPgApp()` (harness_app) pool and sets the GUC for the transaction. Reaching for a
 * bare admin client instead would "work" by BYPASSING the tenant predicate, which is the one
 * property this subsystem exists to preserve (D-368 / WI-10002396).
 *
 * WHY `resolveDesiredSpec` IS A REQUIRED ARGUMENT AND HAS NO DEFAULT. Building a
 * `WorkspaceHostDesiredSpec` requires region/size/image/credentials, and those follow from a
 * product question that is not settled: whether a hosted free signup connects the customer's
 * own cloud account or receives a Papercusp-funded workspace. Defaulting it here would bury
 * that open question inside a plausible-looking constant. Making it required puts the
 * unanswered decision at the wiring seam, where it is visible, instead of at runtime.
 */
import { withWorkspace } from '@papercusp/db-org';
import type { WorkspaceHostDesiredSpec } from '@papercusp/deployment-driver';
import { activeWorkspaceId } from '../../workspace-registry';
import {
  readWorkspaceHostConnection,
  upsertWorkspaceHost,
} from '../../workspace-host/observability-store';
import { workspaceHostSpecColumns } from '../../workspace-host/desired-spec-host-row';
import {
  startWorkspaceHostProvisioningWorkflow,
  type StartWorkspaceHostProvisioningInput,
} from '../../dbos/workspace-host-provision-workflow';
import type {
  HostedWorkspaceAdmissionDependencies,
  HostedWorkspaceBinding,
} from './workspace-admission';

interface BindingRow {
  id: string;
  organization_id: string;
  workspace_host_id: string;
  state: string;
}

export interface DefaultHostedWorkspaceAdmissionOptions {
  /** See the file header: deliberately required, because the product decision is open. */
  resolveDesiredSpec: HostedWorkspaceAdmissionDependencies['resolveDesiredSpec'];
  /**
   * Where a failure to ENQUEUE provisioning is reported. Provisioning is started
   * fire-and-forget (a signup must not block on a cloud VM booting), so without this the
   * rejection would be an unhandled promise rather than an observable event.
   */
  onProvisioningStartFailed?: (error: unknown, context: { hostId: string; operationId: string }) => void;
  /**
   * How the provision is put on the durable queue. Default = in-process DBOS; a process that
   * does not run DBOS (the hosted control plane) passes a DBOS-client enqueuer instead
   * (`dbos/workspace-host-provision-client.ts`).
   */
  startWorkflow?: (input: StartWorkspaceHostProvisioningInput) => Promise<unknown>;
}

export function createDefaultHostedWorkspaceAdmissionDependencies(
  options: DefaultHostedWorkspaceAdmissionOptions,
): HostedWorkspaceAdmissionDependencies {
  const reportProvisioningFailure =
    options.onProvisioningStartFailed ??
    ((error: unknown, context: { hostId: string; operationId: string }) => {
      console.error(
        `[hosted-admission] failed to enqueue provisioning for host ${context.hostId} (operation ${context.operationId})`,
        error,
      );
    });

  const startWorkflow = options.startWorkflow ?? startWorkspaceHostProvisioningWorkflow;

  return {
    controlPlaneWorkspaceId: activeWorkspaceId,

    async readConnection(controlPlaneWorkspaceId, connectionId) {
      const stored = await readWorkspaceHostConnection(controlPlaneWorkspaceId, connectionId);
      // Narrowed to the identity on purpose: the admission port must never handle a
      // provider connection, which carries a cloud credential reference.
      return stored ? { id: stored.id } : null;
    },

    async readBinding(controlPlaneWorkspaceId, workspaceId): Promise<HostedWorkspaceBinding | null> {
      return withWorkspace(controlPlaneWorkspaceId, async (query) => {
        const rows = await query<BindingRow[]>`
          SELECT id, organization_id, workspace_host_id, state
            FROM harness_shared.customer_workspaces
           WHERE workspace_id = ${controlPlaneWorkspaceId}
             AND id = ${workspaceId}
           LIMIT 1
        `;
        const row = rows[0];
        if (!row) return null;
        // NOTE: soft-deleted rows are returned deliberately. The row still occupies the
        // unique identity, so hiding it would make admission attempt an INSERT that can
        // only fail. Liveness is judged by the caller (`state`), not by hiding the row.
        return {
          workspaceId: row.id,
          organizationId: row.organization_id,
          workspaceHostId: row.workspace_host_id,
          state: row.state,
        };
      });
    },

    resolveDesiredSpec: options.resolveDesiredSpec,

    async upsertHost(input) {
      await upsertWorkspaceHost({
        // The spec-derived columns come from the SAME projection the provisioning runner
        // uses, so the row admission writes and the row provisioning later re-writes
        // cannot describe different hosts.
        ...workspaceHostSpecColumns(input.desiredSpec),
        workspaceId: input.controlPlaneWorkspaceId,
        id: input.hostId,
        name: input.name,
        connectionId: input.connectionId,
        // The host is REQUESTED to run and is OBSERVED as not yet provisioned. The
        // provisioning runner re-upserts this row with the same pair when it starts.
        desiredState: 'running',
        observedState: 'provisioning',
        desiredSpec: input.desiredSpec,
      });
    },

    async bindWorkspace(input) {
      return withWorkspace(input.controlPlaneWorkspaceId, async (query) => {
        // ON CONFLICT DO NOTHING + RETURNING is what makes `created` truthful under a
        // concurrent replay: exactly one caller gets a row back, and only that one goes on
        // to enqueue provisioning.
        const rows = await query<Array<{ id: string }>>`
          INSERT INTO harness_shared.customer_workspaces (
            workspace_id, id, organization_id, workspace_host_id, display_name, state,
            created_by_principal_kind, created_by_principal_id
          ) VALUES (
            ${input.controlPlaneWorkspaceId}, ${input.workspaceId}, ${input.organizationId},
            ${input.workspaceHostId}, ${input.displayName}, 'provisioning',
            'user', ${input.userId}
          )
          ON CONFLICT (workspace_id, id) DO NOTHING
          RETURNING id
        `;
        return { created: rows.length === 1 };
      });
    },

    startProvisioning(input) {
      // Fire-and-forget by contract. The connection is re-read here rather than threaded
      // through the port because the port is deliberately credential-free; this is one
      // indexed row on the path that is already about to start a cloud provision.
      void (async () => {
        const stored = await readWorkspaceHostConnection(
          input.controlPlaneWorkspaceId,
          input.connectionId,
        );
        if (!stored) {
          throw new Error(
            `connection ${input.connectionId} disappeared between admission and provisioning`,
          );
        }
        await startWorkflow({
          workspaceId: input.controlPlaneWorkspaceId,
          connectionId: input.connectionId,
          name: input.name,
          desired: input.desiredSpec satisfies WorkspaceHostDesiredSpec,
          connection: stored.connection,
          operationId: input.operationId,
          actorId: input.actorId,
        });
      })().catch((error: unknown) =>
        reportProvisioningFailure(error, { hostId: input.hostId, operationId: input.operationId }),
      );
    },
  };
}
