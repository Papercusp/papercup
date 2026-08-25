// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PersonalVaultSettingsPage, {
  facebookPersonalVaultConnectHref,
  googleWorkspaceConnectHref,
} from "./page";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

const googleCapabilities = [
  {
    id: "gmail",
    sourceKind: "gmail",
    enabled: true,
    connected: true,
    status: "connected",
    missingScopes: [],
  },
  {
    id: "calendar",
    sourceKind: "gcal",
    enabled: true,
    connected: true,
    status: "connected",
    missingScopes: [],
  },
  {
    id: "contacts",
    sourceKind: "contacts",
    enabled: true,
    connected: true,
    status: "connected",
    missingScopes: [],
  },
];

const status = {
  ok: true,
  enabled: true,
  workspaceId: "papercusp-workspace",
  user: { id: "user-1", displayName: "Owner" },
  stats: {
    sources: [
      { source: "gmail", documents: 12, newest_at: "2026-08-20T12:00:00Z" },
    ],
    unembedded: 2,
  },
  grants: [],
  supportedSources: [
    "gmail",
    "calendar",
    "contacts",
    "facebook",
    "instagram",
    "x",
  ],
  embedding: { mode: "gemma", localOnly: true },
  integrations: {
    google: {
      provider: "google",
      configured: true,
      connected: true,
      status: "connected",
      sources: [
        {
          kind: "gmail",
          status: "connected",
          lastConnectedAt: "2026-08-23T00:00:00.000Z",
          lastSyncAt: "2026-08-23T00:00:00.000Z",
        },
      ],
      capabilities: googleCapabilities,
      accounts: [
        {
          providerAccountId: "owner@example.com",
          displayName: "owner@example.com",
          connected: true,
          status: "connected",
          grantedScopes: [],
          sources: [
            {
              kind: "gmail",
              status: "connected",
              lastConnectedAt: "2026-08-23T00:00:00.000Z",
              lastSyncAt: "2026-08-23T00:00:00.000Z",
            },
          ],
          capabilities: googleCapabilities,
        },
      ],
    },
    facebook: {
      provider: "facebook",
      configured: true,
      connected: true,
      status: "degraded",
      sources: [
        {
          kind: "facebook",
          status: "degraded",
          lastConnectedAt: "2026-08-23T00:05:00.000Z",
          lastSyncAt: "2026-08-23T00:10:00.000Z",
        },
      ],
    },
  },
};

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (
        url === "/api/user/personal-vault" &&
        (!init?.method || init.method === "GET")
      ) {
        return Response.json(status);
      }
      if (url === "/api/user/personal-vault" && init?.method === "PATCH") {
        const body = JSON.parse(String(init.body)) as { enabled: boolean };
        return Response.json({ ok: true, enabled: body.enabled });
      }
      if (url === "/api/user/personal-vault/grants/preview") {
        return Response.json({
          ok: true,
          planSlug: "meeting-prep-brief",
          harnessSlug: "papercusp",
          principalType: "plan-template",
          principalId: "meeting-prep-brief",
          declaredScopes: ["personal:gmail", "personal:calendar"],
        });
      }
      if (
        url === "/api/user/personal-vault/integrations/google" &&
        init?.method === "DELETE"
      ) {
        return Response.json({ ok: true, disconnectedSources: 3 });
      }
      if (
        url === "/api/user/personal-vault/integrations/google/capabilities" &&
        init?.method === "PATCH"
      ) {
        const body = JSON.parse(String(init.body)) as {
          capability: string;
          enabled: boolean;
        };
        return Response.json({ ok: true, ...body });
      }
      if (
        url === "/api/user/personal-vault/integrations/facebook" &&
        init?.method === "DELETE"
      ) {
        return Response.json({ ok: true, disconnectedSources: 1 });
      }
      throw new Error(`unexpected fetch ${init?.method ?? "GET"} ${url}`);
    },
  );
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => cleanup());

