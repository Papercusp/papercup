// @vitest-environment jsdom
import { StrictMode, type ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { NuqsTestingAdapter } from "nuqs/adapters/testing";
import { FakeEventSource, latestEventSource } from "@/app/_components/chat/fake-event-source.testkit";
import { CLOUD_TUTORIAL_ID, CLOUD_TUTORIAL_TASK, CLOUD_TUTORIAL_VERSION } from "@papercusp/operator-core/lib/onboarding/cloud-tutorial-lesson";
import type { TimelineEntry } from "@/app/harness/AgentThinkingStream";
import { hostedBrowserApiMarker } from "../hosted-browser-api";
import { CloudTutorialCompanion } from "./cloud-tutorial-companion";
import { correlatedTutorialTask } from "./cloud-tutorial-session";

vi.mock("@papercusp/sync", async importOriginal => ({ ...(await importOriginal<typeof import("@papercusp/sync")>()), useSyncQuery: () => ({ data: [], loading: false, error: null }) }));
vi.mock("@/lib/useLexicon", () => ({ useLexicon: () => (value: string) => value }));
vi.mock("@/app/admin/plans/plans-api", () => ({ usePlanList: () => ({ data: { plans: [] }, loading: false }) }));
vi.mock("@/app/adv/sessions/use-su-launch-options", () => ({
  useSuLaunchOptions: () => ({ fleets: [], accounts: [], schemes: [], nextScheme: null, ompCatalog: { status: "unavailable", models: [] }, loading: false, error: null, refresh: () => {} }),
  useIdentityLaunchCatalog: () => ({ identities: [], unreadable: [], nextAfter: null, loading: false, error: null, loadMore: () => {} }),
}));
const scope = { tenantId: "tenant", userId: "user", workspaceId: "customer" };
const connection = { kind: "connection" as const, id: "gcp", target: "gcp", label: "GCP", status: "connected" as const, credentialRef: "env:SECRET", scopes: [], regions: [], sizes: [], images: [], networks: [] };
const workspace = { kind: "workspace" as const, id: "host", name: "My workspace", connectionId: "gcp", target: "gcp", scopeLabel: "project", region: "us-central1", size: "small", image: "ubuntu", diskGiB: 100, network: "private", desiredState: "running" as const, observedState: "running" as const, health: { status: "healthy", checks: [] }, recoverability: { kind: "none" as const, label: "No backup" }, capabilities: {} };
const actions: Array<{ url: string; body: Record<string, unknown> }> = [];
let sentPrompt = "";
beforeEach(() => {
  actions.length = 0; sentPrompt = ""; FakeEventSource.instances.length = 0;
  window.__PAPERCUSP_HOSTED_BROWSER__ = hostedBrowserApiMarker("control");
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }));
  Element.prototype.scrollIntoView = vi.fn(); window.scrollTo = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async (input, init) => {
    const url = String(input); const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (url.includes("tutorial-progress")) return Response.json({ record: { revision: 0, progress: { scope, lessonId: CLOUD_TUTORIAL_ID, version: CLOUD_TUTORIAL_VERSION, disposition: body.disposition ?? "active", ...(body.inspectedResult ? { inspectedResult: body.inspectedResult } : {}) } } });
    if (url.includes("launch-su")) { actions.push({ url, body }); return Response.json({ status: "ok", ownerId: "su-first" }); }
    if (url.includes("sessions/list")) return Response.json({ sessions: [{ source_kind: "codex", session_id: "native-first", active: true, last_ts: null }] });
    if (url.includes("coord/send")) { actions.push({ url, body }); sentPrompt = String(body.body); return Response.json({ results: [{ wake: { queued: 1 } }] }); }
    return Response.json({});
  }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); delete window.__PAPERCUSP_HOSTED_BROWSER__; });
