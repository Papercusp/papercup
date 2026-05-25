'use client';

import { useEffect, useState } from 'react';

export interface LocalGithubUser {
  id: number;
  login: string;
}

let cached: LocalGithubUser | null | undefined; // undefined = not yet fetched

export function useLocalGithubUser(): LocalGithubUser | null {
  const [user, setUser] = useState<LocalGithubUser | null>(cached ?? null);

  useEffect(() => {
    if (cached !== undefined) {
      setUser(cached);
      return;
    }
    fetch('/api/desktop/github-user', { cache: 'no-store' })
      .then((r) => (r.ok ? (r.json() as Promise<LocalGithubUser>) : null))
      .then((u) => {
        cached = u;
        setUser(u);
      })
      .catch(() => {
        cached = null;
        setUser(null);
      });
  }, []);

  return user;
}
