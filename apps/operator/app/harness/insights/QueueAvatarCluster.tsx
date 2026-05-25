'use client';

/**
 * QueueAvatarCluster — Phase 5b P-032b.
 *
 * Plan: papercusp-dogfood-phase5b-hyperbee-ui-integration-2026-05-24.
 * v5 §9.1 Features tab — per-feature avatar cluster of who has this
 * feature queued (up to 5; "+N more" overflow).
 *
 * Pure UI. Consumer feeds a list of queue members; component just
 * renders. Tests cover overflow, empty state, fallbacks.
 */

import type { CSSProperties, ReactNode } from 'react';

export interface QueueAvatarMember {
  github_user_id: number;
  github_username: string;
  display_name: string | null;
  avatar_url: string | null;
}

export interface QueueAvatarClusterProps {
  members: QueueAvatarMember[];
  /** Cap on visible avatars; the rest collapse into +N. Default 5. */
  max?: number;
  /** Override the avatar size in px. Default 20. */
  size?: number;
}

const ROW: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
};

function avatarBase(size: number): CSSProperties {
  return {
    width: size,
    height: size,
    borderRadius: '50%',
    border: '1.5px solid var(--surface, #1a1a1a)',
    marginLeft: -6,
    display: 'block',
    background: 'var(--surface-2, #2a2a2a)',
    objectFit: 'cover',
  };
}

function overflowPillStyle(size: number): CSSProperties {
  return {
    ...avatarBase(size),
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: Math.max(9, Math.round(size * 0.45)),
    fontWeight: 600,
    color: 'var(--fg-dim, #aaa)',
  };
}

function initial(m: QueueAvatarMember): string {
  const name = m.display_name || m.github_username;
  return name ? name.slice(0, 1).toUpperCase() : '?';
}

export function QueueAvatarCluster(props: QueueAvatarClusterProps): ReactNode {
  const max = props.max ?? 5;
  const size = props.size ?? 20;
  const members = props.members ?? [];
  if (members.length === 0) {
    return (
      <span
        data-testid="queue-avatars-empty"
        style={{ fontSize: 11, color: 'var(--fg-dim, #888)' }}
      >
        —
      </span>
    );
  }
  const visible = members.slice(0, max);
  const overflow = Math.max(0, members.length - visible.length);
  return (
    <span
      data-testid="queue-avatars"
      style={ROW}
      title={
        members.length === 1
          ? `${members[0].display_name || members[0].github_username} has this queued`
          : `${members.length} people have this queued`
      }
    >
      {visible.map((m) =>
        m.avatar_url ? (
          <img
            key={m.github_user_id}
            data-testid={`queue-avatar-${m.github_user_id}`}
            src={m.avatar_url}
            alt={m.display_name || m.github_username}
            style={avatarBase(size)}
            loading="lazy"
          />
        ) : (
          <span
            key={m.github_user_id}
            data-testid={`queue-avatar-${m.github_user_id}`}
            style={overflowPillStyle(size)}
            title={m.display_name || m.github_username}
          >
            {initial(m)}
          </span>
        ),
      )}
      {overflow > 0 && (
        <span
          data-testid="queue-avatars-overflow"
          style={overflowPillStyle(size)}
        >
          +{overflow}
        </span>
      )}
    </span>
  );
}
