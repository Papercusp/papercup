// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

const H = vi.hoisted(() => ({
  rows: [] as unknown[],
  error: null as Error | null,
  loading: false,
  mutate: vi.fn(),
  invalidate: vi.fn(),
}));

vi.mock("@papercusp/sync", () => ({
  useSyncQuery: () => ({
    data: H.rows,
    error: H.error,
    loading: H.loading,
    fetching: false,
    invalidate: H.invalidate,
  }),
  useSyncMutate: () => H.mutate,
}));

vi.mock("nuqs", async () => {
  const React = await import("react");
  const parser = (defaultValue: unknown = null) => ({
    defaultValue,
    withDefault(value: unknown) {
      return parser(value);
    },
  });
  return {
    parseAsString: parser(),
    parseAsStringEnum: () => parser(),
    useQueryState: (_key: string, config?: { defaultValue?: unknown }) =>
      React.useState(config?.defaultValue ?? null),
  };
});

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("@/app/harness/Select", () => ({
  Select: ({
    value,
    options,
    ariaLabel,
    placeholder,
    disabled,
    describedBy,
  }: {
    value: string;
    options: Array<{ value: string; label: unknown }>;
    ariaLabel: string;
    placeholder?: string;
    disabled?: boolean;
    describedBy?: string;
  }) => (
    <button
      type="button"
      role="combobox"
      aria-label={ariaLabel}
      aria-describedby={describedBy}
      disabled={disabled}
    >
      {String(
        options.find((option) => option.value === value)?.label ??
          placeholder ??
          "",
      )}
    </button>
  ),
}));

vi.mock("@/app/harness/Modal", () => ({
  Modal: ({
    open,
    title,
    children,
  }: {
    open: boolean;
    title: string;
    children: React.ReactNode;
  }) =>
    open ? (
      <section role="dialog" aria-label={title}>
        {children}
      </section>
    ) : null,
}));

import CloudWorkspacesPage, {
  type CloudWorkspacesControlRow,
  workspaceHostActionRest,
  workspaceHostIdFromName,
} from "./page";

const cloudPageCss = readFileSync(
  "app/cloud-workspaces/cloud-workspaces.module.css",
  "utf8",
);

const rows: CloudWorkspacesControlRow[] = [
  {
    kind: "connection",
    id: "gcp-main",
    target: "gcp",
    label: "Production GCP",
    status: "connected",
    credentialRef: "env:GCP_APPLICATION_CREDENTIALS",
    lastValidatedAt: "2026-08-22T05:00:00.000Z",
    provider: {
      projectId: "papercusp-prod",
      serviceAccountEmail:
        "papercusp-host@papercusp-prod.iam.gserviceaccount.com",
    },
    scopes: [{ id: "papercusp-prod", label: "papercusp-prod" }],
    regions: [
      {
        id: "us-central1",
        label: "Iowa · us-central1",
        zones: ["us-central1-a"],
      },
    ],
    sizes: [
      {
        id: "e2-standard-4",
        label: "e2-standard-4",
        vcpu: 4,
        memoryGiB: 16,
        hourlyUsd: 0.08,
      },
    ],
    images: [
      {
        id: "projects/papercusp-images/global/images/ubuntu-2404",
        version: "ubuntu-2404",
        label: "Ubuntu 24.04 LTS",
      },
    ],
    networks: [{ id: "managed", label: "Papercusp-managed private network" }],
    diskPricePerGiBMonth: 0.145,
  },
  {
    kind: "workspace",
    id: "host-1",
    name: "research-control",
    connectionId: "gcp-main",
    target: "gcp",
    scopeLabel: "papercusp-prod",
    region: "us-central1",
    size: "e2-standard-4",
    image: "ubuntu-2404",
    diskGiB: 100,
    network: "default",
    estimatedMonthlyUsd: 72.9,
    desiredState: "running",
    observedState: "running",
    observedAt: "2026-08-22T05:10:00.000Z",
    providerResourceId:
      "projects/papercusp-prod/zones/us-central1-a/instances/research-control",
    endpoint: "ssh://10.0.0.8",
    recoverability: {
      kind: "snapshot",
      label: "snapshot-20260822",
      updatedAt: "2026-08-22T04:50:00.000Z",
    },
    capabilities: {
      start: false,
      stop: true,
      repair: true,
      snapshot: true,
      destroy: true,
    },
    resources: [
      {
        logicalKey: "vm",
        kind: "vm",
        state: "applied",
        providerId:
          "projects/papercusp-prod/zones/us-central1-a/instances/research-control",
        providerRequestId: "request-1",
        attempts: 1,
        updatedAt: "2026-08-22T05:08:00.000Z",
      },
    ],
    health: {
      status: "healthy",
      attestedAt: "2026-08-22T05:09:00.000Z",
      checks: [{ name: "systemd", ok: true }],
      bootstrapVersion: "1.4.0",
    },
    versionDrift: [{ component: "agent", desired: "1.4.0", observed: "1.3.0" }],
    tunnel: { state: "connected", transport: "gcp-iap-ssh" },
    costSignals: [{ estimatedMonthlyUsd: 72.9 }],
    quotaSignals: [{ resource: "CPUS", remaining: 8 }],
    logs: [
      {
        id: "log-1",
        operationId: "op-1",
        observedAt: "2026-08-22T05:09:30.000Z",
        stream: "systemd",
        unit: "papercusp-agent",
        level: "info",
        message: "Agent ready",
      },
    ],
    operation: {
      id: "op-1",
      action: "provision",
      status: "succeeded",
      percent: 100,
      message: "Host attested",
      request: {
        image: "ubuntu-2404",
        credentialRef: "env:GCP_APPLICATION_CREDENTIALS",
      },
      events: [
        {
          id: "evt-1",
          ts: "2026-08-22T05:09:00.000Z",
          phase: "attest",
          status: "succeeded",
          level: "info",
          source: "controller",
          message: "Bootstrap healthy",
        },
      ],
    },
  },
];

