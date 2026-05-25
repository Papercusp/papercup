// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueueAvatarCluster, type QueueAvatarMember } from '../QueueAvatarCluster';

afterEach(() => cleanup());

function mk(id: number, opts: Partial<QueueAvatarMember> = {}): QueueAvatarMember {
  return {
    github_user_id: id,
    github_username: `u${id}`,
    display_name: null,
    avatar_url: null,
    ...opts,
  };
}

describe('QueueAvatarCluster', () => {
  it('renders em-dash for empty members', () => {
    render(<QueueAvatarCluster members={[]} />);
    expect(screen.getByTestId('queue-avatars-empty')).toBeTruthy();
  });

  it('renders <img> when avatar_url present', () => {
    render(
      <QueueAvatarCluster
        members={[mk(1, { avatar_url: 'https://a.png', display_name: 'Alice' })]}
      />,
    );
    const img = screen.getByTestId('queue-avatar-1') as HTMLImageElement;
    expect(img.tagName).toBe('IMG');
    expect(img.src).toContain('a.png');
    expect(img.alt).toBe('Alice');
  });

  it('renders initial fallback when avatar_url is null', () => {
    render(
      <QueueAvatarCluster
        members={[mk(2, { display_name: 'Bob' })]}
      />,
    );
    const el = screen.getByTestId('queue-avatar-2');
    expect(el.tagName).not.toBe('IMG');
    expect(el.textContent).toBe('B');
  });

  it('falls back to github_username for initial when display_name missing', () => {
    render(<QueueAvatarCluster members={[mk(3, { github_username: 'zara' })]} />);
    expect(screen.getByTestId('queue-avatar-3').textContent).toBe('Z');
  });

  it('uses ? when both display_name and github_username are empty', () => {
    render(<QueueAvatarCluster members={[mk(4, { github_username: '' })]} />);
    expect(screen.getByTestId('queue-avatar-4').textContent).toBe('?');
  });

  it('caps visible avatars at max (default 5) and shows +N overflow', () => {
    const members = [1, 2, 3, 4, 5, 6, 7].map((i) => mk(i));
    render(<QueueAvatarCluster members={members} />);
    expect(screen.queryByTestId('queue-avatar-5')).toBeTruthy();
    expect(screen.queryByTestId('queue-avatar-6')).toBeFalsy();
    const overflow = screen.getByTestId('queue-avatars-overflow');
    expect(overflow.textContent).toBe('+2');
  });

  it('respects custom max', () => {
    const members = [1, 2, 3, 4, 5].map((i) => mk(i));
    render(<QueueAvatarCluster members={members} max={2} />);
    expect(screen.queryByTestId('queue-avatar-1')).toBeTruthy();
    expect(screen.queryByTestId('queue-avatar-2')).toBeTruthy();
    expect(screen.queryByTestId('queue-avatar-3')).toBeFalsy();
    expect(screen.getByTestId('queue-avatars-overflow').textContent).toBe('+3');
  });

  it('omits overflow pill when count ≤ max', () => {
    render(<QueueAvatarCluster members={[mk(1), mk(2)]} max={5} />);
    expect(screen.queryByTestId('queue-avatars-overflow')).toBeFalsy();
  });

  it('sets tooltip to count text for multiple members', () => {
    render(<QueueAvatarCluster members={[mk(1), mk(2), mk(3)]} />);
    const wrap = screen.getByTestId('queue-avatars');
    expect(wrap.title).toBe('3 people have this queued');
  });

  it('sets tooltip to "<name> has this queued" for single member', () => {
    render(
      <QueueAvatarCluster
        members={[mk(1, { display_name: 'Alice' })]}
      />,
    );
    expect(screen.getByTestId('queue-avatars').title).toBe('Alice has this queued');
  });
});
