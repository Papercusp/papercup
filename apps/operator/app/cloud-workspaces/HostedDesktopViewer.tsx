"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Expand, Minimize2, Monitor, RefreshCw } from "lucide-react";
import { Button } from "@/app/harness/Button";
import {
  buildHostedDesktopSocketUrl,
  HostedDesktopRelayChannel,
  readHostedDesktopTicket,
  type HostedDesktopViewerMode,
} from "./hosted-desktop-viewer-protocol";
import {
  readHostedWorkspaceTicket,
  type HostedWorkspaceSessionStatus,
} from "./hosted-workspace-session-protocol";
import styles from "./hosted-workspace-session.module.css";

export type HostedDesktopViewerState =
  | "idle"
  | "ticketing"
  | "connecting"
  | "connected"
  | "closed"
  | "error";

function requestId(prefix: string): string {
  const suffix =
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${suffix}`;
}

function responseError(value: unknown, fallback: string): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;
  const payload = value as Record<string, unknown>;
  const nested =
    payload.error && typeof payload.error === "object" && !Array.isArray(payload.error)
      ? (payload.error as Record<string, unknown>)
      : null;
  const code =
    typeof nested?.code === "string"
      ? nested.code
      : typeof payload.error === "string"
        ? payload.error
        : null;
  return code ? `${fallback}: ${code}` : fallback;
}

export interface HostedDesktopViewerProps {
  workspaceId: string;
  hostId: string;
  routeLabel: string;
  desktopSessionId: string;
  desktopLabel?: string;
  mode?: HostedDesktopViewerMode;
  onStateChange?: (state: HostedDesktopViewerState) => void;
}

export function HostedDesktopViewer({
  workspaceId,
  hostId,
  routeLabel,
  desktopSessionId,
  desktopLabel,
  mode = "watch",
  onStateChange,
}: HostedDesktopViewerProps) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const channelRef = useRef<HostedDesktopRelayChannel | null>(null);
  const rfbRef = useRef<import("@novnc/novnc").default | null>(null);
  const epochRef = useRef(0);
  const [state, setState] = useState<HostedDesktopViewerState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [inputAllowed, setInputAllowed] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);

  const updateState = useCallback(
    (next: HostedDesktopViewerState) => {
      setState(next);
      onStateChange?.(next);
    },
    [onStateChange],
  );

  const disconnect = useCallback(() => {
    epochRef.current += 1;
    rfbRef.current?.disconnect();
    rfbRef.current = null;
    channelRef.current?.close(1000, "viewer_detached");
    channelRef.current = null;
    const socket = socketRef.current;
    socketRef.current = null;
    try {
      socket?.close(1000, "viewer_detached");
    } catch {
      // Already closed.
    }
  }, []);

  const connect = useCallback(async () => {
    disconnect();
    const epoch = epochRef.current;
    setError(null);
    setInputAllowed(false);
    updateState("ticketing");

    try {
      const response = await fetch(
        `/api/hosted/workspaces/${encodeURIComponent(workspaceId)}/connectors/session-ticket`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            hostId,
            routeLabel,
            transport: "websocket",
            audience: "workspace-operator",
          }),
        },
      );
      const payload = await response.json().catch(() => null);
      const ticket = readHostedDesktopTicket(payload) ?? readHostedWorkspaceTicket(payload);
      if (!response.ok || !ticket) {
        throw new Error(
          responseError(payload, "Could not mint a desktop viewer ticket"),
        );
      }
      if (epoch !== epochRef.current || !stageRef.current) return;

      updateState("connecting");
      const socket = new WebSocket(
        buildHostedDesktopSocketUrl(
          window.location.origin,
          ticket,
          desktopSessionId,
          mode,
        ),
      );
      socketRef.current = socket;
      const channel = new HostedDesktopRelayChannel(socket);
      channelRef.current = channel;
      channel.onopen = () => {
        if (epoch !== epochRef.current) return;
        updateState("connecting");
      };
      channel.onerror = (event) => {
        if (epoch !== epochRef.current) return;
        const detail =
          event && typeof event === "object" && "code" in event
            ? String((event as { code?: unknown }).code)
            : "desktop_relay_failed";
        setError(detail);
        updateState("error");
      };
      channel.onclose = (event) => {
        if (epoch !== epochRef.current) return;
        const reason = event.reason?.trim();
        setError(reason || null);
        updateState("closed");
      };
      const { default: RFB } = await import("@novnc/novnc");
      if (epoch !== epochRef.current || !stageRef.current) {
        channel.close(1000, "superseded");
        return;
      }
      const rfb = new RFB(
        stageRef.current,
        channel as unknown as WebSocket,
        { shared: true },
      );
      rfb.viewOnly = mode === "watch";
      rfb.scaleViewport = true;
      rfb.clipViewport = true;
      rfb.resizeSession = false;
      rfb.focusOnClick = true;
      rfb.background =
        getComputedStyle(document.documentElement).getPropertyValue("--bg-deeper").trim() ||
        "#101418";
      rfb.addEventListener("connect", () => {
        if (epoch === epochRef.current) updateState("connected");
      });
      rfb.addEventListener("disconnect", () => {
        if (epoch === epochRef.current) updateState("closed");
      });
      rfbRef.current = rfb;
    } catch (cause) {
      if (epoch !== epochRef.current) return;
      setError(cause instanceof Error ? cause.message : String(cause));
      updateState("error");
    }
  }, [
    desktopSessionId,
    disconnect,
    hostId,
    mode,
    routeLabel,
    updateState,
    workspaceId,
  ]);

  useEffect(() => {
    void connect();
    return () => disconnect();
  }, [connect, disconnect]);

  useEffect(() => {
    const onFullscreenChange = () => {
      setFullscreen(document.fullscreenElement === stageRef.current?.parentElement);
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, []);

  const toggleFullscreen = useCallback(async () => {
    const target = stageRef.current?.parentElement;
    if (!target || !document.fullscreenEnabled) return;
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await target.requestFullscreen();
    } catch {
      setError("Fullscreen is unavailable in this browser.");
    }
  }, []);

  const statusLabel =
    state === "connected"
      ? inputAllowed
        ? "connected · takeover"
        : "connected · watch-only"
      : state === "error"
        ? `error${error ? ` · ${error}` : ""}`
        : state;

  return (
    <section
      className={styles.desktopPanel}
      aria-label={`Desktop viewer${desktopLabel ? ` for ${desktopLabel}` : ""}`}
      data-state={state}
      data-input-allowed={inputAllowed ? "true" : "false"}
    >
      <div className={styles.desktopHeader}>
        <div>
          <strong>
            <Monitor size={13} aria-hidden="true" /> Desktop stream
          </strong>
          <span>
            {desktopLabel ?? desktopSessionId} ·{" "}
            {mode === "takeover" ? "takeover requested" : "watch requested"}
          </span>
        </div>
        <div className={styles.desktopActions}>
          <span className={styles.desktopStatus} aria-live="polite">
            {statusLabel}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void connect()}
            disabled={state === "ticketing" || state === "connecting"}
          >
            <RefreshCw size={12} aria-hidden="true" /> Reconnect
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void toggleFullscreen()}
            disabled={!document.fullscreenEnabled}
            title={
              document.fullscreenEnabled
                ? "Toggle fullscreen desktop viewer"
                : "Fullscreen is unavailable in this browser"
            }
          >
            {fullscreen ? (
              <Minimize2 size={12} aria-hidden="true" />
            ) : (
              <Expand size={12} aria-hidden="true" />
            )}{" "}
            {fullscreen ? "Exit fullscreen" : "Fullscreen"}
          </Button>
        </div>
      </div>
      <div className={styles.desktopStage} ref={stageRef}>
        {state !== "connected" ? (
          <div className={styles.desktopPlaceholder}>
            {state === "error"
              ? `Desktop stream failed${error ? `: ${error}` : "."}`
              : state === "closed"
                ? "Desktop stream ended. Reconnect to resume it."
                : "Opening the generation-bound desktop stream…"}
          </div>
        ) : null}
      </div>
      <div className={styles.desktopFooter}>
        <span>
          {inputAllowed
            ? "Input is enabled by the takeover credential."
            : "Watch-only mode keeps keyboard and pointer input disabled."}
        </span>
        <span>PTY and desktop reconnect independently.</span>
      </div>
    </section>
  );
}

