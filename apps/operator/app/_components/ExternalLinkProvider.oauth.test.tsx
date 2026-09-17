// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const desktop = vi.hoisted(() => ({
  invoke: vi.fn(),
  allowed: vi.fn(),
}));

const notifications = vi.hoisted(() => ({ error: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => desktop.invoke(...args),
}));

vi.mock("@/lib/ipc-status-tauri", () => ({
  canUseContentOriginDesktopActions: () => desktop.allowed(),
}));

vi.mock("sonner", () => ({ toast: notifications }));

import ExternalLinkProvider, { isOAuthStartUrl } from "./ExternalLinkProvider";

const fetchMock = vi.fn();
const authorizeUrl =
  "https://accounts.google.com/o/oauth2/v2/auth?client_id=desktop-client&state=signed-state";

beforeEach(() => {
  desktop.invoke.mockReset();
  desktop.invoke.mockResolvedValue(undefined);
  desktop.allowed.mockReset();
  desktop.allowed.mockResolvedValue(true);
  notifications.error.mockReset();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(
    Response.json({ ok: true, authorizationUrl: authorizeUrl }),
  );
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => cleanup());

describe("ExternalLinkProvider OAuth handoff", () => {
  it("recognizes only the same-app OAuth start route", () => {
    const app = "http://localhost:3070/settings/plugins";
    expect(
      isOAuthStartUrl("/api/oauth/start?provider=google&plugin=gmail", app),
    ).toBe(true);
    expect(isOAuthStartUrl("/api/oauth/callback?code=x", app)).toBe(false);
    expect(
      isOAuthStartUrl(
        "https://example.test/api/oauth/start?provider=google",
        app,
      ),
    ).toBe(false);
  });

  it("intercepts a plugin OAuth link and opens the server-built URL in the system browser", async () => {
    const before = window.location.href;
    render(
      <>
        <ExternalLinkProvider />
        <a href="/api/oauth/start?provider=google&plugin=gmail&harness=papercusp&field=token">
          Connect with google
        </a>
      </>,
    );
    await waitFor(() => expect(desktop.allowed).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("link", { name: "Connect with google" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/oauth/start?provider=google&plugin=gmail&harness=papercusp&field=token&response=json",
        { cache: "no-store" },
      );
      expect(desktop.invoke).toHaveBeenCalledWith("plugin:shell|open", {
        path: authorizeUrl,
      });
    });
    expect(window.location.href).toBe(before);
    expect(notifications.error).not.toHaveBeenCalled();
  });

  it("refuses an unsafe provider URL and tells the owner why sign-in did not open", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(
      Response.json({
        ok: true,
        authorizationUrl: "http://localhost:3070/trap",
      }),
    );
    render(
      <>
        <ExternalLinkProvider />
        <a href="/api/oauth/start?provider=google&plugin=gmail&harness=papercusp&field=token">
          Connect with google
        </a>
      </>,
    );
    await waitFor(() => expect(desktop.allowed).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("link", { name: "Connect with google" }));

    await waitFor(() =>
      expect(notifications.error).toHaveBeenCalledWith(
        "Couldn’t open provider sign-in: OAuth server returned an unsafe authorization URL",
      ),
    );
    expect(desktop.invoke).not.toHaveBeenCalled();
    expect(errorLog).toHaveBeenCalledWith(
      "[ExternalLinkProvider] shell open failed",
      expect.objectContaining({
        message: "OAuth server returned an unsafe authorization URL",
      }),
    );
    errorLog.mockRestore();
  });
});

// Counterexample proof for scenario `system-browser-open-disabled`. Deliberately
// TOP-LEVEL (no `describe`) so its full name is exactly the scenario id, and
// deliberately narrow: it is the only case in this file that turns on the
// PROTOCOL conjunct of `isOAuthStartUrl` (the cross-origin case above differs by
// host as well, so it stays false without that conjunct). Removing the protocol
// guard from the production recognizer therefore fails THIS case and no other —
// which is what makes the scenario falsifiable rather than merely asserted.
it("system-browser-open-disabled", () => {
  const app = "http://localhost:3070/settings/plugins";
  expect(
    isOAuthStartUrl(
      "https://localhost:3070/api/oauth/start?provider=google",
      app,
    ),
    "system-browser-open-disabled: a same-host OAuth start link on a DIFFERENT protocol must not be treated as the app's own OAuth start route, so it is never handed to the system browser",
  ).toBe(false);
});