beforeEach(() => {
  H.rows = rows;
  H.error = null;
  H.loading = false;
  H.mutate.mockReset().mockResolvedValue({ ok: true });
  H.invalidate.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("CloudWorkspacesPage", () => {
  it("renders provider state, URL-backed provisioning selections, estimate, lifecycle, and progress", () => {
    render(<CloudWorkspacesPage />);

    const pageHeading = screen.getByRole("heading", {
      name: "Cloud Workspaces",
    });
    expect(pageHeading).toBeTruthy();
    expect(pageHeading.closest("main")).toBeNull();
    const posture = screen.getByRole("list", {
      name: "Control-plane posture",
    });
    expect(posture.querySelectorAll('[role="listitem"]')).toHaveLength(3);
    const overview = screen.getByRole("region", {
      name: "Cloud workspace overview",
    });
    expect(overview.textContent).toContain("Connected providers1 / 3");
    expect(overview.textContent).toContain("Managed workspaces1");
    expect(overview.textContent).toContain("1 of 1 desired states aligned");
    expect(overview.textContent).toContain("Healthy hosts1");
    expect(overview.textContent).toContain("Monthly footprint$72.90");
    expect(
      screen.getByRole("heading", { name: "Provider readiness" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: "Validate Google Cloud connection",
      }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: "Amazon Web Services connection is not available",
      }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: "Microsoft Azure connection is not available",
      }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Connect$/ })).toBeNull();
    expect(screen.getByText("Production GCP")).toBeTruthy();
    expect(
      screen.getByRole("combobox", {
        name: "Project, account, or subscription",
      }).textContent,
    ).toContain("papercusp-prod");
    const estimate = screen.getByLabelText("Estimated workspace cost");
    expect(estimate.tagName).toBe("DIV");
    expect(estimate.getAttribute("role")).toBe("group");
    expect(estimate.textContent).toContain("$72.90");
    expect(
      screen.getByLabelText("Desired running; observed running"),
    ).toBeTruthy();
    expect(
      screen.getByRole("list", { name: "Progress for research-control" })
        .textContent,
    ).toContain("Bootstrap healthy");
    expect(screen.getByText(/Recoverability · snapshot/)).toBeTruthy();
    expect(
      screen.getByLabelText("Health and attestation for research-control")
        .textContent,
    ).toContain("healthy");
    expect(
      screen.getByLabelText("Provider resources for research-control")
        .textContent,
    ).toContain("request-1");
    expect(
      screen.getByLabelText("Drift and connectivity for research-control")
        .textContent,
    ).toContain("gcp-iap-ssh");
    expect(
      screen.getByLabelText("Cost and quota signals for research-control")
        .textContent,
    ).toContain("CPUS");
    expect(
      screen.getByLabelText("Recent host logs for research-control")
        .textContent,
    ).toContain("Agent ready");
    expect(
      screen.getByText("Redacted request").parentElement?.textContent,
    ).toContain("ubuntu-2404");
    expect(
      screen.getByLabelText("Lifecycle actions for research-control"),
    ).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Audit export" }).getAttribute("href"),
    ).toBe("/api/workspace-hosts/host-1/audit");
  });

  it("routes connection and lifecycle actions through the sync mutation seam", async () => {
    render(<CloudWorkspacesPage />);

    fireEvent.click(
      screen.getByRole("button", {
        name: "Validate Google Cloud connection",
      }),
    );
    await waitFor(() =>
      expect(H.mutate).toHaveBeenCalledWith({
        action: "validate-connection",
        connectionId: "gcp-main",
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() =>
      expect(H.mutate).toHaveBeenCalledWith({
        action: "stop",
        workspaceId: "host-1",
      }),
    );
  });

  it("tracks overlapping mutations until each request settles", async () => {
    let resolveValidation!: (value: { ok: boolean }) => void;
    let resolveStop!: (value: { ok: boolean }) => void;
    const validation = new Promise<{ ok: boolean }>((resolve) => {
      resolveValidation = resolve;
    });
    const stop = new Promise<{ ok: boolean }>((resolve) => {
      resolveStop = resolve;
    });
    H.mutate.mockImplementation((args: { action: string }) =>
      args.action === "validate-connection" ? validation : stop,
    );
    render(<CloudWorkspacesPage />);

    const validateButton = screen.getByRole("button", {
      name: "Validate Google Cloud connection",
    }) as HTMLButtonElement;
    const stopButton = screen.getByRole("button", {
      name: "Stop",
    }) as HTMLButtonElement;

    fireEvent.click(validateButton);
    await waitFor(() => expect(validateButton.disabled).toBe(true));
    fireEvent.click(stopButton);
    await waitFor(() => {
      expect(validateButton.disabled).toBe(true);
      expect(stopButton.disabled).toBe(true);
    });

    resolveStop({ ok: true });
    await waitFor(() => expect(stopButton.disabled).toBe(false));
    expect(validateButton.disabled).toBe(true);
    fireEvent.click(validateButton);
    expect(H.mutate).toHaveBeenCalledTimes(2);

    resolveValidation({ ok: true });
    await waitFor(() => expect(validateButton.disabled).toBe(false));
  });

  it("builds the canonical persisted desired spec for provisioning", async () => {
    render(<CloudWorkspacesPage />);

    fireEvent.change(screen.getByRole("textbox", { name: "Workspace name" }), {
      target: { value: "Research Control" },
    });
    const provision = screen.getByRole("button", {
      name: "Provision workspace",
    }) as HTMLButtonElement;
    expect(provision.disabled).toBe(false);
    fireEvent.click(provision);

    await waitFor(() =>
      expect(H.mutate).toHaveBeenCalledWith({
        action: "provision",
        connectionId: "gcp-main",
        name: "Research Control",
        desired: {
          hostId: "host-research-control",
          target: "gcp",
          scope: { kind: "project", id: "papercusp-prod" },
          region: "us-central1",
          zone: "us-central1-a",
          size: "e2-standard-4",
          image: {
            id: "projects/papercusp-images/global/images/ubuntu-2404",
            version: "ubuntu-2404",
          },
          data: { volumeGiB: 100, encrypted: true },
          provider: { network: { mode: "managed" } },
        },
      }),
    );
  });

  it("collects the complete supported GCP connection admission contract", async () => {
    H.rows = [];
    render(<CloudWorkspacesPage />);
    fireEvent.click(screen.getByRole("button", { name: "Connect a provider" }));

    fireEvent.change(
      screen.getByRole("textbox", { name: "Connection label" }),
      {
        target: { value: "Production GCP" },
      },
    );
    fireEvent.change(
      screen.getByRole("textbox", { name: "Injected credential reference" }),
      { target: { value: "adc://default" } },
    );
    fireEvent.change(
      screen.getByRole("textbox", { name: "Google Cloud project ID" }),
      { target: { value: "papercusp-prod" } },
    );
    fireEvent.change(
      screen.getByRole("textbox", { name: "Runtime service account email" }),
      {
        target: {
          value: "papercusp-host@papercusp-prod.iam.gserviceaccount.com",
        },
      },
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Connect and validate" }),
    );

    await waitFor(() =>
      expect(H.mutate).toHaveBeenCalledWith({
        action: "connect",
        target: "gcp",
        label: "Production GCP",
        credentialRef: "adc://default",
        projectId: "papercusp-prod",
        serviceAccountEmail:
          "papercusp-host@papercusp-prod.iam.gserviceaccount.com",
      }),
    );
  });

  it("preserves explicit recoverability selection but fails closed without audited canary evidence", () => {
    render(<CloudWorkspacesPage />);

    fireEvent.click(screen.getByRole("button", { name: "Destroy" }));
    expect(
      screen.getByRole("dialog", { name: "Destroy research-control" }),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("radio", { name: /Create a snapshot first/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
    fireEvent.click(
      screen.getByRole("radio", { name: /Discard recoverability/ }),
    );

    const confirmButton = screen.getByRole("button", {
      name: "Confirm destroy",
    });
    expect((confirmButton as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(
      screen.getByLabelText("Type research-control to confirm discard"),
      { target: { value: "research-control" } },
    );
    expect((confirmButton as HTMLButtonElement).disabled).toBe(true);
    expect(confirmButton.getAttribute("aria-describedby")).toBe(
      "destroy-admission-blocker",
    );
    expect(screen.getByText("Audited canary evidence required")).toBeTruthy();
    expect(H.mutate).not.toHaveBeenCalled();
  });

  it("uses one tab stop and arrow-key selection in the recoverability radiogroup", () => {
    render(<CloudWorkspacesPage />);

    fireEvent.click(screen.getByRole("button", { name: "Destroy" }));
    const radios = screen.getAllByRole("radio") as HTMLButtonElement[];
    expect(radios.map((radio) => radio.tabIndex)).toEqual([0, -1, -1]);

    radios[0].focus();
    fireEvent.keyDown(radios[0], { key: "ArrowDown" });
    expect(document.activeElement).toBe(radios[1]);
    expect(radios[1].getAttribute("aria-checked")).toBe("true");
    expect(radios.map((radio) => radio.tabIndex)).toEqual([-1, 0, -1]);

    fireEvent.keyDown(radios[1], { key: "End" });
    expect(document.activeElement).toBe(radios[2]);
    expect(radios[2].getAttribute("aria-checked")).toBe("true");
    expect(radios.map((radio) => radio.tabIndex)).toEqual([-1, -1, 0]);

    fireEvent.keyDown(radios[2], { key: "ArrowDown" });
    expect(document.activeElement).toBe(radios[0]);
    expect(radios[0].getAttribute("aria-checked")).toBe("true");
  });

  it("fails closed when the sync control-plane read is unavailable", () => {
    H.rows = [];
    H.error = new Error("workspaceHosts.control is not registered");
    render(<CloudWorkspacesPage />);

    expect(screen.getByRole("alert").textContent).toContain(
      "Local cloud control plane unavailable",
    );
    expect(screen.getByText("Connect a provider to begin")).toBeTruthy();
  });

  it("offers an actionable provider connection from the empty configuration state", () => {
    H.rows = [];
    render(<CloudWorkspacesPage />);

    fireEvent.click(screen.getByRole("button", { name: "Connect a provider" }));
    expect(
      screen.getByRole("dialog", { name: "Connect Google Cloud" }),
    ).toBeTruthy();
  });

  it("dispatches each mutation family to its canonical REST route and surfaces typed errors", async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ ok: true, message: "accepted" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await workspaceHostActionRest({
      action: "connect",
      target: "gcp",
      label: "GCP",
      credentialRef: "adc://default",
      projectId: "paper-prod",
      serviceAccountEmail: "host@paper-prod.iam.gserviceaccount.com",
    });
    await workspaceHostActionRest({
      action: "provision",
      connectionId: "gcp:production",
      name: "Research",
      desired: {
        hostId: "host-research",
        target: "gcp",
        scope: { kind: "project", id: "paper-prod" },
        region: "us-central1",
        zone: "us-central1-a",
        size: "e2-small",
        image: { id: "projects/images/global/images/papercusp-v1" },
        data: { volumeGiB: 100, encrypted: true },
        provider: { network: { mode: "managed" } },
      },
    });
    await workspaceHostActionRest({ action: "stop", workspaceId: "host-1" });

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/workspace-hosts/connection",
      "/api/workspace-hosts/provision",
      "/api/workspace-hosts/action",
    ]);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body as string)).toEqual({
      connectionId: "gcp:production",
      name: "Research",
      desired: expect.objectContaining({ hostId: "host-research" }),
    });

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ ok: false, error: "typed route refusal" }),
        {
          status: 422,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    await expect(
      workspaceHostActionRest({ action: "repair", workspaceId: "host-1" }),
    ).rejects.toThrow("typed route refusal");
    expect(workspaceHostIdFromName("  Résumé / Lab  ")).toBe("host-resume-lab");
  });

  it("does not leak undefined capacity values from an incomplete runtime catalog row", () => {
    H.rows = [
      {
        ...rows[0],
        sizes: [{ id: "e2-small", label: "e2-small" } as never],
      },
    ];
    render(<CloudWorkspacesPage />);

    expect(screen.getAllByText("Capacity details unavailable")).toHaveLength(2);
    expect(screen.queryByText(/undefined vCPU/)).toBeNull();
  });

  it("explains empty catalog dimensions instead of rendering a blank provisioning dead end", () => {
    H.rows = [{ ...rows[0], networks: [] }];
    render(<CloudWorkspacesPage />);

    const network = screen.getByRole("combobox", { name: "Network" });
    expect((network as HTMLButtonElement).disabled).toBe(true);
    expect(network.textContent).toContain("No networks available");
    expect(
      screen.getByText(
        "No networks were returned by this provider connection.",
      ),
    ).toBeTruthy();

    const blocker = screen.getByRole("status");
    expect(blocker.textContent).toContain("Provisioning blocked");
    expect(blocker.textContent).toContain("enter a workspace name");
    expect(blocker.textContent).toContain(
      "load a network from the provider catalog",
    );

    const provision = screen.getByRole("button", {
      name: "Provision workspace",
    });
    expect((provision as HTMLButtonElement).disabled).toBe(true);
    expect(provision.getAttribute("aria-describedby")).toBe(
      "provision-blockers",
    );
  });

  it("associates visible field guidance with the control it describes", () => {
    H.rows = [{ ...rows[0], networks: [] }];
    render(<CloudWorkspacesPage />);

    const expectedDescriptions = [
      ["textbox", "Workspace name", "Required before provisioning."],
      ["combobox", "Machine size", "4 vCPU · 16 GiB RAM"],
      ["spinbutton", "Disk size in GiB", "20–16,384 GiB"],
      [
        "combobox",
        "Network",
        "No networks were returned by this provider connection.",
      ],
    ] as const;

    for (const [role, name, description] of expectedDescriptions) {
      const control = screen.getByRole(role, { name });
      const describedBy = control.getAttribute("aria-describedby");
      expect(describedBy).toBeTruthy();
      expect(document.getElementById(describedBy!)?.textContent).toBe(
        description,
      );
    }
  });

  it("keeps overview metrics readable at narrow embedded pane widths", () => {
    expect(cloudPageCss).toContain("minmax(min(220px, 100%), 1fr)");
    expect(cloudPageCss).toMatch(
      /\.summaryCard p\s*\{[^}]*white-space:\s*normal/s,
    );
    expect(cloudPageCss).not.toMatch(
      /\.overviewGrid\s*\{\s*grid-template-columns:\s*repeat\(2,/s,
    );
  });
});
