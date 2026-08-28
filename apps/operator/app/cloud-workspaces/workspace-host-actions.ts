/**
 * The mutation seam for cloud workspace hosts.
 *
 * Extracted from `page.tsx` so the rail's three stages can each dispatch
 * through ONE typed surface instead of re-declaring arg shapes. The wire
 * contract is unchanged from the pre-redesign page: the same three REST
 * routes, the same payload shapes, the same typed error surfacing.
 */

import type {
  DestroyDisposition,
  LifecycleAction,
  ProviderTarget,
} from "./workspace-view-model";

export type WorkspaceHostActionArgs =
  | {
      action: "connect";
      target: ProviderTarget;
      label: string;
      credentialRef: string;
      projectId: string;
      serviceAccountEmail: string;
    }
  | { action: "validate-connection"; connectionId: string }
  | {
      action: "provision";
      connectionId: string;
      name: string;
      desired: {
        hostId: string;
        target: ProviderTarget;
        scope: { kind: "project"; id: string };
        region: string;
        zone: string;
        size: string;
        image: { id: string; version?: string };
        data: { volumeGiB: number; encrypted: true };
        provider: {
          network: { mode: "managed" };
        };
      };
    }
  | { action: Exclude<LifecycleAction, "destroy">; workspaceId: string }
  | { action: "destroy"; workspaceId: string; disposition: DestroyDisposition };

export interface WorkspaceHostActionResponse {
  ok: boolean;
  operationId?: string;
  message?: string;
  error?: string;
}

/**
 * Treat the browser/server boundary as untrusted input. In particular, a
 * truthy string or number in `ok` must never be allowed to masquerade as the
 * literal success boolean the mutation seam promises to its callers.
 */
function isWorkspaceHostActionResponse(
  value: unknown,
): value is WorkspaceHostActionResponse {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return (
    typeof record.ok === "boolean" &&
    (record.operationId === undefined ||
      typeof record.operationId === "string") &&
    (record.message === undefined || typeof record.message === "string") &&
    (record.error === undefined || typeof record.error === "string")
  );
}

export const PROVIDERS: readonly {
  target: ProviderTarget;
  label: string;
  scope: string;
  accent: string;
  /** Only GCP has an admission path in this build; the rest are planned. */
  supported: boolean;
}[] = [
  {
    target: "gcp",
    label: "Google Cloud",
    scope: "Project",
    accent: "GCP",
    supported: true,
  },
  {
    target: "aws",
    label: "Amazon Web Services",
    scope: "Account",
    accent: "AWS",
    supported: false,
  },
  {
    target: "azure",
    label: "Microsoft Azure",
    scope: "Subscription",
    accent: "AZURE",
    supported: false,
  },
];

export const DESTROY_DISPOSITIONS: readonly {
  value: DestroyDisposition;
  label: string;
  detail: string;
}[] = [
  {
    value: "snapshot",
    label: "Create a snapshot first",
    detail: "Block deletion until a fresh provider snapshot is durable.",
  },
  {
    value: "backup",
    label: "Use an existing backup",
    detail: "Record the current durable backup as the recovery point.",
  },
  {
    value: "discard",
    label: "Discard recoverability",
    detail: "Permanently accept that no snapshot or backup will be created.",
  },
];

/**
 * Route dispatch is derived from the action, never passed in: connection
 * admission and validation share `/connection`, provisioning has its own
 * route, and every lifecycle verb goes to `/action`.
 */
export async function workspaceHostActionRest(
  args: WorkspaceHostActionArgs,
): Promise<WorkspaceHostActionResponse> {
  const endpoint =
    args.action === "connect" || args.action === "validate-connection"
      ? "/api/workspace-hosts/connection"
      : args.action === "provision"
        ? "/api/workspace-hosts/provision"
        : "/api/workspace-hosts/action";
  const payload =
    args.action === "provision"
      ? {
          connectionId: args.connectionId,
          name: args.name,
          desired: args.desired,
        }
      : args;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const parsedBody = await response.json().catch(() => null);
  const body = isWorkspaceHostActionResponse(parsedBody) ? parsedBody : null;
  if (!response.ok || !body?.ok) {
    throw new Error(
      body?.message ||
        body?.error ||
        `Workspace-host action failed (${response.status})`,
    );
  }
  return body;
}
