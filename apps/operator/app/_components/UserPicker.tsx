'use client';

import { useEffect, useState, useCallback } from 'react';
import { toast } from 'sonner';
import { ChevronDown, UserPlus, Settings, LogOut, ArrowLeftRight } from 'lucide-react';
import { Popover } from '../harness/Popover';

interface User {
  id: string;
  username: string;
  display_name: string;
  has_password: boolean;
}

const FALLBACK_USER: User = {
  id: '00000000-0000-0000-0000-000000000001',
  username: 'default',
  display_name: 'User',
  has_password: false,
};

export default function UserPicker() {
  const [user, setUser] = useState<User>(FALLBACK_USER);
  const [autoLogin, setAutoLogin] = useState(true);
  // Menu open state is transient — using nuqs/useQueryState here caused a
  // race where setOpen(false)'s shallow URL replaceState overwrote the
  // path that router.push() had just set, making every item appear to
  // do nothing. Plain useState is the right tool for "is the dropdown
  // open right now".
  const [open, setOpen] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const r = await fetch('/api/auth/me');
        if (!r.ok) {
          setUser(FALLBACK_USER);
          setAutoLogin(true);
          return;
        }
        const j = await r.json();
        setUser(j.user ?? FALLBACK_USER);
        setAutoLogin(j.autoLogin === true || j.user == null);
      } catch {
        setUser(FALLBACK_USER);
        setAutoLogin(true);
      }
    })();
  }, []);

  const close = useCallback(() => {
    setOpen(false);
  }, []);

  // Hard navigation. router.push() consistently no-ops from inside the
  // harness route (something in the harness layout / dock reducer
  // captures soft transitions originating from a Radix Popover Portal
  // and reverts them). window.location.assign always wins — these
  // destinations (settings, login, signup) are out-of-context anyway,
  // so the full page reload is the right thing for them.
  const goTo = useCallback((href: string) => {
    close();
    if (typeof window !== 'undefined') window.location.assign(href);
  }, [close]);

  const onLogout = useCallback(async () => {
    close();
    try {
      const response = await fetch('/api/auth/logout', { method: 'POST' });
      if (!response.ok) throw new Error('logout failed');
      toast.success('Logged out');
      if (typeof window !== 'undefined') window.location.assign('/login');
    } catch {
      toast.error('Logout failed');
    }
  }, [close]);


  const displayName = user.display_name || user.username || 'User';
  const username = user.username || 'default';
  const initial = (displayName.trim()[0] || username.trim()[0] || 'U').toUpperCase();
  const signedInLabel = autoLogin ? 'Auto-signed in' : 'Signed in';

  return (
    <span className="pc-user-picker">
      <Popover
        open={open}
        onOpenChange={setOpen}
        ariaLabel="Account menu"
        tooltipLabel={`${signedInLabel} as ${displayName}`}
        side="bottom"
        align="end"
        sideOffset={8}
        zIndex={1400}
        contentClassName="pc-user-menu pc-animate-in pc-animate-in--down pc-animate-in--fast"
        trigger={
          <button
            type="button"
            className="pc-user-trigger"
            aria-label={`${signedInLabel} as ${displayName}. Open account menu.`}
            aria-haspopup="dialog"
            aria-expanded={open}
          >
            <span className="pc-user-avatar" aria-hidden="true">{initial}</span>
            <span className="pc-user-trigger-copy">
              <span className="pc-user-trigger-name">{displayName}</span>
              {autoLogin && <span className="pc-user-trigger-status">auto</span>}
            </span>
            <ChevronDown className="pc-user-caret" size={12} aria-hidden="true" strokeWidth={1.75} />
          </button>
        }
      >
        <div className="pc-user-menu-head">
          <span className="pc-user-menu-avatar" aria-hidden="true">{initial}</span>
          <span className="pc-user-menu-identity">
            <strong>{displayName}</strong>
            <span>@{username}</span>
          </span>
          <span className="pc-user-auth-chip">{autoLogin ? 'Auto' : 'Active'}</span>
        </div>

        <div className="pc-user-menu-section" aria-label="Account actions">
          <button type="button" className="pc-user-menu-item" onClick={() => goTo('/settings/user')}>
            <Settings size={15} aria-hidden="true" strokeWidth={1.75} />
            <span>
              <strong>User preferences</strong>
              <small>Profile, theme, and defaults</small>
            </span>
          </button>
          <button type="button" className="pc-user-menu-item" onClick={() => goTo('/login?switch=1')}>
            <ArrowLeftRight size={15} aria-hidden="true" strokeWidth={1.75} />
            <span>
              <strong>Switch user</strong>
              <small>Sign in as someone else</small>
            </span>
          </button>
          <button type="button" className="pc-user-menu-item" onClick={() => goTo('/signup')}>
            <UserPlus size={15} aria-hidden="true" strokeWidth={1.75} />
            <span>
              <strong>Add user</strong>
              <small>Create another local account</small>
            </span>
          </button>
        </div>

        <div className="pc-user-menu-divider" />

        <button type="button" className="pc-user-menu-item pc-user-menu-item--danger" onClick={onLogout}>
          <LogOut size={15} aria-hidden="true" strokeWidth={1.75} />
          <span>
            <strong>Log out</strong>
            <small>Return to sign in</small>
          </span>
        </button>
      </Popover>
    </span>
  );
}
