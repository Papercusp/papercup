'use client';

/**
 * <details>-equivalent that defers mounting children until the first open.
 *
 * Why: native <details> in React still renders its children into the DOM
 * regardless of `open`; the browser just toggles visibility. For sections
 * with large/expensive children (tables of N rows × M voice options) this
 * makes initial page render slow even when the section is collapsed.
 *
 * Drop-in replacement: same DOM (uses native <details> so OS-native
 * keyboard/a11y behaviour is preserved), but children only mount after
 * the user actually expands. Once mounted, children stay mounted across
 * subsequent collapse/expand cycles so internal state (open dropdowns,
 * input focus, etc.) survives.
 */

import { useRef, useState, type ReactNode, type CSSProperties } from 'react';

interface LazyDetailsProps {
  summary: ReactNode;
  children: ReactNode;
  /** Open by default. Defaults to false. */
  defaultOpen?: boolean;
  /** Style passed to the outer <details>. */
  style?: CSSProperties;
  /** Style passed to the <summary>. */
  summaryStyle?: CSSProperties;
  /** Class passed to the outer <details>. */
  className?: string;
  /** Class passed to the <summary>. */
  summaryClassName?: string;
}

export function LazyDetails({
  summary,
  children,
  defaultOpen = false,
  style,
  summaryStyle,
  className,
  summaryClassName,
}: LazyDetailsProps) {
  const [opened, setOpened] = useState(defaultOpen);
  const ref = useRef<HTMLDetailsElement>(null);
  return (
    <details
      ref={ref}
      className={className}
      style={style}
      open={defaultOpen || undefined}
      onToggle={() => {
        if (ref.current?.open && !opened) setOpened(true);
      }}
    >
      <summary className={summaryClassName} style={summaryStyle}>{summary}</summary>
      {opened ? children : null}
    </details>
  );
}
