// @vitest-environment jsdom

import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { HostedDesktopViewerProps } from "./HostedDesktopViewer";
import {
  HostedDesktopWorkspace,
  type DesktopSelection,
  type HostedDesktopWorkspaceProps,
} from "./HostedDesktopWorkspace";

vi.mock("./HostedDesktopViewer", () => ({
  HostedDesktopViewer: (props: HostedDesktopViewerProps) => (
    <section
      aria-label={`Live ${props.desktopSessionId}`}
      data-workspace={props.workspaceId}
      data-host={props.hostId}
      data-route={props.routeLabel}
      data-mode={props.mode}
    >
      <button
        onClick={() => props.onModeChange?.("takeover")}
        disabled={!props.canTakeControl}
      >
        Take control
      </button>
    </section>
  ),
}));

afterEach(cleanup);

const roster = [
  {
    desktopSessionId: "desk-1",
    state: "running",
    displayNumber: 1,
    geometry: "1280x720",
    lastActiveAt: "2026-09-07T10:00:00Z",
  },
  {
    desktopSessionId: "desk-2",
    state: "idle",
    displayNumber: 2,
    lastActiveAt: "2026-09-07T10:05:00Z",
  },
];

function Workspace(props: Partial<HostedDesktopWorkspaceProps>) {
  const [selectedDesktop, onSelectDesktop] = useState<DesktopSelection | null>(
    null,
  );
  return (
    <HostedDesktopWorkspace
      hostName="Research workspace"
      workspaceId="customer-1"
      hostId="host-1"
      routeLabel="relay-1"
      bridge={{
        requestRoster: () => true,
        requestThumbnail: () => true,
        requestStart: () => true,
      }}
      roster={roster}
      rosterState="ready"
      rosterError={null}
      startState="idle"
      startError={null}
      thumbnails={{}}
      selectedDesktop={selectedDesktop}
      viewerState={null}
      onSelectDesktop={onSelectDesktop}
      onViewerStateChange={() => {}}
      {...props}
    />
  );
}

describe("<HostedDesktopWorkspace>", () => {
  it("opens the selected host-scoped desktop in watch mode and replaces it on selection", () => {
    render(<Workspace />);
    expect(screen.getByText("Choose a desktop to watch")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Watch Display 1" }));
    const first = screen.getByRole("region", { name: "Live desk-1" });
    expect(first.getAttribute("data-workspace")).toBe("customer-1");
    expect(first.getAttribute("data-host")).toBe("host-1");
    expect(first.getAttribute("data-route")).toBe("relay-1");
    expect(first.getAttribute("data-mode")).toBe("watch");
    fireEvent.click(screen.getByRole("button", { name: "Take control" }));
    expect(first.getAttribute("data-mode")).toBe("takeover");
    fireEvent.click(screen.getByRole("button", { name: "Watch Display 2" }));
    expect(screen.queryByRole("region", { name: "Live desk-1" })).toBeNull();
    expect(
      screen
        .getByRole("region", { name: "Live desk-2" })
        .getAttribute("data-mode"),
    ).toBe("watch");
    expect(
      screen
        .getByRole("button", { name: "Watch Display 2" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    fireEvent.click(
      screen.getByRole("button", { name: "Close desktop viewer" }),
    );
    expect(screen.queryByRole("region", { name: "Live desk-2" })).toBeNull();
  });

  it("keeps an existing media stream through discovery loss but prevents opening another or taking control", () => {
    const { rerender } = render(<Workspace />);
    fireEvent.click(screen.getByRole("button", { name: "Watch Display 1" }));
    rerender(<Workspace bridge={null} />);
    expect(screen.getByRole("region", { name: "Live desk-1" })).toBeTruthy();
    expect(
      (
        screen.getByRole("button", {
          name: "Watch Display 2",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      (
        screen.getByRole("button", {
          name: "Take control",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(screen.getByText("Workspace disconnected")).toBeTruthy();
    rerender(<Workspace roster={[roster[1]]} />);
    expect(screen.queryByRole("region", { name: "Live desk-1" })).toBeNull();
    expect(
      screen.getByText("This desktop is no longer available"),
    ).toBeTruthy();
  });

  it("refreshes via the existing bridge and renders only reported activity and thumbnails", () => {
    const requestRoster = vi.fn(() => true);
    const { rerender } = render(
      <Workspace
        bridge={{
          requestRoster,
          requestThumbnail: () => true,
          requestStart: () => true,
        }}
        thumbnails={{ "desk-1": { desktopSessionId: "desk-1", data: "frame" } }}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Refresh desktop roster" }),
    );
    expect(requestRoster).toHaveBeenCalledOnce();
    const activity = screen.getByRole("region", {
      name: "Recent desktop activity",
    });
    expect(within(activity).getAllByRole("listitem")[0].textContent).toContain(
      "Display 2 · idle",
    );
    expect(activity.querySelector("time")?.dateTime).toBe(
      "2026-09-07T10:05:00Z",
    );
    expect(
      screen
        .getByRole("button", { name: "Watch Display 1" })
        .querySelector("img")?.src,
    ).toBe("data:image/jpeg;base64,frame");
    rerender(
      <Workspace
        roster={[
          {
            desktopSessionId: "unknown",
            state: "running",
            lastActiveAt: "not-a-timestamp",
          },
        ]}
      />,
    );
    expect(
      screen.getByText("No desktop activity has been reported yet."),
    ).toBeTruthy();
  });

  it.each([
    [{ routeLabel: null }, "Your desktop is not ready yet"],
    [{ bridge: null }, "Connect your workspace"],
    [{ rosterState: "loading", roster: [] }, "Finding your desktops…"],
    [{ roster: [] }, "No desktops are available yet"],
    [{ roster: [], startState: "loading" }, "Starting your desktop…"],
    [
      { roster: [], startState: "error", startError: "desktop_start_failed" },
      "Your desktop could not be started",
    ],
    [
      { rosterState: "error", rosterError: "connection_lost", roster: [] },
      "Desktops could not be loaded",
    ],
  ] as const)(
    "explains unavailable state without presenting a fabricated live desktop: %j",
    (props, title) => {
      render(<Workspace {...props} />);
      expect(screen.getByText(title)).toBeTruthy();
      expect(screen.queryByRole("region", { name: /^Live/ })).toBeNull();
      expect(screen.queryByRole("button", { name: "Take control" })).toBeNull();
    },
  );
});