const props = { selectionKey: "selected", connection, workspace, boundWorkspaceId: "customer", configurationValid: true, configurationReviewed: true, controlLoading: false, controlError: null, onCheckAgain: () => {}, onShowStep: () => {} };
const view = (value: ComponentProps<typeof CloudTutorialCompanion>) => <StrictMode><NuqsTestingAdapter><CloudTutorialCompanion {...value} /></NuqsTestingAdapter></StrictMode>;
async function answer(outcome: "succeeded" | "failed", prompt = sentPrompt) {
  await act(async () => {
    const stream = latestEventSource();
    stream.fireOpen();
    stream.fire("backfill", JSON.stringify([
      { kind: "prompt", text: prompt, ts: "2026-10-01T12:00:00.000Z" },
      { kind: "text", text: "Available tools: read files and search code.", ts: "2026-10-01T12:00:01.000Z" },
      { kind: "result", outcome, text: "", ts: "2026-10-01T12:00:02.000Z" },
    ]));
  });
}
async function launch() {
  fireEvent.click(await screen.findByRole("button", { name: "+ New session" }));
  await waitFor(() => expect(FakeEventSource.instances.some(stream => !stream.closed)).toBe(true));
  await act(async () => { latestEventSource().fireOpen(); latestEventSource().fire("backfill", "[]"); });
  await waitFor(() => expect(screen.getByRole("button", { name: "Send sample task" }).hasAttribute("disabled")).toBe(false));
}
describe("authenticated first-agent product journey", () => {
  it.each(["new-user", "existing-workspace"])("%s reaches an inspected successful correlated result using explicit real controls", async path => {
    const initial = path === "new-user" ? { ...props, connection: null, workspace: null, boundWorkspaceId: null, configurationValid: false, configurationReviewed: false } : { ...props, configurationReviewed: false };
    const mounted = render(view(initial));
    const guide = await screen.findByRole("region", { name: "First agent guide" });
    await within(guide).findByRole("heading", { name: path === "new-user" ? "Connect Google Cloud" : "Review configuration and cost" });
    expect(actions).toEqual([]);
    mounted.rerender(view({ ...props, workspace: { ...workspace, health: { status: "unknown", checks: [] } } }));
    await within(guide).findByRole("heading", { name: "Wait for a healthy workspace" });
    expect(screen.queryByRole("button", { name: "+ New session" })).toBeNull();
    mounted.rerender(view(props));
    await within(guide).findByRole("heading", { name: "Launch your first agent" });
    expect(actions).toEqual([]);
    await launch();
    expect(actions.filter(action => action.url.includes("launch-su"))).toHaveLength(1);
    expect(actions[0].body.mode).toBeNull();
    await within(guide).findByRole("heading", { name: "Submit a small read-only task" });
    fireEvent.click(screen.getByRole("button", { name: "Send sample task" }));
    await waitFor(() => expect(sentPrompt).toContain(CLOUD_TUTORIAL_TASK));
    expect(actions.filter(action => action.url.includes("coord/send"))).toHaveLength(1);
    expect(within(guide).getByText("4 of 6 steps confirmed")).toBeTruthy();
    await answer("succeeded", "An unrelated task");
    expect(within(guide).getByText("4 of 6 steps confirmed")).toBeTruthy();
    await answer("succeeded");
    await within(guide).findByRole("heading", { name: "Inspect the result" });
    // The maintained chat renders Markdown asynchronously and may split its
    // text into spans. Require the actual answer in its visible result region.
    await waitFor(() => expect(document.querySelector('[data-tutorial-target="cloud-result"]')?.textContent).toContain("Available tools: read files and search code."));
    fireEvent.click(screen.getByRole("button", { name: "I've inspected this answer" }));
    await within(guide).findByText("Your first agent lesson is complete.");
    expect(within(guide).getByText("6 of 6 steps confirmed")).toBeTruthy();
  });
  it("does not expose the launcher for a mismatched authenticated workspace or unreconciled cost", async () => {
    const mounted = render(view({ ...props, boundWorkspaceId: "other-customer" }));
    await screen.findByRole("region", { name: "First agent guide" });
    expect(screen.queryByRole("button", { name: "+ New session" })).toBeNull();
    mounted.rerender(view({ ...props, configurationReviewed: false }));
    expect(screen.queryByRole("button", { name: "+ New session" })).toBeNull();
    expect(actions).toEqual([]);
  });
  it("an actual failed task cannot be inspected or advance the lesson", async () => {
    render(view(props)); await screen.findByRole("region", { name: "First agent guide" }); await launch();
    fireEvent.click(screen.getByRole("button", { name: "Send sample task" }));
    await waitFor(() => expect(sentPrompt).not.toBe("")); await answer("failed");
    await screen.findByText("The task did not finish successfully. Review the session's error, then explicitly send it again.");
    expect(screen.getByRole("button", { name: "I've inspected this answer" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("4 of 6 steps confirmed")).toBeTruthy();
  });
});
describe("terminal request correlation", () => {
  it("requires the exact request's answer and typed terminal success; adjacent turns, commentary and unknown outcomes do not count", () => {
    const request = { id: "nonce", prompt: "sample nonce", sentAt: 0 };
    const entries: TimelineEntry[] = [{ kind: "prompt", text: request.prompt }, { kind: "text", text: "Working" }];
    expect(correlatedTutorialTask(entries, request)?.status).toBe("pending");
    expect(correlatedTutorialTask([...entries, { kind: "result", text: "Looks done", ts: "2026-10-01T12:00:02Z" }], request)?.status).toBe("pending");
    expect(correlatedTutorialTask([...entries, { kind: "prompt", text: "another nonce" }, { kind: "result", outcome: "succeeded", text: "Other answer", ts: "2026-10-01T12:00:02Z" }], request)?.status).toBe("pending");
    expect(correlatedTutorialTask([...entries, { kind: "result", outcome: "succeeded", ts: "2026-10-01T12:00:02Z" }], request)?.status).toBe("succeeded");
    expect(correlatedTutorialTask([{ kind: "prompt", text: request.prompt }, { kind: "result", outcome: "succeeded", ts: "2026-10-01T12:00:02Z" }], request)?.status).toBe("pending");
  });
});
