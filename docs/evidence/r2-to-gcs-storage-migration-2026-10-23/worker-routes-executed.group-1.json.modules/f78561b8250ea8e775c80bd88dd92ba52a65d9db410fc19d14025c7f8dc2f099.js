'use strict';async (__vite_ssr_exports__,__vite_ssr_import_meta__,__vite_ssr_import__,__vite_ssr_dynamic_import__,__vite_ssr_exportAll__,__vite_ssr_exportName__,__filename,__dirname,module,exports,require)=>{{__vite_ssr_exportName__("meRoute", () => { try { return meRoute } catch {} });
const __vite_ssr_import_0__ = await __vite_ssr_import__("/@fs/home/marsh-office/papercupai-workspace/papercusp/node_modules/hono/dist/index.js", {"importedNames":["Hono"]});
const __vite_ssr_import_1__ = await __vite_ssr_import__("/src/auth.ts", {"importedNames":["AuthError","resolveGithubBearer"]});
const __vite_ssr_import_2__ = await __vite_ssr_import__("/src/db.ts", {"importedNames":["listCreatorDrafts","listPublisherListings"]});
const __vite_ssr_import_3__ = await __vite_ssr_import__("/src/routes/creator-drafts.ts", {"importedNames":["draftResponse"]});




function meRoute() {
  const app = new __vite_ssr_import_0__.Hono();
  app.get("/me/listings", async (c) => {
    let user;
    try {
      user = await (0,__vite_ssr_import_1__.resolveGithubBearer)(c.req.raw);
    } catch (e) {
      if (e instanceof __vite_ssr_import_1__.AuthError) return c.json({ error: "auth", reason: e.reason }, 401);
      throw e;
    };
    const params = new URL(c.req.url).searchParams;
    const rawLimit = Number.parseInt(params.get("limit") ?? "100", 10);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 200) : 100;
    const rawCursor = params.get("cursor") ?? "0";
    const offset = Number(rawCursor);
    if (!/^\d+$/.test(rawCursor) || !Number.isSafeInteger(offset)) {
      return c.json({ error: "invalid_field", field: "cursor" }, 400);
    };
    const [listings, drafts] = await Promise.all([
      (0,__vite_ssr_import_2__.listPublisherListings)(c.env.DB, { publisherId: user.id, limit: limit + 1, offset }),
      (0,__vite_ssr_import_2__.listCreatorDrafts)(c.env.DB, { ownerId: user.id, limit: limit + 1, offset })
    ]);
    c.header("Cache-Control", "private, no-store");
    return c.json({
      listings: listings.slice(0, limit),
      drafts: drafts.slice(0, limit).map((draft) => (0,__vite_ssr_import_3__.draftResponse)(draft)),
      next_cursor: listings.length > limit || drafts.length > limit ? String(offset + limit) : null
    });
  });
  return app;
}
//# sourceMappingSource=vite-generated
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJtYXBwaW5ncyI6IkFBQUEsQ0FBQTtBQUFBO0FBRUE7QUFDQTtBQUNBOzs7OztBQUdPLFNBQVMsVUFBbUM7QUFDakQsUUFBTSxNQUFNLElBQUksMkJBQXdCO0FBRXhDLE1BQUksSUFBSSxnQkFBZ0IsT0FBTyxNQUFNO0FBQ25DLFFBQUk7QUFDSixRQUFJO0FBQ0YsYUFBTyxTQUFNLDJDQUFvQixFQUFFLElBQUksR0FBRztBQUFBLElBQzVDLFNBQVMsR0FBRztBQUNWLFVBQUksYUFBYSxnQ0FBVyxRQUFPLEVBQUUsS0FBSyxFQUFFLE9BQU8sUUFBUSxRQUFRLEVBQUUsT0FBTyxHQUFHLEdBQUc7QUFDbEYsWUFBTTtBQUFBLElBQ1I7QUFDQSxVQUFNLFNBQVMsSUFBSSxJQUFJLEVBQUUsSUFBSSxHQUFHLEVBQUU7QUFDbEMsVUFBTSxXQUFXLE9BQU8sU0FBUyxPQUFPLElBQUksT0FBTyxLQUFLLE9BQU8sRUFBRTtBQUNqRSxVQUFNLFFBQVEsT0FBTyxTQUFTLFFBQVEsSUFBSSxLQUFLLElBQUksS0FBSyxJQUFJLFVBQVUsQ0FBQyxHQUFHLEdBQUcsSUFBSTtBQUNqRixVQUFNLFlBQVksT0FBTyxJQUFJLFFBQVEsS0FBSztBQUMxQyxVQUFNLFNBQVMsT0FBTyxTQUFTO0FBQy9CLFFBQUksQ0FBQyxRQUFRLEtBQUssU0FBUyxLQUFLLENBQUMsT0FBTyxjQUFjLE1BQU0sR0FBRztBQUM3RCxhQUFPLEVBQUUsS0FBSyxFQUFFLE9BQU8saUJBQWlCLE9BQU8sU0FBUyxHQUFHLEdBQUc7QUFBQSxJQUNoRTtBQUNBLFVBQU0sQ0FBQyxVQUFVLE1BQU0sSUFBSSxNQUFNLFFBQVEsSUFBSTtBQUFBLFNBQzNDLDZDQUFzQixFQUFFLElBQUksSUFBSSxFQUFFLGFBQWEsS0FBSyxJQUFJLE9BQU8sUUFBUSxHQUFHLE9BQU8sQ0FBQztBQUFBLFNBQ2xGLHlDQUFrQixFQUFFLElBQUksSUFBSSxFQUFFLFNBQVMsS0FBSyxJQUFJLE9BQU8sUUFBUSxHQUFHLE9BQU8sQ0FBQztBQUFBLElBQzVFLENBQUM7QUFDRCxNQUFFLE9BQU8saUJBQWlCLG1CQUFtQjtBQUM3QyxXQUFPLEVBQUUsS0FBSztBQUFBLE1BQ1osVUFBVSxTQUFTLE1BQU0sR0FBRyxLQUFLO0FBQUEsTUFDakMsUUFBUSxPQUFPLE1BQU0sR0FBRyxLQUFLLEVBQUUsSUFBSSxDQUFDLGFBQVUscUNBQWMsS0FBSyxDQUFDO0FBQUEsTUFDbEUsYUFBYSxTQUFTLFNBQVMsU0FBUyxPQUFPLFNBQVMsUUFBUSxPQUFPLFNBQVMsS0FBSyxJQUFJO0FBQUEsSUFDM0YsQ0FBQztBQUFBLEVBQ0gsQ0FBQztBQUVELFNBQU87QUFDVCIsIm5hbWVzIjpbXSwiaWdub3JlTGlzdCI6W10sInNvdXJjZXMiOlsibWUudHMiXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgSG9ubyB9IGZyb20gJ2hvbm8nO1xuaW1wb3J0IHR5cGUgeyBFbnYgfSBmcm9tICcuLi9lbnYudHMnO1xuaW1wb3J0IHsgQXV0aEVycm9yLCByZXNvbHZlR2l0aHViQmVhcmVyIH0gZnJvbSAnLi4vYXV0aC50cyc7XG5pbXBvcnQgeyBsaXN0Q3JlYXRvckRyYWZ0cywgbGlzdFB1Ymxpc2hlckxpc3RpbmdzIH0gZnJvbSAnLi4vZGIudHMnO1xuaW1wb3J0IHsgZHJhZnRSZXNwb25zZSB9IGZyb20gJy4vY3JlYXRvci1kcmFmdHMudHMnO1xuXG4vKiogQXV0aGVudGljYXRlZCBwdWJsaXNoZXItb3duZWQgdmlld3MgdGhhdCBtdXN0IG5vdCB1c2UgcHVibGljIGNhdGFsb2cgZmlsdGVycy4gKi9cbmV4cG9ydCBmdW5jdGlvbiBtZVJvdXRlKCk6IEhvbm88eyBCaW5kaW5nczogRW52IH0+IHtcbiAgY29uc3QgYXBwID0gbmV3IEhvbm88eyBCaW5kaW5nczogRW52IH0+KCk7XG5cbiAgYXBwLmdldCgnL21lL2xpc3RpbmdzJywgYXN5bmMgKGMpID0+IHtcbiAgICBsZXQgdXNlcjtcbiAgICB0cnkge1xuICAgICAgdXNlciA9IGF3YWl0IHJlc29sdmVHaXRodWJCZWFyZXIoYy5yZXEucmF3KTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBpZiAoZSBpbnN0YW5jZW9mIEF1dGhFcnJvcikgcmV0dXJuIGMuanNvbih7IGVycm9yOiAnYXV0aCcsIHJlYXNvbjogZS5yZWFzb24gfSwgNDAxKTtcbiAgICAgIHRocm93IGU7XG4gICAgfVxuICAgIGNvbnN0IHBhcmFtcyA9IG5ldyBVUkwoYy5yZXEudXJsKS5zZWFyY2hQYXJhbXM7XG4gICAgY29uc3QgcmF3TGltaXQgPSBOdW1iZXIucGFyc2VJbnQocGFyYW1zLmdldCgnbGltaXQnKSA/PyAnMTAwJywgMTApO1xuICAgIGNvbnN0IGxpbWl0ID0gTnVtYmVyLmlzRmluaXRlKHJhd0xpbWl0KSA/IE1hdGgubWluKE1hdGgubWF4KHJhd0xpbWl0LCAxKSwgMjAwKSA6IDEwMDtcbiAgICBjb25zdCByYXdDdXJzb3IgPSBwYXJhbXMuZ2V0KCdjdXJzb3InKSA/PyAnMCc7XG4gICAgY29uc3Qgb2Zmc2V0ID0gTnVtYmVyKHJhd0N1cnNvcik7XG4gICAgaWYgKCEvXlxcZCskLy50ZXN0KHJhd0N1cnNvcikgfHwgIU51bWJlci5pc1NhZmVJbnRlZ2VyKG9mZnNldCkpIHtcbiAgICAgIHJldHVybiBjLmpzb24oeyBlcnJvcjogJ2ludmFsaWRfZmllbGQnLCBmaWVsZDogJ2N1cnNvcicgfSwgNDAwKTtcbiAgICB9XG4gICAgY29uc3QgW2xpc3RpbmdzLCBkcmFmdHNdID0gYXdhaXQgUHJvbWlzZS5hbGwoW1xuICAgICAgbGlzdFB1Ymxpc2hlckxpc3RpbmdzKGMuZW52LkRCLCB7IHB1Ymxpc2hlcklkOiB1c2VyLmlkLCBsaW1pdDogbGltaXQgKyAxLCBvZmZzZXQgfSksXG4gICAgICBsaXN0Q3JlYXRvckRyYWZ0cyhjLmVudi5EQiwgeyBvd25lcklkOiB1c2VyLmlkLCBsaW1pdDogbGltaXQgKyAxLCBvZmZzZXQgfSksXG4gICAgXSk7XG4gICAgYy5oZWFkZXIoJ0NhY2hlLUNvbnRyb2wnLCAncHJpdmF0ZSwgbm8tc3RvcmUnKTtcbiAgICByZXR1cm4gYy5qc29uKHtcbiAgICAgIGxpc3RpbmdzOiBsaXN0aW5ncy5zbGljZSgwLCBsaW1pdCksXG4gICAgICBkcmFmdHM6IGRyYWZ0cy5zbGljZSgwLCBsaW1pdCkubWFwKChkcmFmdCkgPT4gZHJhZnRSZXNwb25zZShkcmFmdCkpLFxuICAgICAgbmV4dF9jdXJzb3I6IGxpc3RpbmdzLmxlbmd0aCA+IGxpbWl0IHx8IGRyYWZ0cy5sZW5ndGggPiBsaW1pdCA/IFN0cmluZyhvZmZzZXQgKyBsaW1pdCkgOiBudWxsLFxuICAgIH0pO1xuICB9KTtcblxuICByZXR1cm4gYXBwO1xufVxuIl0sImZpbGUiOiIvc3JjL3JvdXRlcy9tZS50cyJ9

//# vitestCache=W3siZmlsZSI6IjEiLCJpZCI6IjEiLCJ1cmwiOiIyIiwiaW1wb3J0ZWRVcmxzIjoiMyIsIm1hcHBpbmdzIjpmYWxzZX0sIi9ob21lL21hcnNoLW9mZmljZS9wYXBlcmN1cGFpLXdvcmtzcGFjZS9wYXBlcmN1c3AvYXBwcy9vcGVyYXRvci1wdWJsaWMvc3JjL3JvdXRlcy9tZS50cyIsIi9zcmMvcm91dGVzL21lLnRzIixbXV0=
}}