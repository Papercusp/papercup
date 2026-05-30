# RESTORE — `@papercup/web` (papercupai.com public site)

**Retired:** 2026-05-30. **Preserved, not deleted.** This is the full, intact app
(the former `apps/papercup`). Nothing was removed — it was only relocated here and
unwired from the active build so agents stop treating it as live.

- **Last-active commit:** `509f7267` (on branch `feat/psu-wrappers` at retirement).
- **Restore tag:** `papercup-web-retired-2026-05-30` (annotated; points at the last
  commit where this lived at `apps/papercup` and was fully wired in).
- **What it was:** the public papercupai.com Next.js site — a registry render, a
  sanitized read-only Hono API, and a rate-limited public chat with a $0.50/day
  global cost cap.

## Restore — exact steps

1. Move the code back into the active tree (re-enters the `apps/*` workspace glob):

   ```
   git mv _retired/papercup apps/papercup
   ```

2. Re-add the two root `package.json` scripts that were removed:

   ```jsonc
   "dev:papercup":   "npm --workspace @papercup/web run dev",   // after "tokens:check"
   "build:papercup": "npm --workspace @papercup/web run build", // before "build:operator"
   ```

3. Re-add the `knip.json` workspace entry that was removed (place before `"libs/**"`):

   ```jsonc
   "apps/papercup": {
     "entry": [
       "app/**/{page,layout,loading,error,not-found,template,default,route}.{ts,tsx}",
       "lib/**/*.{ts,tsx}",
       "next.config.*"
     ]
   },
   ```

4. Un-banner the deploy config: remove the `⛔ RETIRED` header block from
   `docker-compose.papercup.prod.yml` and `Dockerfile.papercup`. Their
   `apps/papercup` paths are already correct for the restored location.

5. Remove the `"//retired"` marker key from this app's `package.json`.

6. Reinstall so npm re-links the workspace:

   ```
   npm install
   ```

7. Remove this app's row from the "Retired / preserved-not-active surfaces" table in
   the root `CLAUDE.md`.

## Exact-restore fallback (if `_retired/papercup/` is ever lost)

The tag still has the full app at its last-active path:

```
git checkout papercup-web-retired-2026-05-30 -- apps/papercup
```

then follow steps 2–7 above.
