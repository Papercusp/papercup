'use strict';async (__vite_ssr_exports__,__vite_ssr_import_meta__,__vite_ssr_import__,__vite_ssr_dynamic_import__,__vite_ssr_exportAll__,__vite_ssr_exportName__,__filename,__dirname,module,exports,require)=>{{__vite_ssr_exportName__("EMPTY_ROOT", () => { try { return EMPTY_ROOT } catch {} });
__vite_ssr_exportName__("leafHash", () => { try { return leafHash } catch {} });
__vite_ssr_exportName__("nodeHash", () => { try { return nodeHash } catch {} });
__vite_ssr_exportName__("rootHash", () => { try { return rootHash } catch {} });
__vite_ssr_exportName__("inclusionProof", () => { try { return inclusionProof } catch {} });
__vite_ssr_exportName__("consistencyProof", () => { try { return consistencyProof } catch {} });
__vite_ssr_exportName__("verifyInclusion", () => { try { return verifyInclusion } catch {} });
__vite_ssr_exportName__("verifyConsistency", () => { try { return verifyConsistency } catch {} });
const __vite_ssr_import_0__ = await __vite_ssr_import__("node:crypto", {"importedNames":["createHash"]});

const HEX64 = /^[0-9a-f]{64}$/;
const LEAF_PREFIX = Buffer.from([0]);
const NODE_PREFIX = Buffer.from([1]);
function sha256(...parts) {
  const h = (0,__vite_ssr_import_0__.createHash)("sha256");
  for (const p of parts) h.update(p);
  return h.digest();
}
function toBuf(hex, what) {
  if (!HEX64.test(hex)) throw new Error(`${what} must be 64 lowercase hex characters`);
  return Buffer.from(hex, "hex");
}
const EMPTY_ROOT = sha256().toString("hex");
function leafHash(data) {
  const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  return sha256(LEAF_PREFIX, bytes).toString("hex");
};
function nodeHash(left, right) {
  return sha256(NODE_PREFIX, toBuf(left, "left"), toBuf(right, "right")).toString("hex");
};
function splitPoint(n) {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}
function checkLeaves(leafHashes) {
  for (let i = 0; i < leafHashes.length; i += 1) {
    if (!HEX64.test(leafHashes[i])) throw new Error(`leaf hash ${i} must be 64 lowercase hex characters`);
  }
}
function mth(leaves, lo, hi) {
  const n = hi - lo;
  if (n === 0) return EMPTY_ROOT;
  if (n === 1) return leaves[lo];
  const k = splitPoint(n);
  return nodeHash(mth(leaves, lo, lo + k), mth(leaves, lo + k, hi));
}
function rootHash(leafHashes, treeSize = leafHashes.length) {
  checkLeaves(leafHashes);
  if (!Number.isInteger(treeSize) || treeSize < 0 || treeSize > leafHashes.length) {
    throw new Error(`treeSize ${treeSize} is outside 0..${leafHashes.length}`);
  };
  return mth(leafHashes, 0, treeSize);
};
function path(leaves, m, lo, hi) {
  const n = hi - lo;
  if (n <= 1) return [];
  const k = splitPoint(n);
  if (m < k) return [...path(leaves, m, lo, lo + k), mth(leaves, lo + k, hi)];
  return [...path(leaves, m - k, lo + k, hi), mth(leaves, lo, lo + k)];
}
function inclusionProof(leafHashes, index, treeSize = leafHashes.length) {
  checkLeaves(leafHashes);
  if (!Number.isInteger(treeSize) || treeSize < 1 || treeSize > leafHashes.length) {
    throw new Error(`treeSize ${treeSize} is outside 1..${leafHashes.length}`);
  };
  if (!Number.isInteger(index) || index < 0 || index >= treeSize) {
    throw new Error(`index ${index} is outside 0..${treeSize - 1}`);
  };
  return path(leafHashes, index, 0, treeSize);
};
function subproof(leaves, m, lo, hi, complete) {
  const n = hi - lo;
  if (m === n) return complete ? [] : [mth(leaves, lo, hi)];
  const k = splitPoint(n);
  if (m <= k) return [...subproof(leaves, m, lo, lo + k, complete), mth(leaves, lo + k, hi)];
  return [...subproof(leaves, m - k, lo + k, hi, false), mth(leaves, lo, lo + k)];
}
function consistencyProof(leafHashes, oldSize, newSize = leafHashes.length) {
  checkLeaves(leafHashes);
  if (!Number.isInteger(newSize) || newSize < 0 || newSize > leafHashes.length) {
    throw new Error(`newSize ${newSize} is outside 0..${leafHashes.length}`);
  };
  if (!Number.isInteger(oldSize) || oldSize < 0 || oldSize > newSize) {
    throw new Error(`oldSize ${oldSize} is outside 0..${newSize}`);
  };
  if (oldSize === 0 || oldSize === newSize) return [];
  return subproof(leafHashes, oldSize, 0, newSize, true);
};
const isOdd = (n) => n % 2 === 1;
const half = (n) => Math.floor(n / 2);
function verifyInclusion(check) {
  const { index, treeSize, proof } = check;
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(treeSize) || index < 0 || index >= treeSize) return false;
  if (!HEX64.test(check.leafHash) || !HEX64.test(check.root) || !proof.every((p) => HEX64.test(p))) return false;
  let fn = index;
  let sn = treeSize - 1;
  let r = check.leafHash;
  for (const p of proof) {
    if (sn === 0) return false;
    if (isOdd(fn) || fn === sn) {
      r = nodeHash(p, r);
      if (!isOdd(fn)) {
        while (!isOdd(fn) && fn !== 0) {
          fn = half(fn);
          sn = half(sn);
        }
      }
    } else {
      r = nodeHash(r, p);
    };
    fn = half(fn);
    sn = half(sn);
  };
  return sn === 0 && r === check.root;
};
function verifyConsistency(check) {
  const { oldSize, newSize, proof } = check;
  if (!Number.isSafeInteger(oldSize) || !Number.isSafeInteger(newSize) || oldSize < 0 || oldSize > newSize) return false;
  if (!HEX64.test(check.oldRoot) || !HEX64.test(check.newRoot) || !proof.every((p) => HEX64.test(p))) return false;
  if (oldSize === newSize) return proof.length === 0 && check.oldRoot === check.newRoot;
  if (oldSize === 0) return proof.length === 0 && check.oldRoot === EMPTY_ROOT;
  if (proof.length === 0) return false;
  const isPow2 = (oldSize & oldSize - 1) === 0;
  const path2 = isPow2 ? [check.oldRoot, ...proof] : [...proof];
  let fn = oldSize - 1;
  let sn = newSize - 1;
  while (isOdd(fn)) {
    fn = half(fn);
    sn = half(sn);
  };
  let fr = path2[0];
  let sr = path2[0];
  for (const c of path2.slice(1)) {
    if (sn === 0) return false;
    if (isOdd(fn) || fn === sn) {
      fr = nodeHash(c, fr);
      sr = nodeHash(c, sr);
      if (!isOdd(fn)) {
        while (!isOdd(fn) && fn !== 0) {
          fn = half(fn);
          sn = half(sn);
        }
      }
    } else {
      sr = nodeHash(sr, c);
    };
    fn = half(fn);
    sn = half(sn);
  };
  return fr === check.oldRoot && sr === check.newRoot && sn === 0;
}
//# sourceMappingSource=vite-generated
//# sourceMappingURL=data:application/json;base64,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Q0YsT0FBTztBQUNMLFdBQUssU0FBUyxJQUFJLENBQUM7QUFBQSxJQUNyQjtBQUNBLFNBQUssS0FBSyxFQUFFO0FBQ1osU0FBSyxLQUFLLEVBQUU7QUFBQSxFQUNkO0FBQ0EsU0FBTyxPQUFPLE1BQU0sV0FBVyxPQUFPLE1BQU0sV0FBVyxPQUFPO0FBQ2hFIiwibmFtZXMiOlsicGF0aCJdLCJpZ25vcmVMaXN0IjpbXSwic291cmNlcyI6WyJtZXJrbGUtbG9nLnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogUkZDIDkxNjIgc2VjdGlvbiAyLjEgTWVya2xlIHRyZWUgaGFzaGluZywgaW5jbHVzaW9uIHByb29mcyBhbmQgY29uc2lzdGVuY3lcbiAqIHByb29mcyAoQ2VydGlmaWNhdGUgVHJhbnNwYXJlbmN5IHYyKS4gVGhlIHRyZWUgaGFzaGluZyBpcyBpZGVudGljYWwgdG8gUkZDXG4gKiA2OTYyOiBTSEEtMjU2LCBhIDB4MDAgcHJlZml4IG9uIGxlYXZlcyBhbmQgYSAweDAxIHByZWZpeCBvbiBpbnRlcmlvciBub2Rlcy5cbiAqIFJGQyA5MTYyIGFkZHMgdGhlIHZlcmlmaWNhdGlvbiBhbGdvcml0aG1zIGltcGxlbWVudGVkIGJ5IGB2ZXJpZnlJbmNsdXNpb25gXG4gKiBhbmQgYHZlcmlmeUNvbnNpc3RlbmN5YC5cbiAqXG4gKiBIYXNoZXMgY3Jvc3MgdGhlIEFQSSBhcyA2NC1jaGFyYWN0ZXIgbG93ZXJjYXNlIGhleCBzbyBwcm9vZnMgc2VyaWFsaXplIGFzXG4gKiBwbGFpbiBKU09OLiBMZWFmIERBVEEgaXMgb3BhcXVlIGJ5dGVzOiB0aGUgY2FsbGVyIG93bnMgdGhlIGxlYWYgZW5jb2RpbmdcbiAqIChkb21haW4tdGFnIGl0KSwgdGhpcyBtb2R1bGUgb25seSBoYXNoZXMgaXQuXG4gKlxuICogVGhlIGJ1aWxkZXJzIHRha2UgdGhlIGZ1bGwgbGlzdCBvZiBsZWFmIGhhc2hlcyBhbmQgcnVuIGluIE8obikgcGVyIGNhbGwuIFRoYXRcbiAqIGlzIGZpbmUgZm9yIGxvZ3Mgb2YgdXAgdG8gYSBmZXcgbWlsbGlvbiBsZWF2ZXMgcmVjb21wdXRlZCBob3VybHk7IGEgY2FsbGVyXG4gKiB0aGF0IG91dGdyb3dzIGl0IGNhbiBjYWNoZSBzdWJ0cmVlIHJvb3RzIHdpdGhvdXQgY2hhbmdpbmcgYW55IG91dHB1dC5cbiAqL1xuaW1wb3J0IHsgY3JlYXRlSGFzaCB9IGZyb20gJ25vZGU6Y3J5cHRvJztcblxuY29uc3QgSEVYNjQgPSAvXlswLTlhLWZdezY0fSQvO1xuY29uc3QgTEVBRl9QUkVGSVggPSBCdWZmZXIuZnJvbShbMHgwMF0pO1xuY29uc3QgTk9ERV9QUkVGSVggPSBCdWZmZXIuZnJvbShbMHgwMV0pO1xuXG5mdW5jdGlvbiBzaGEyNTYoLi4ucGFydHM6IHJlYWRvbmx5IFVpbnQ4QXJyYXlbXSk6IEJ1ZmZlciB7XG4gIGNvbnN0IGggPSBjcmVhdGVIYXNoKCdzaGEyNTYnKTtcbiAgZm9yIChjb25zdCBwIG9mIHBhcnRzKSBoLnVwZGF0ZShwKTtcbiAgcmV0dXJuIGguZGlnZXN0KCk7XG59XG5cbmZ1bmN0aW9uIHRvQnVmKGhleDogc3RyaW5nLCB3aGF0OiBzdHJpbmcpOiBCdWZmZXIge1xuICBpZiAoIUhFWDY0LnRlc3QoaGV4KSkgdGhyb3cgbmV3IEVycm9yKGAke3doYXR9IG11c3QgYmUgNjQgbG93ZXJjYXNlIGhleCBjaGFyYWN0ZXJzYCk7XG4gIHJldHVybiBCdWZmZXIuZnJvbShoZXgsICdoZXgnKTtcbn1cblxuLyoqIE1USCh7fSkgPSBTSEEtMjU2IG9mIHRoZSBlbXB0eSBzdHJpbmcuICovXG5leHBvcnQgY29uc3QgRU1QVFlfUk9PVCA9IHNoYTI1NigpLnRvU3RyaW5nKCdoZXgnKTtcblxuLyoqIE1USCh7ZH0pID0gU0hBLTI1NigweDAwIHx8IGQpLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGxlYWZIYXNoKGRhdGE6IFVpbnQ4QXJyYXkgfCBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCBieXRlcyA9IHR5cGVvZiBkYXRhID09PSAnc3RyaW5nJyA/IEJ1ZmZlci5mcm9tKGRhdGEsICd1dGY4JykgOiBkYXRhO1xuICByZXR1cm4gc2hhMjU2KExFQUZfUFJFRklYLCBieXRlcykudG9TdHJpbmcoJ2hleCcpO1xufVxuXG4vKiogU0hBLTI1NigweDAxIHx8IGxlZnQgfHwgcmlnaHQpLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIG5vZGVIYXNoKGxlZnQ6IHN0cmluZywgcmlnaHQ6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBzaGEyNTYoTk9ERV9QUkVGSVgsIHRvQnVmKGxlZnQsICdsZWZ0JyksIHRvQnVmKHJpZ2h0LCAncmlnaHQnKSkudG9TdHJpbmcoJ2hleCcpO1xufVxuXG4vKiogTGFyZ2VzdCBwb3dlciBvZiB0d28gc3RyaWN0bHkgbGVzcyB0aGFuIG4gKG4gPj0gMikuICovXG5mdW5jdGlvbiBzcGxpdFBvaW50KG46IG51bWJlcik6IG51bWJlciB7XG4gIGxldCBrID0gMTtcbiAgd2hpbGUgKGsgKiAyIDwgbikgayAqPSAyO1xuICByZXR1cm4gaztcbn1cblxuZnVuY3Rpb24gY2hlY2tMZWF2ZXMobGVhZkhhc2hlczogcmVhZG9ubHkgc3RyaW5nW10pOiB2b2lkIHtcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBsZWFmSGFzaGVzLmxlbmd0aDsgaSArPSAxKSB7XG4gICAgaWYgKCFIRVg2NC50ZXN0KGxlYWZIYXNoZXNbaV0hKSkgdGhyb3cgbmV3IEVycm9yKGBsZWFmIGhhc2ggJHtpfSBtdXN0IGJlIDY0IGxvd2VyY2FzZSBoZXggY2hhcmFjdGVyc2ApO1xuICB9XG59XG5cbmZ1bmN0aW9uIG10aChsZWF2ZXM6IHJlYWRvbmx5IHN0cmluZ1tdLCBsbzogbnVtYmVyLCBoaTogbnVtYmVyKTogc3RyaW5nIHtcbiAgY29uc3QgbiA9IGhpIC0gbG87XG4gIGlmIChuID09PSAwKSByZXR1cm4gRU1QVFlfUk9PVDtcbiAgaWYgKG4gPT09IDEpIHJldHVybiBsZWF2ZXNbbG9dITtcbiAgY29uc3QgayA9IHNwbGl0UG9pbnQobik7XG4gIHJldHVybiBub2RlSGFzaChtdGgobGVhdmVzLCBsbywgbG8gKyBrKSwgbXRoKGxlYXZlcywgbG8gKyBrLCBoaSkpO1xufVxuXG4vKiogVGhlIE1lcmtsZSBUcmVlIEhhc2ggb2YgdGhlIGZpcnN0IGB0cmVlU2l6ZWAgbGVhdmVzIChkZWZhdWx0OiBhbGwgb2YgdGhlbSkuICovXG5leHBvcnQgZnVuY3Rpb24gcm9vdEhhc2gobGVhZkhhc2hlczogcmVhZG9ubHkgc3RyaW5nW10sIHRyZWVTaXplID0gbGVhZkhhc2hlcy5sZW5ndGgpOiBzdHJpbmcge1xuICBjaGVja0xlYXZlcyhsZWFmSGFzaGVzKTtcbiAgaWYgKCFOdW1iZXIuaXNJbnRlZ2VyKHRyZWVTaXplKSB8fCB0cmVlU2l6ZSA8IDAgfHwgdHJlZVNpemUgPiBsZWFmSGFzaGVzLmxlbmd0aCkge1xuICAgIHRocm93IG5ldyBFcnJvcihgdHJlZVNpemUgJHt0cmVlU2l6ZX0gaXMgb3V0c2lkZSAwLi4ke2xlYWZIYXNoZXMubGVuZ3RofWApO1xuICB9XG4gIHJldHVybiBtdGgobGVhZkhhc2hlcywgMCwgdHJlZVNpemUpO1xufVxuXG5mdW5jdGlvbiBwYXRoKGxlYXZlczogcmVhZG9ubHkgc3RyaW5nW10sIG06IG51bWJlciwgbG86IG51bWJlciwgaGk6IG51bWJlcik6IHN0cmluZ1tdIHtcbiAgY29uc3QgbiA9IGhpIC0gbG87XG4gIGlmIChuIDw9IDEpIHJldHVybiBbXTtcbiAgY29uc3QgayA9IHNwbGl0UG9pbnQobik7XG4gIGlmIChtIDwgaykgcmV0dXJuIFsuLi5wYXRoKGxlYXZlcywgbSwgbG8sIGxvICsgayksIG10aChsZWF2ZXMsIGxvICsgaywgaGkpXTtcbiAgcmV0dXJuIFsuLi5wYXRoKGxlYXZlcywgbSAtIGssIGxvICsgaywgaGkpLCBtdGgobGVhdmVzLCBsbywgbG8gKyBrKV07XG59XG5cbi8qKiBQQVRIKG0sIERbbl0pOiB0aGUgYXVkaXQgcGF0aCBwcm92aW5nIGxlYWYgYGluZGV4YCBpcyBpbiB0aGUgdHJlZSBvZiBgdHJlZVNpemVgIGxlYXZlcy4gKi9cbmV4cG9ydCBmdW5jdGlvbiBpbmNsdXNpb25Qcm9vZihsZWFmSGFzaGVzOiByZWFkb25seSBzdHJpbmdbXSwgaW5kZXg6IG51bWJlciwgdHJlZVNpemUgPSBsZWFmSGFzaGVzLmxlbmd0aCk6IHN0cmluZ1tdIHtcbiAgY2hlY2tMZWF2ZXMobGVhZkhhc2hlcyk7XG4gIGlmICghTnVtYmVyLmlzSW50ZWdlcih0cmVlU2l6ZSkgfHwgdHJlZVNpemUgPCAxIHx8IHRyZWVTaXplID4gbGVhZkhhc2hlcy5sZW5ndGgpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYHRyZWVTaXplICR7dHJlZVNpemV9IGlzIG91dHNpZGUgMS4uJHtsZWFmSGFzaGVzLmxlbmd0aH1gKTtcbiAgfVxuICBpZiAoIU51bWJlci5pc0ludGVnZXIoaW5kZXgpIHx8IGluZGV4IDwgMCB8fCBpbmRleCA+PSB0cmVlU2l6ZSkge1xuICAgIHRocm93IG5ldyBFcnJvcihgaW5kZXggJHtpbmRleH0gaXMgb3V0c2lkZSAwLi4ke3RyZWVTaXplIC0gMX1gKTtcbiAgfVxuICByZXR1cm4gcGF0aChsZWFmSGFzaGVzLCBpbmRleCwgMCwgdHJlZVNpemUpO1xufVxuXG5mdW5jdGlvbiBzdWJwcm9vZihsZWF2ZXM6IHJlYWRvbmx5IHN0cmluZ1tdLCBtOiBudW1iZXIsIGxvOiBudW1iZXIsIGhpOiBudW1iZXIsIGNvbXBsZXRlOiBib29sZWFuKTogc3RyaW5nW10ge1xuICBjb25zdCBuID0gaGkgLSBsbztcbiAgaWYgKG0gPT09IG4pIHJldHVybiBjb21wbGV0ZSA/IFtdIDogW210aChsZWF2ZXMsIGxvLCBoaSldO1xuICBjb25zdCBrID0gc3BsaXRQb2ludChuKTtcbiAgaWYgKG0gPD0gaykgcmV0dXJuIFsuLi5zdWJwcm9vZihsZWF2ZXMsIG0sIGxvLCBsbyArIGssIGNvbXBsZXRlKSwgbXRoKGxlYXZlcywgbG8gKyBrLCBoaSldO1xuICByZXR1cm4gWy4uLnN1YnByb29mKGxlYXZlcywgbSAtIGssIGxvICsgaywgaGksIGZhbHNlKSwgbXRoKGxlYXZlcywgbG8sIGxvICsgayldO1xufVxuXG4vKiogUFJPT0YobSwgRFtuXSk6IHByb3ZlcyB0aGUgdHJlZSBvZiBgb2xkU2l6ZWAgbGVhdmVzIGlzIGEgcHJlZml4IG9mIHRoZSB0cmVlIG9mIGBuZXdTaXplYCBsZWF2ZXMuICovXG5leHBvcnQgZnVuY3Rpb24gY29uc2lzdGVuY3lQcm9vZihsZWFmSGFzaGVzOiByZWFkb25seSBzdHJpbmdbXSwgb2xkU2l6ZTogbnVtYmVyLCBuZXdTaXplID0gbGVhZkhhc2hlcy5sZW5ndGgpOiBzdHJpbmdbXSB7XG4gIGNoZWNrTGVhdmVzKGxlYWZIYXNoZXMpO1xuICBpZiAoIU51bWJlci5pc0ludGVnZXIobmV3U2l6ZSkgfHwgbmV3U2l6ZSA8IDAgfHwgbmV3U2l6ZSA+IGxlYWZIYXNoZXMubGVuZ3RoKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBuZXdTaXplICR7bmV3U2l6ZX0gaXMgb3V0c2lkZSAwLi4ke2xlYWZIYXNoZXMubGVuZ3RofWApO1xuICB9XG4gIGlmICghTnVtYmVyLmlzSW50ZWdlcihvbGRTaXplKSB8fCBvbGRTaXplIDwgMCB8fCBvbGRTaXplID4gbmV3U2l6ZSkge1xuICAgIHRocm93IG5ldyBFcnJvcihgb2xkU2l6ZSAke29sZFNpemV9IGlzIG91dHNpZGUgMC4uJHtuZXdTaXplfWApO1xuICB9XG4gIGlmIChvbGRTaXplID09PSAwIHx8IG9sZFNpemUgPT09IG5ld1NpemUpIHJldHVybiBbXTtcbiAgcmV0dXJuIHN1YnByb29mKGxlYWZIYXNoZXMsIG9sZFNpemUsIDAsIG5ld1NpemUsIHRydWUpO1xufVxuXG5jb25zdCBpc09kZCA9IChuOiBudW1iZXIpOiBib29sZWFuID0+IG4gJSAyID09PSAxO1xuY29uc3QgaGFsZiA9IChuOiBudW1iZXIpOiBudW1iZXIgPT4gTWF0aC5mbG9vcihuIC8gMik7XG5cbmV4cG9ydCBpbnRlcmZhY2UgSW5jbHVzaW9uQ2hlY2sge1xuICByZWFkb25seSBsZWFmSGFzaDogc3RyaW5nO1xuICByZWFkb25seSBpbmRleDogbnVtYmVyO1xuICByZWFkb25seSB0cmVlU2l6ZTogbnVtYmVyO1xuICByZWFkb25seSBwcm9vZjogcmVhZG9ubHkgc3RyaW5nW107XG4gIHJlYWRvbmx5IHJvb3Q6IHN0cmluZztcbn1cblxuLyoqIFJGQyA5MTYyIHNlY3Rpb24gMi4xLjMuMi4gUmV0dXJucyBmYWxzZSAobmV2ZXIgdGhyb3dzKSBmb3IgYW55IG1hbGZvcm1lZCBpbnB1dC4gKi9cbmV4cG9ydCBmdW5jdGlvbiB2ZXJpZnlJbmNsdXNpb24oY2hlY2s6IEluY2x1c2lvbkNoZWNrKTogYm9vbGVhbiB7XG4gIGNvbnN0IHsgaW5kZXgsIHRyZWVTaXplLCBwcm9vZiB9ID0gY2hlY2s7XG4gIGlmICghTnVtYmVyLmlzU2FmZUludGVnZXIoaW5kZXgpIHx8ICFOdW1iZXIuaXNTYWZlSW50ZWdlcih0cmVlU2l6ZSkgfHwgaW5kZXggPCAwIHx8IGluZGV4ID49IHRyZWVTaXplKSByZXR1cm4gZmFsc2U7XG4gIGlmICghSEVYNjQudGVzdChjaGVjay5sZWFmSGFzaCkgfHwgIUhFWDY0LnRlc3QoY2hlY2sucm9vdCkgfHwgIXByb29mLmV2ZXJ5KChwKSA9PiBIRVg2NC50ZXN0KHApKSkgcmV0dXJuIGZhbHNlO1xuICBsZXQgZm4gPSBpbmRleDtcbiAgbGV0IHNuID0gdHJlZVNpemUgLSAxO1xuICBsZXQgciA9IGNoZWNrLmxlYWZIYXNoO1xuICBmb3IgKGNvbnN0IHAgb2YgcHJvb2YpIHtcbiAgICBpZiAoc24gPT09IDApIHJldHVybiBmYWxzZTtcbiAgICBpZiAoaXNPZGQoZm4pIHx8IGZuID09PSBzbikge1xuICAgICAgciA9IG5vZGVIYXNoKHAsIHIpO1xuICAgICAgaWYgKCFpc09kZChmbikpIHtcbiAgICAgICAgd2hpbGUgKCFpc09kZChmbikgJiYgZm4gIT09IDApIHtcbiAgICAgICAgICBmbiA9IGhhbGYoZm4pO1xuICAgICAgICAgIHNuID0gaGFsZihzbik7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9IGVsc2Uge1xuICAgICAgciA9IG5vZGVIYXNoKHIsIHApO1xuICAgIH1cbiAgICBmbiA9IGhhbGYoZm4pO1xuICAgIHNuID0gaGFsZihzbik7XG4gIH1cbiAgcmV0dXJuIHNuID09PSAwICYmIHIgPT09IGNoZWNrLnJvb3Q7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgQ29uc2lzdGVuY3lDaGVjayB7XG4gIHJlYWRvbmx5IG9sZFNpemU6IG51bWJlcjtcbiAgcmVhZG9ubHkgbmV3U2l6ZTogbnVtYmVyO1xuICByZWFkb25seSBvbGRSb290OiBzdHJpbmc7XG4gIHJlYWRvbmx5IG5ld1Jvb3Q6IHN0cmluZztcbiAgcmVhZG9ubHkgcHJvb2Y6IHJlYWRvbmx5IHN0cmluZ1tdO1xufVxuXG4vKiogUkZDIDkxNjIgc2VjdGlvbiAyLjEuNC4yLiBSZXR1cm5zIGZhbHNlIChuZXZlciB0aHJvd3MpIGZvciBhbnkgbWFsZm9ybWVkIGlucHV0LiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHZlcmlmeUNvbnNpc3RlbmN5KGNoZWNrOiBDb25zaXN0ZW5jeUNoZWNrKTogYm9vbGVhbiB7XG4gIGNvbnN0IHsgb2xkU2l6ZSwgbmV3U2l6ZSwgcHJvb2YgfSA9IGNoZWNrO1xuICBpZiAoIU51bWJlci5pc1NhZmVJbnRlZ2VyKG9sZFNpemUpIHx8ICFOdW1iZXIuaXNTYWZlSW50ZWdlcihuZXdTaXplKSB8fCBvbGRTaXplIDwgMCB8fCBvbGRTaXplID4gbmV3U2l6ZSkgcmV0dXJuIGZhbHNlO1xuICBpZiAoIUhFWDY0LnRlc3QoY2hlY2sub2xkUm9vdCkgfHwgIUhFWDY0LnRlc3QoY2hlY2submV3Um9vdCkgfHwgIXByb29mLmV2ZXJ5KChwKSA9PiBIRVg2NC50ZXN0KHApKSkgcmV0dXJuIGZhbHNlO1xuICBpZiAob2xkU2l6ZSA9PT0gbmV3U2l6ZSkgcmV0dXJuIHByb29mLmxlbmd0aCA9PT0gMCAmJiBjaGVjay5vbGRSb290ID09PSBjaGVjay5uZXdSb290O1xuICBpZiAob2xkU2l6ZSA9PT0gMCkgcmV0dXJuIHByb29mLmxlbmd0aCA9PT0gMCAmJiBjaGVjay5vbGRSb290ID09PSBFTVBUWV9ST09UO1xuICBpZiAocHJvb2YubGVuZ3RoID09PSAwKSByZXR1cm4gZmFsc2U7XG4gIGNvbnN0IGlzUG93MiA9IChvbGRTaXplICYgKG9sZFNpemUgLSAxKSkgPT09IDA7XG4gIGNvbnN0IHBhdGggPSBpc1BvdzIgPyBbY2hlY2sub2xkUm9vdCwgLi4ucHJvb2ZdIDogWy4uLnByb29mXTtcbiAgbGV0IGZuID0gb2xkU2l6ZSAtIDE7XG4gIGxldCBzbiA9IG5ld1NpemUgLSAxO1xuICB3aGlsZSAoaXNPZGQoZm4pKSB7XG4gICAgZm4gPSBoYWxmKGZuKTtcbiAgICBzbiA9IGhhbGYoc24pO1xuICB9XG4gIGxldCBmciA9IHBhdGhbMF0hO1xuICBsZXQgc3IgPSBwYXRoWzBdITtcbiAgZm9yIChjb25zdCBjIG9mIHBhdGguc2xpY2UoMSkpIHtcbiAgICBpZiAoc24gPT09IDApIHJldHVybiBmYWxzZTtcbiAgICBpZiAoaXNPZGQoZm4pIHx8IGZuID09PSBzbikge1xuICAgICAgZnIgPSBub2RlSGFzaChjLCBmcik7XG4gICAgICBzciA9IG5vZGVIYXNoKGMsIHNyKTtcbiAgICAgIGlmICghaXNPZGQoZm4pKSB7XG4gICAgICAgIHdoaWxlICghaXNPZGQoZm4pICYmIGZuICE9PSAwKSB7XG4gICAgICAgICAgZm4gPSBoYWxmKGZuKTtcbiAgICAgICAgICBzbiA9IGhhbGYoc24pO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfSBlbHNlIHtcbiAgICAgIHNyID0gbm9kZUhhc2goc3IsIGMpO1xuICAgIH1cbiAgICBmbiA9IGhhbGYoZm4pO1xuICAgIHNuID0gaGFsZihzbik7XG4gIH1cbiAgcmV0dXJuIGZyID09PSBjaGVjay5vbGRSb290ICYmIHNyID09PSBjaGVjay5uZXdSb290ICYmIHNuID09PSAwO1xufVxuIl0sImZpbGUiOiIvQGZzL2hvbWUvbWFyc2gtb2ZmaWNlL3BhcGVyY3VwYWktd29ya3NwYWNlL3BhcGVyY3VzcC9saWJzL2dlbmVyaWMvbWVya2xlLWxvZy9zcmMvbWVya2xlLWxvZy50cyJ9

//# vitestCache=W3siZmlsZSI6IjEiLCJpZCI6IjEiLCJ1cmwiOiIyIiwiaW1wb3J0ZWRVcmxzIjoiMyIsIm1hcHBpbmdzIjpmYWxzZX0sIi9ob21lL21hcnNoLW9mZmljZS9wYXBlcmN1cGFpLXdvcmtzcGFjZS9wYXBlcmN1c3AvbGlicy9nZW5lcmljL21lcmtsZS1sb2cvc3JjL21lcmtsZS1sb2cudHMiLCIvQGZzL2hvbWUvbWFyc2gtb2ZmaWNlL3BhcGVyY3VwYWktd29ya3NwYWNlL3BhcGVyY3VzcC9saWJzL2dlbmVyaWMvbWVya2xlLWxvZy9zcmMvbWVya2xlLWxvZy50cyIsW11d
}}