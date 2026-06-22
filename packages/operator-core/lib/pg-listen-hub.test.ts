/**
 * Unit tests for `listenHubEnabled()` — C1-3 de-dark (default-on for server-class,
 * "finished work must not ship dark"), D-002 @ backend-connection-scaling-2026-06-17.
 * No Postgres: importing ./pg-listen-hub does not open a connection (the shared
 * `sql` instance is created lazily on the first `hubListen`).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

// listenHubEnabled() consults getResourceProfile().hostClass for the unset-env
// default. Mock it so the default is deterministic regardless of the test host's
// core count. Same module specifier pg-listen-hub.ts imports.
const mockProfile = vi.hoisted(() => ({
  hostClass: "server" as "server" | "workstation" | "laptop",
}));
vi.mock("./resource-profile", () => ({
  getResourceProfile: () => ({ hostClass: mockProfile.hostClass }),
}));

import { listenHubEnabled } from "./pg-listen-hub";

const saved = { hub: process.env.PAPERCUSP_LISTEN_HUB };
afterEach(() => {
  if (saved.hub === undefined) delete process.env.PAPERCUSP_LISTEN_HUB;
  else process.env.PAPERCUSP_LISTEN_HUB = saved.hub;
  mockProfile.hostClass = "server";
});

describe("listenHubEnabled — C1-3 default-on for server-class", () => {
  it("defaults ON when env is unset and the host is server-class", () => {
    delete process.env.PAPERCUSP_LISTEN_HUB;
    mockProfile.hostClass = "server";
    expect(listenHubEnabled()).toBe(true);
  });

  it("defaults OFF on laptop/workstation (the Tauri desktop, embedded PG)", () => {
    delete process.env.PAPERCUSP_LISTEN_HUB;
    mockProfile.hostClass = "laptop";
    expect(listenHubEnabled()).toBe(false);
    mockProfile.hostClass = "workstation";
    expect(listenHubEnabled()).toBe(false);
  });

  it("PAPERCUSP_LISTEN_HUB=1 forces ON even on a laptop", () => {
    process.env.PAPERCUSP_LISTEN_HUB = "1";
    mockProfile.hostClass = "laptop";
    expect(listenHubEnabled()).toBe(true);
  });

  it("PAPERCUSP_LISTEN_HUB=0 is the kill-switch — forces OFF even on a server", () => {
    process.env.PAPERCUSP_LISTEN_HUB = "0";
    mockProfile.hostClass = "server";
    expect(listenHubEnabled()).toBe(false);
  });

  it("an unrecognized flag value falls through to the host-class default", () => {
    process.env.PAPERCUSP_LISTEN_HUB = "true";
    mockProfile.hostClass = "server";
    expect(listenHubEnabled()).toBe(true); // server → default on
    mockProfile.hostClass = "laptop";
    expect(listenHubEnabled()).toBe(false); // laptop → default off
  });
});
