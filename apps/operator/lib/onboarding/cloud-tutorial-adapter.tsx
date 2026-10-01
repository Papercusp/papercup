"use client";

import { useEffect } from "react";
import { driver } from "driver.js";
import "driver.js/dist/driver.css";

export type HighlightStatus = "waiting" | "missing" | "ready";

/** Highlighting observes the app. It never clicks a target or advances a lesson. */
export function CloudTutorialHighlight({
  target,
  active,
  contextKey,
  reducedMotion = false,
  onStatus,
}: {
  target: string;
  active: boolean;
  contextKey: string;
  reducedMotion?: boolean;
  onStatus?: (status: HighlightStatus) => void;
}) {
  useEffect(() => {
    if (!active) return;
    const focus = document.activeElement as HTMLElement | null;
    const highlight = driver({
      animate: !reducedMotion,
      smoothScroll: false,
      allowScroll: true,
      allowKeyboardControl: false,
      disableActiveInteraction: false,
      advanceOnClick: false,
      overlayOpacity: 0.12,
      stagePadding: 8,
      stageRadius: 8,
    });
    let current: HTMLElement | null = null;
    let disposed = false;
    const observe = () => {
      if (disposed) return;
      const element = document.querySelector<HTMLElement>(target);
      if (element === current) return;
      if (current) highlight.destroy();
      current = element;
      if (element) {
        highlight.highlight({ element });
        // The guide is nonmodal: unrelated app controls and its own panel stay usable.
        const overlay = document.querySelector<SVGElement>(".driver-overlay");
        if (overlay) overlay.style.pointerEvents = "none";
        onStatus?.("ready");
      } else {
        onStatus?.("waiting");
      }
    };
    onStatus?.("waiting");
    const observer = new MutationObserver(observe);
    observer.observe(document.body, { childList: true, subtree: true });
    observe();
    const timeout = window.setTimeout(() => {
      if (!current) onStatus?.("missing");
    }, 1500);
    return () => {
      disposed = true;
      observer.disconnect();
      window.clearTimeout(timeout);
      highlight.destroy();
      if (focus?.isConnected) focus.focus({ preventScroll: true });
    };
  }, [target, active, contextKey, reducedMotion, onStatus]);
  return null;
}