describe("PersonalVaultSettingsPage", () => {
  it("renders the local-only posture and imported source status", async () => {
    render(<PersonalVaultSettingsPage />);
    expect(
      await screen.findByRole("heading", { name: "Personal Vault" }),
    ).toBeTruthy();
    expect(
      screen.getByText(
        /vectors are produced only by the local EmbeddingGemma model/i,
      ),
    ).toBeTruthy();
    expect(screen.getAllByText("personal:gmail").length).toBeGreaterThanOrEqual(
      1,
    );
    expect(screen.getByText("12")).toBeTruthy();
  });

  it("uses the owner kill-switch endpoint without deleting data", async () => {
    render(<PersonalVaultSettingsPage />);
    const toggle = await screen.findByRole("checkbox", {
      name: /Enable Personal Vault imports/i,
    });
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/user/personal-vault",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ enabled: false }),
        }),
      );
    });
    expect(screen.getByText(/It does not delete anything/i)).toBeTruthy();
  });

  it("renders Google live status and disconnects without invoking purge", async () => {
    render(<PersonalVaultSettingsPage />);
    expect(
      await screen.findByRole("heading", { name: "Live integrations" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Add Google account" }),
    ).toBeTruthy();
    expect(googleWorkspaceConnectHref()).toBe(
      "/api/oauth/start?provider=google&plugin=google-workspace&harness=papercusp&field=owner&scopes=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fcalendar.events",
    );
    expect(googleWorkspaceConnectHref(false)).toBe(
      "/api/oauth/start?provider=google&plugin=google-workspace&harness=papercusp&field=owner",
    );
    expect(googleWorkspaceConnectHref(true, "owner@example.com")).toBe(
      "/api/oauth/start?provider=google&plugin=google-workspace&harness=papercusp&field=owner&account=owner%40example.com&scopes=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fcalendar.events",
    );
    const googleCard = screen
      .getByRole("heading", { name: "Google Workspace" })
      .closest("article");
    expect(googleCard).toBeTruthy();
    const accountCard = within(googleCard!)
      .getByRole("heading", { name: "owner@example.com" })
      .closest("section");
    expect(accountCard).toBeTruthy();
    expect(
      within(accountCard!).getByRole("checkbox", {
        name: "Enable Gmail live sync for owner@example.com",
      }),
    ).toBeTruthy();
    expect(
      within(accountCard!).getByRole("checkbox", {
        name: "Enable Calendar live sync for owner@example.com",
      }),
    ).toBeTruthy();
    expect(
      within(accountCard!).getByText(
        /Turning off one capability affects only this account/i,
      ),
    ).toBeTruthy();
    const contactsToggle = within(accountCard!).getByRole("checkbox", {
      name: "Enable Contacts live sync for owner@example.com",
    });
    fireEvent.click(contactsToggle);
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/user/personal-vault/integrations/google/capabilities",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({
            providerAccountId: "owner@example.com",
            capability: "contacts",
            enabled: false,
          }),
        }),
      );
    });
    fireEvent.click(
      within(accountCard!).getByRole("button", {
        name: "Disconnect owner@example.com",
      }),
    );
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/user/personal-vault/integrations/google?account=owner%40example.com",
        { method: "DELETE" },
      );
    });
    expect(fetchMock).not.toHaveBeenCalledWith(
      "/api/user/personal-vault",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("shows an explicit consent upgrade for Calendar write access on the same connection", async () => {
    fetchMock.mockImplementationOnce(async () =>
      Response.json({
        ...status,
        integrations: {
          ...status.integrations,
          google: {
            ...status.integrations.google,
            accounts: status.integrations.google.accounts.map((account) => ({
              ...account,
              capabilities: account.capabilities.map((capability) =>
                capability.id === "calendar"
                  ? {
                      ...capability,
                      connected: false,
                      status: "needs-consent",
                      missingScopes: [
                        "https://www.googleapis.com/auth/calendar.events",
                      ],
                    }
                  : capability,
              ),
            })),
          },
        },
      }),
    );
    render(<PersonalVaultSettingsPage />);
    const card = (
      await screen.findByRole("heading", { name: "Google Workspace" })
    ).closest("article");
    expect(card).toBeTruthy();
    expect(
      within(card!).getByLabelText(
        "Calendar capability status for owner@example.com: needs-consent",
      ).textContent,
    ).toBe("Consent update required");
    expect(
      within(card!).getByRole("status", {
        name: "Calendar consent upgrade required for owner@example.com",
      }).textContent,
    ).toContain("never creates a second source");
    expect(
      within(card!).getByRole("button", {
        name: "Reconnect owner@example.com",
      }),
    ).toBeTruthy();
  });

  it("renders capability-accurate Facebook states and disconnects without purging settled data", async () => {
    render(<PersonalVaultSettingsPage />);
    const heading = await screen.findByRole("heading", { name: "Facebook" });
    const card = heading.closest("article");
    expect(card).toBeTruthy();
    expect(
      within(card!).getByLabelText("Facebook status: degraded").textContent,
    ).toBe("Degraded");
    expect(
      within(card!).getByText(
        /does not include Messenger, friends, private groups/i,
      ),
    ).toBeTruthy();
    expect(
      within(card!).getByText(/For fuller Facebook history/i),
    ).toBeTruthy();
    expect(
      within(card!).getByRole("button", { name: "Reconnect Facebook" }),
    ).toBeTruthy();
    expect(facebookPersonalVaultConnectHref()).toBe(
      "/api/oauth/start?provider=facebook&plugin=facebook-personal-vault&harness=papercusp&field=owner",
    );
    expect(
      screen.getByRole("note", { name: "Live integration privacy" })
        .textContent,
    ).toContain("Purge remains a separate, explicit action");

    fireEvent.click(within(card!).getByRole("button", { name: "Disconnect" }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/user/personal-vault/integrations/facebook",
        { method: "DELETE" },
      );
    });
    expect(fetchMock).not.toHaveBeenCalledWith(
      "/api/user/personal-vault",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it.each([
    ["needs-app-config", "Needs app setup", false],
    ["available", "Available", true],
    ["error", "Error", true],
  ] as const)(
    "renders the Facebook %s readiness state with the correct recovery affordance",
    async (integrationState, label, connectEnabled) => {
      fetchMock.mockImplementationOnce(async () =>
        Response.json({
          ...status,
          integrations: {
            ...status.integrations,
            facebook: {
              provider: "facebook",
              configured: integrationState !== "needs-app-config",
              connected: false,
              status: integrationState,
              sources: [],
            },
          },
        }),
      );
      render(<PersonalVaultSettingsPage />);
      const card = (
        await screen.findByRole("heading", { name: "Facebook" })
      ).closest("article");
      expect(card).toBeTruthy();
      expect(
        within(card!).getByLabelText("Facebook status: " + integrationState)
          .textContent,
      ).toBe(label);
      expect(
        (
          within(card!).getByRole("button", {
            name: "Connect Facebook",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(!connectEnabled);
      if (integrationState === "needs-app-config") {
        expect(within(card!).getByText(/clientSecretFile/)).toBeTruthy();
      }
    },
  );

  it("explains how to acquire supported provider archives with official links and formats", async () => {
    render(<PersonalVaultSettingsPage />);
    const instructions = (
      await screen.findByRole("heading", { name: "How to get an archive" })
    ).parentElement;
    expect(instructions?.textContent).toContain(
      "choose only Mail, Calendar, and Contacts",
    );
    expect(instructions?.textContent).toContain(
      "Choose Messages, all time, and JSON",
    );
    expect(instructions?.textContent).toContain(
      "Settings and privacy → Your account",
    );

    const links = screen.getAllByRole("link");
    expect(
      links
        .find((link) => link.textContent === "Google Takeout")
        ?.getAttribute("href"),
    ).toBe("https://takeout.google.com/settings/takeout");
    expect(
      links
        .find((link) => link.textContent === "Export your information guide")
        ?.getAttribute("href"),
    ).toBe("https://www.facebook.com/help/212802592074644");
    expect(
      links
        .find((link) => link.textContent === "official X archive guide")
        ?.getAttribute("href"),
    ).toBe("https://help.x.com/en/managing-your-account/accessing-your-x-data");
    expect(
      links.every((link) => link.getAttribute("target") === "_blank"),
    ).toBe(true);
    expect(
      links.every((link) => link.getAttribute("rel")?.includes("noopener")),
    ).toBe(true);
  });

  it("previews the plan declaration before the owner can approve it", async () => {
    render(<PersonalVaultSettingsPage />);
    fireEvent.change(await screen.findByLabelText("Plan slug"), {
      target: { value: "meeting-prep-brief" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Review access" }));
    expect(
      await screen.findByRole("heading", {
        name: "Approve access for meeting-prep-brief",
      }),
    ).toBeTruthy();
    expect(screen.getAllByText("personal:gmail").length).toBeGreaterThanOrEqual(
      2,
    );
    expect(screen.getByText("personal:calendar")).toBeTruthy();
    expect(
      (
        screen.getByRole("button", {
          name: "Approve declared scopes",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });
});
