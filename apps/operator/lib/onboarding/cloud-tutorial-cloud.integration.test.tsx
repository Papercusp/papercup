// @vitest-environment jsdom
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { NuqsAdapter } from "../../../operator-vite/src/lib/nuqs-tanstack-router-adapter";
import { CLOUD_TUTORIAL_ID, CLOUD_TUTORIAL_VERSION } from "@papercusp/operator-core/lib/onboarding/cloud-tutorial-lesson";
import { hostedBrowserApiMarker } from "../hosted-browser-api";
import CloudWorkspacesPage from "@/app/cloud-workspaces/page";
import type { CloudWorkspacesControlRow } from "@/app/cloud-workspaces/page";

const data = vi.hoisted(() => ({ rows: [] as CloudWorkspacesControlRow[], mutate: vi.fn(), invalidate: vi.fn() }));
// Substitute only the authenticated network boundary. The Cloud forms, Radix
// dialog, guide, highlighting, URL state and router are actual application code.
vi.mock("@papercusp/sync", async importOriginal => ({
  ...(await importOriginal<typeof import("@papercusp/sync")>()),
  useSyncQuery: () => ({ data: data.rows, loading: false, fetching: false, error: null, invalidate: data.invalidate }),
  useSyncMutate: () => data.mutate, planChunks: vi.fn(),
}));
const scope = { tenantId: "tenant", userId: "user", workspaceId: "customer" };
const connection: CloudWorkspacesControlRow = { kind: "connection", id: "gcp", target: "gcp", label: "My GCP", status: "connected", credentialRef: "env:CREDENTIAL", scopes: [], regions: [], sizes: [], images: [], networks: [] };
const workspace: CloudWorkspacesControlRow = { kind: "workspace", id: "customer", name: "My workspace", connectionId: "gcp", target: "gcp", scopeLabel: "project", region: "us-central1", size: "small", image: "ubuntu", diskGiB: 100, network: "private", desiredState: "running", observedState: "running", recoverability: { kind: "none", label: "No backup" }, capabilities: { stop: true, repair: true, snapshot: true, destroy: true } };
function mount(initial = "/cloud-workspaces") {
  const root = createRootRoute({
    component: () => <NuqsAdapter><main><Outlet /></main></NuqsAdapter>,
    errorComponent: ({ error }) => <pre data-testid="cloud-route-error">{error.stack ?? error.message}</pre>,
  });
  const cloud = createRoute({ getParentRoute: () => root, path: "/cloud-workspaces", component: CloudWorkspacesPage });
  const other = createRoute({ getParentRoute: () => root, path: "/other", component: () => <h1>Other view</h1> });
  const router = createRouter({ routeTree: root.addChildren([cloud, other]), history: createMemoryHistory({ initialEntries: [initial] }) });
  const view = render(<StrictMode><RouterProvider router={router} /></StrictMode>);
  return { ...view, router };
}
beforeEach(() => {
  data.rows = []; data.mutate.mockReset().mockResolvedValue({ ok: true }); data.invalidate.mockReset().mockResolvedValue(undefined);
  window.__PAPERCUSP_HOSTED_BROWSER__ = hostedBrowserApiMarker("control");
  delete window.__PAPERCUSP_HOSTED_BROWSER_API__;
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn() })));
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ x: 20, y: 20, top: 20, left: 20, width: 200, height: 40, right: 220, bottom: 60, toJSON: () => ({}) });
  Object.defineProperty(HTMLElement.prototype, "offsetParent", { configurable: true, get: () => document.body });
  Element.prototype.scrollIntoView = vi.fn(); window.scrollTo = vi.fn();
  let revision = 0;
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    const patch = init?.body ? JSON.parse(init.body) : null;
    return new Response(JSON.stringify({ record: { revision: patch ? ++revision : revision, mutationId: patch?.mutationId ?? null,
      progress: { scope, lessonId: CLOUD_TUTORIAL_ID, version: CLOUD_TUTORIAL_VERSION, disposition: patch?.disposition ?? "active" } } }));
  }));
});
afterEach(() => {
  const routeError = screen.queryByTestId("cloud-route-error")?.textContent;
  cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); delete window.__PAPERCUSP_HOSTED_BROWSER__;
  // A routed render failure must remain visible even if an earlier assertion passed.
  expect(routeError).toBeUndefined();
});
describe("Cloud Guide mounted on the maintained hosted Cloud surface", () => {
  it("discloses cost before the user provisions and leaves the real provision action untouched by guide controls", async () => {
    data.rows = [{ ...connection,
      scopes: [{ id: "project", label: "Tutorial project" }],
      regions: [{ id: "us-central1", label: "Iowa", zones: ["us-central1-a"] }],
      sizes: [{ id: "small", label: "Small", vcpu: 2, memoryGiB: 2, hourlyUsd: 0.02 }],
      images: [{ id: "ubuntu", label: "Ubuntu" }],
      networks: [{ id: "private", label: "Private" }],
    }];
    mount("/cloud-workspaces?step=configure&connection=gcp&name=Cost%20review&scope=project&region=us-central1&size=small&image=ubuntu&network=private");
    const guide = await screen.findByRole("region", { name: "First agent guide" });
    await within(guide).findByRole("heading", { name: "Review configuration and cost" });
    const estimate = screen.getByRole("group", { name: "Estimated workspace cost" });
    expect(within(estimate).getByText("Estimated monthly cost")).toBeTruthy();
    expect(within(estimate).getByText(/730 compute hours.*selected disk.*provider taxes and egress excluded/)).toBeTruthy();
    expect(within(guide).getByText(/Google Cloud bills for provisioned resources, including retained disks/)).toBeTruthy();
    const provision = screen.getByRole("button", { name: "Provision workspace" }) as HTMLButtonElement;
    await waitFor(() => expect(provision.disabled).toBe(false));
    for (const name of ["Show me", "Pause", "Resume guide"])
      fireEvent.click(within(guide).getByRole("button", { name }));
    expect(data.mutate).not.toHaveBeenCalled();
    // Positive control: the maintained product action exists and dispatches
    // only after the user operates its enabled control.
    fireEvent.click(provision);
    await waitFor(() => expect(data.mutate).toHaveBeenCalledWith(expect.objectContaining({ action: "provision" })));
  });
  it("explains unmet provisioning prerequisites and keeps the actual product action blocked", async () => {
    data.rows = [connection];
    mount("/cloud-workspaces?step=configure&name=Prerequisite%20review");
    const guide = await screen.findByRole("region", { name: "First agent guide" });
    await within(guide).findByRole("heading", { name: "Review configuration and cost" });
    const provision = screen.getByRole("button", { name: "Provision workspace" }) as HTMLButtonElement;
    expect(provision.disabled).toBe(true);
    expect(provision.getAttribute("aria-describedby")).toBe("provision-readiness");
    const readiness = document.getElementById("provision-readiness")!;
    expect(within(readiness).getByText(/Provisioning blocked/)).toBeTruthy();
    for (const name of ["Project, account, or subscription loaded", "Region loaded", "Machine size loaded", "Image loaded", "Network loaded"])
      expect(within(readiness).getByText(name)).toBeTruthy();
    fireEvent.click(within(guide).getByRole("button", { name: "Show me" }));
    fireEvent.click(provision);
    expect(data.mutate).not.toHaveBeenCalled();
  });
  it("recognizes an existing healthy workspace, records real cost review and waits for the host-specific connector", async () => {
    data.rows = [connection, { ...workspace, health: { status: "healthy", checks: [] } }];
    mount("/cloud-workspaces?step=operate&host=customer");
    const guide = await screen.findByRole("region", { name: "First agent guide" });
    await within(guide).findByRole("heading", { name: "Review configuration and cost" });
    fireEvent.click(within(guide).getByRole("button", { name: "Show me" }));
    const review = await screen.findByRole("button", { name: "I've reviewed the configuration and cost" });
    expect(document.querySelector('[data-tutorial-target="cloud-configuration"]')).not.toBeNull();
    fireEvent.click(review);
    await within(guide).findByRole("heading", { name: "Wait for a healthy workspace" });
    expect(screen.queryByRole("button", { name: "+ New session" })).toBeNull();
    expect(data.mutate).not.toHaveBeenCalled();
  });
  it("explains and highlights the actual connection action without filling or submitting the form", async () => {
    const { router } = mount();
    const guide = await screen.findByRole("region", { name: "First agent guide" });
    fireEvent.click(within(guide).getByRole("button", { name: "Show me" }));
    const input = await screen.findByRole("textbox", { name: "Connection label" });
    await waitFor(() => expect(router.state.location.search).toMatchObject({ step: "connect", connect: "gcp" }));
    await waitFor(() => expect(document.querySelector(".react-joyride__overlay")).not.toBeNull());
    input.focus();
    expect(fireEvent.keyDown(input, { key: "Tab", cancelable: true })).toBe(true);
    fireEvent.change(input, { target: { value: "My project" } });
    expect(input).toHaveProperty("value", "My project");
    expect(document.activeElement).toBe(input);
    expect(within(guide).getByText("0 of 6 steps confirmed")).toBeTruthy();
    expect(data.mutate).not.toHaveBeenCalled();
  });
  it("recovers a missing real target by navigation, preserving confirmed prerequisites and user input", async () => {
    data.rows = [connection];
    mount("/cloud-workspaces?step=connect");
    const guide = await screen.findByRole("region", { name: "First agent guide" });
    await within(guide).findByRole("heading", { name: "Review configuration and cost" });
    expect(document.querySelector('[data-tutorial-target="cloud-configuration"]')).toBeNull();
    fireEvent.click(within(guide).getByRole("button", { name: "Show me" }));
    const target = await waitFor(() => {
      const target = document.querySelector<HTMLElement>('[data-tutorial-target="cloud-configuration"]');
      expect(target).not.toBeNull(); return target!;
    });
    await waitFor(() => expect(document.activeElement).toBe(target));
    expect(within(guide).getByText("1 of 6 steps confirmed")).toBeTruthy();
    expect(data.mutate).not.toHaveBeenCalled();
  });
  it("offers pause/resume/skip and replay from Help while retaining the actual form", async () => {
    mount(); const guide = await screen.findByRole("region", { name: "First agent guide" });
    fireEvent.click(within(guide).getByRole("button", { name: "Show me" }));
    const input = await screen.findByRole("textbox", { name: "Connection label" });
    fireEvent.change(input, { target: { value: "Keep this draft" } });
    fireEvent.click(within(guide).getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(document.querySelector(".react-joyride__overlay")).toBeNull());
    expect(input).toHaveProperty("value", "Keep this draft");
    fireEvent.click(within(guide).getByRole("button", { name: "Resume guide" }));
    fireEvent.click(within(guide).getByRole("button", { name: "Skip lesson" }));
    expect(within(guide).getByText(/start this lesson again from Help/)).toBeTruthy();
    fireEvent.click(screen.getByText("Help"));
    fireEvent.click(screen.getByRole("button", { name: "Get your first agent running" }));
    expect(within(guide).getByRole("heading", { name: "Connect Google Cloud" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Connection label" })).toBe(input);
    expect(data.mutate).not.toHaveBeenCalled();
  });
  it("keeps the actual product destroy dialog operable without activating its destructive action", async () => {
    data.rows = [connection, workspace];
    mount("/cloud-workspaces?step=operate");
    await screen.findByRole("region", { name: "First agent guide" });
    fireEvent.click(await screen.findByRole("button", { name: "More actions for My workspace" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Destroy" }));
    const dialog = await screen.findByRole("dialog", { name: "Destroy My workspace" });
    expect(within(dialog).getByRole("button", { name: /Confirm destroy/ })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(data.mutate).not.toHaveBeenCalled();
    expect(screen.getByRole("region", { name: "First agent guide" })).toBeTruthy();
  });
  it("closes and reopens from Help, then cleans overlays on route exit", async () => {
    const { router } = mount(); const guide = await screen.findByRole("region", { name: "First agent guide" });
    fireEvent.click(within(guide).getByRole("button", { name: "Show me" }));
    await waitFor(() => expect(document.querySelector(".react-joyride__overlay")).not.toBeNull());
    fireEvent.click(within(guide).getByRole("button", { name: "Close guide" }));
    expect(screen.queryByRole("region", { name: "First agent guide" })).toBeNull();
    await waitFor(() => expect(document.querySelector(".react-joyride__overlay")).toBeNull());
    fireEvent.click(screen.getByText("Help"));
    fireEvent.click(screen.getByRole("button", { name: "Get your first agent running" }));
    await screen.findByRole("region", { name: "First agent guide" });
    await waitFor(() => expect(document.querySelectorAll(".react-joyride__overlay")).toHaveLength(1));
    await act(async () => { await router.navigate({ to: "/other" }); });
    await screen.findByRole("heading", { name: "Other view" });
    await waitFor(() => expect(document.querySelector(".react-joyride__overlay, [data-cloud-tutorial-highlight], [data-cloud-tutorial-guide]")).toBeNull());
    expect(data.mutate).not.toHaveBeenCalled();
  });
});
