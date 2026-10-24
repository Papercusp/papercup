'use strict';async (__vite_ssr_exports__,__vite_ssr_import_meta__,__vite_ssr_import__,__vite_ssr_dynamic_import__,__vite_ssr_exportAll__,__vite_ssr_exportName__,__filename,__dirname,module,exports,require)=>{{__vite_ssr_exportName__("runVerifyCli", () => { try { return runVerifyCli } catch {} });
__vite_ssr_exportName__("nodeCliIo", () => { try { return nodeCliIo } catch {} });
const __vite_ssr_import_0__ = await __vite_ssr_import__("node:fs", {"importedNames":["readFileSync"]});
const __vite_ssr_import_1__ = await __vite_ssr_import__("/@fs/home/marsh-office/papercupai-workspace/papercusp/libs/generic/hash-chain/src/export.ts", {"importedNames":["verifyChainExport"]});


const USAGE = "usage: verify <export.jsonl> [--head-seq N --head-hash H]";
function runVerifyCli(argv, io) {
  const [command, file, ...rest] = argv;
  if (command !== "verify" || !file) {
    io.out(JSON.stringify({ ok: false, error: USAGE }));
    return 2;
  };
  let headSeq;
  let headHash;
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i];
    const value = rest[i + 1];
    if (value === void 0) {
      io.out(JSON.stringify({ ok: false, error: `${flag} needs a value; ${USAGE}` }));
      return 2;
    };
    if (flag === "--head-seq") headSeq = value;
    else if (flag === "--head-hash") headHash = value;
    else {
      io.out(JSON.stringify({ ok: false, error: `unknown flag ${flag}; ${USAGE}` }));
      return 2;
    }
  };
  if (headSeq === void 0 !== (headHash === void 0)) {
    io.out(JSON.stringify({ ok: false, error: `--head-seq and --head-hash go together; ${USAGE}` }));
    return 2;
  };
  let expectedHead;
  if (headSeq !== void 0 && headHash !== void 0) {
    const seq = Number(headSeq);
    if (!Number.isSafeInteger(seq) || seq < 0) {
      io.out(JSON.stringify({ ok: false, error: `--head-seq must be a non-negative integer; ${USAGE}` }));
      return 2;
    };
    expectedHead = { seq, entryHash: headHash };
  };
  let text;
  try {
    text = io.readFile(file);
  } catch (error) {
    io.out(JSON.stringify({ ok: false, error: `cannot read ${file}: ${error.message}` }));
    return 2;
  };
  const verdict = (0,__vite_ssr_import_1__.verifyChainExport)(text, expectedHead ? { expectedHead } : {});
  io.out(JSON.stringify(verdict));
  return verdict.ok ? 0 : 1;
};
const nodeCliIo = {
  readFile: (path) => (0,__vite_ssr_import_0__.readFileSync)(path, "utf8"),
  out: (line) => process.stdout.write(`${line}
`)
};
//# sourceMappingSource=vite-generated
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJtYXBwaW5ncyI6IkFBQUEsQ0FBQTs7QUFVQTtBQUNBOzs7QUFRQSxNQUFNLFFBQVE7QUFFUCxTQUFTLGFBQWEsTUFBeUIsSUFBbUI7QUFDdkUsUUFBTSxDQUFDLFNBQVMsTUFBTSxHQUFHLElBQUksSUFBSTtBQUNqQyxNQUFJLFlBQVksWUFBWSxDQUFDLE1BQU07QUFDakMsT0FBRyxJQUFJLEtBQUssVUFBVSxFQUFFLElBQUksT0FBTyxPQUFPLE1BQU0sQ0FBQyxDQUFDO0FBQ2xELFdBQU87QUFBQSxFQUNUO0FBQ0EsTUFBSTtBQUNKLE1BQUk7QUFDSixXQUFTLElBQUksR0FBRyxJQUFJLEtBQUssUUFBUSxLQUFLLEdBQUc7QUFDdkMsVUFBTSxPQUFPLEtBQUssQ0FBQztBQUNuQixVQUFNLFFBQVEsS0FBSyxJQUFJLENBQUM7QUFDeEIsUUFBSSxVQUFVLFFBQVc7QUFDdkIsU0FBRyxJQUFJLEtBQUssVUFBVSxFQUFFLElBQUksT0FBTyxPQUFPLEdBQUcsSUFBSSxtQkFBbUIsS0FBSyxHQUFHLENBQUMsQ0FBQztBQUM5RSxhQUFPO0FBQUEsSUFDVDtBQUNBLFFBQUksU0FBUyxhQUFjLFdBQVU7QUFBQSxhQUM1QixTQUFTLGNBQWUsWUFBVztBQUFBLFNBQ3ZDO0FBQ0gsU0FBRyxJQUFJLEtBQUssVUFBVSxFQUFFLElBQUksT0FBTyxPQUFPLGdCQUFnQixJQUFJLEtBQUssS0FBSyxHQUFHLENBQUMsQ0FBQztBQUM3RSxhQUFPO0FBQUEsSUFDVDtBQUFBLEVBQ0Y7QUFDQSxNQUFLLFlBQVksWUFBZ0IsYUFBYSxTQUFZO0FBQ3hELE9BQUcsSUFBSSxLQUFLLFVBQVUsRUFBRSxJQUFJLE9BQU8sT0FBTywyQ0FBMkMsS0FBSyxHQUFHLENBQUMsQ0FBQztBQUMvRixXQUFPO0FBQUEsRUFDVDtBQUNBLE1BQUk7QUFDSixNQUFJLFlBQVksVUFBYSxhQUFhLFFBQVc7QUFDbkQsVUFBTSxNQUFNLE9BQU8sT0FBTztBQUMxQixRQUFJLENBQUMsT0FBTyxjQUFjLEdBQUcsS0FBSyxNQUFNLEdBQUc7QUFDekMsU0FBRyxJQUFJLEtBQUssVUFBVSxFQUFFLElBQUksT0FBTyxPQUFPLDhDQUE4QyxLQUFLLEdBQUcsQ0FBQyxDQUFDO0FBQ2xHLGFBQU87QUFBQSxJQUNUO0FBQ0EsbUJBQWUsRUFBRSxLQUFLLFdBQVcsU0FBUztBQUFBLEVBQzVDO0FBQ0EsTUFBSTtBQUNKLE1BQUk7QUFDRixXQUFPLEdBQUcsU0FBUyxJQUFJO0FBQUEsRUFDekIsU0FBUyxPQUFPO0FBQ2QsT0FBRyxJQUFJLEtBQUssVUFBVSxFQUFFLElBQUksT0FBTyxPQUFPLGVBQWUsSUFBSSxLQUFNLE1BQWdCLE9BQU8sR0FBRyxDQUFDLENBQUM7QUFDL0YsV0FBTztBQUFBLEVBQ1Q7QUFDQSxRQUFNLGFBQVUseUNBQWtCLE1BQU0sZUFBZSxFQUFFLGFBQWEsSUFBSSxDQUFDLENBQUM7QUFDNUUsS0FBRyxJQUFJLEtBQUssVUFBVSxPQUFPLENBQUM7QUFDOUIsU0FBTyxRQUFRLEtBQUssSUFBSTtBQUMxQjtBQUdPLE1BQU0sWUFBbUI7QUFBQSxFQUM5QixVQUFVLENBQUMsWUFBUyxvQ0FBYSxNQUFNLE1BQU07QUFBQSxFQUM3QyxLQUFLLENBQUMsU0FBUyxRQUFRLE9BQU8sTUFBTSxHQUFHLElBQUk7QUFBQSxDQUFJO0FBQ2pEIiwibmFtZXMiOltdLCJpZ25vcmVMaXN0IjpbXSwic291cmNlcyI6WyJjbGkudHMiXSwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBUaGlyZC1wYXJ0eSB2ZXJpZmllcjogYG5weCB0c3ggbGlicy9nZW5lcmljL2hhc2gtY2hhaW4vc3JjL3ZlcmlmeS1tYWluLnRzIHZlcmlmeVxuICogPGV4cG9ydC5qc29ubD4gWy0taGVhZC1zZXEgTiAtLWhlYWQtaGFzaCBIXWAuIFRoaXMgbW9kdWxlIGlzIHNpZGUtZWZmZWN0IGZyZWVcbiAqIChpbXBvcnRhYmxlIGFuZCBidW5kbGUtc2FmZSk7IGB2ZXJpZnktbWFpbi50c2AgaXMgdGhlIGVudHJ5LW9ubHkgZmlsZSB0aGF0IHJ1bnMgaXQuXG4gKlxuICogUHJpbnRzIHRoZSB2ZXJkaWN0IGFzIG9uZSBKU09OIGxpbmUgYW5kIGV4aXRzIDAgd2hlbiB0aGUgY2hhaW4gaXMgaW50YWN0LCAxXG4gKiB3aGVuIGl0IGlzIGJyb2tlbiAodGhlIHZlcmRpY3QgbmFtZXMgdGhlIGZpcnN0IGJyZWFrKSwgMiBvbiBhIHVzYWdlIGVycm9yLlxuICogYC0taGVhZC1zZXEvLS1oZWFkLWhhc2hgIHBpbiB0aGUgaGVhZCB5b3Ugb2J0YWluZWQgaW5kZXBlbmRlbnRseSAoYW4gYW5jaG9yKSxcbiAqIHdoaWNoIGlzIHdoYXQgZXhwb3NlcyBhIGNvbnNpc3RlbnRseSB0cnVuY2F0ZWQgZXhwb3J0LlxuICovXG5pbXBvcnQgeyByZWFkRmlsZVN5bmMgfSBmcm9tICdub2RlOmZzJztcbmltcG9ydCB7IHZlcmlmeUNoYWluRXhwb3J0IH0gZnJvbSAnLi9leHBvcnQnO1xuaW1wb3J0IHR5cGUgeyBDaGFpbkhlYWQgfSBmcm9tICcuL2NoYWluJztcblxuZXhwb3J0IGludGVyZmFjZSBDbGlJbyB7XG4gIHJlYWRvbmx5IHJlYWRGaWxlOiAocGF0aDogc3RyaW5nKSA9PiBzdHJpbmc7XG4gIHJlYWRvbmx5IG91dDogKGxpbmU6IHN0cmluZykgPT4gdm9pZDtcbn1cblxuY29uc3QgVVNBR0UgPSAndXNhZ2U6IHZlcmlmeSA8ZXhwb3J0Lmpzb25sPiBbLS1oZWFkLXNlcSBOIC0taGVhZC1oYXNoIEhdJztcblxuZXhwb3J0IGZ1bmN0aW9uIHJ1blZlcmlmeUNsaShhcmd2OiByZWFkb25seSBzdHJpbmdbXSwgaW86IENsaUlvKTogbnVtYmVyIHtcbiAgY29uc3QgW2NvbW1hbmQsIGZpbGUsIC4uLnJlc3RdID0gYXJndjtcbiAgaWYgKGNvbW1hbmQgIT09ICd2ZXJpZnknIHx8ICFmaWxlKSB7XG4gICAgaW8ub3V0KEpTT04uc3RyaW5naWZ5KHsgb2s6IGZhbHNlLCBlcnJvcjogVVNBR0UgfSkpO1xuICAgIHJldHVybiAyO1xuICB9XG4gIGxldCBoZWFkU2VxOiBzdHJpbmcgfCB1bmRlZmluZWQ7XG4gIGxldCBoZWFkSGFzaDogc3RyaW5nIHwgdW5kZWZpbmVkO1xuICBmb3IgKGxldCBpID0gMDsgaSA8IHJlc3QubGVuZ3RoOyBpICs9IDIpIHtcbiAgICBjb25zdCBmbGFnID0gcmVzdFtpXTtcbiAgICBjb25zdCB2YWx1ZSA9IHJlc3RbaSArIDFdO1xuICAgIGlmICh2YWx1ZSA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICBpby5vdXQoSlNPTi5zdHJpbmdpZnkoeyBvazogZmFsc2UsIGVycm9yOiBgJHtmbGFnfSBuZWVkcyBhIHZhbHVlOyAke1VTQUdFfWAgfSkpO1xuICAgICAgcmV0dXJuIDI7XG4gICAgfVxuICAgIGlmIChmbGFnID09PSAnLS1oZWFkLXNlcScpIGhlYWRTZXEgPSB2YWx1ZTtcbiAgICBlbHNlIGlmIChmbGFnID09PSAnLS1oZWFkLWhhc2gnKSBoZWFkSGFzaCA9IHZhbHVlO1xuICAgIGVsc2Uge1xuICAgICAgaW8ub3V0KEpTT04uc3RyaW5naWZ5KHsgb2s6IGZhbHNlLCBlcnJvcjogYHVua25vd24gZmxhZyAke2ZsYWd9OyAke1VTQUdFfWAgfSkpO1xuICAgICAgcmV0dXJuIDI7XG4gICAgfVxuICB9XG4gIGlmICgoaGVhZFNlcSA9PT0gdW5kZWZpbmVkKSAhPT0gKGhlYWRIYXNoID09PSB1bmRlZmluZWQpKSB7XG4gICAgaW8ub3V0KEpTT04uc3RyaW5naWZ5KHsgb2s6IGZhbHNlLCBlcnJvcjogYC0taGVhZC1zZXEgYW5kIC0taGVhZC1oYXNoIGdvIHRvZ2V0aGVyOyAke1VTQUdFfWAgfSkpO1xuICAgIHJldHVybiAyO1xuICB9XG4gIGxldCBleHBlY3RlZEhlYWQ6IENoYWluSGVhZCB8IHVuZGVmaW5lZDtcbiAgaWYgKGhlYWRTZXEgIT09IHVuZGVmaW5lZCAmJiBoZWFkSGFzaCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgY29uc3Qgc2VxID0gTnVtYmVyKGhlYWRTZXEpO1xuICAgIGlmICghTnVtYmVyLmlzU2FmZUludGVnZXIoc2VxKSB8fCBzZXEgPCAwKSB7XG4gICAgICBpby5vdXQoSlNPTi5zdHJpbmdpZnkoeyBvazogZmFsc2UsIGVycm9yOiBgLS1oZWFkLXNlcSBtdXN0IGJlIGEgbm9uLW5lZ2F0aXZlIGludGVnZXI7ICR7VVNBR0V9YCB9KSk7XG4gICAgICByZXR1cm4gMjtcbiAgICB9XG4gICAgZXhwZWN0ZWRIZWFkID0geyBzZXEsIGVudHJ5SGFzaDogaGVhZEhhc2ggfTtcbiAgfVxuICBsZXQgdGV4dDogc3RyaW5nO1xuICB0cnkge1xuICAgIHRleHQgPSBpby5yZWFkRmlsZShmaWxlKTtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICBpby5vdXQoSlNPTi5zdHJpbmdpZnkoeyBvazogZmFsc2UsIGVycm9yOiBgY2Fubm90IHJlYWQgJHtmaWxlfTogJHsoZXJyb3IgYXMgRXJyb3IpLm1lc3NhZ2V9YCB9KSk7XG4gICAgcmV0dXJuIDI7XG4gIH1cbiAgY29uc3QgdmVyZGljdCA9IHZlcmlmeUNoYWluRXhwb3J0KHRleHQsIGV4cGVjdGVkSGVhZCA/IHsgZXhwZWN0ZWRIZWFkIH0gOiB7fSk7XG4gIGlvLm91dChKU09OLnN0cmluZ2lmeSh2ZXJkaWN0KSk7XG4gIHJldHVybiB2ZXJkaWN0Lm9rID8gMCA6IDE7XG59XG5cbi8qKiBUaGUgcmVhbC1wcm9jZXNzIHdpcmluZywgdXNlZCBieSB0aGUgZW50cnktb25seSBgdmVyaWZ5LW1haW4udHNgLiAqL1xuZXhwb3J0IGNvbnN0IG5vZGVDbGlJbzogQ2xpSW8gPSB7XG4gIHJlYWRGaWxlOiAocGF0aCkgPT4gcmVhZEZpbGVTeW5jKHBhdGgsICd1dGY4JyksXG4gIG91dDogKGxpbmUpID0+IHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke2xpbmV9XFxuYCksXG59O1xuIl0sImZpbGUiOiIvQGZzL2hvbWUvbWFyc2gtb2ZmaWNlL3BhcGVyY3VwYWktd29ya3NwYWNlL3BhcGVyY3VzcC9saWJzL2dlbmVyaWMvaGFzaC1jaGFpbi9zcmMvY2xpLnRzIn0=

//# vitestCache=W3siZmlsZSI6IjEiLCJpZCI6IjEiLCJ1cmwiOiIyIiwiaW1wb3J0ZWRVcmxzIjoiMyIsIm1hcHBpbmdzIjpmYWxzZX0sIi9ob21lL21hcnNoLW9mZmljZS9wYXBlcmN1cGFpLXdvcmtzcGFjZS9wYXBlcmN1c3AvbGlicy9nZW5lcmljL2hhc2gtY2hhaW4vc3JjL2NsaS50cyIsIi9AZnMvaG9tZS9tYXJzaC1vZmZpY2UvcGFwZXJjdXBhaS13b3Jrc3BhY2UvcGFwZXJjdXNwL2xpYnMvZ2VuZXJpYy9oYXNoLWNoYWluL3NyYy9jbGkudHMiLFtdXQ==
}}