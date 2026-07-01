__vite_ssr_exportName__("JcsError", () => { try { return JcsError } catch {} });
__vite_ssr_exportName__("canonicalize", () => { try { return canonicalize } catch {} });
__vite_ssr_exportName__("canonicalizeBytes", () => { try { return canonicalizeBytes } catch {} });
class JcsError extends Error {
  constructor(message) {
    super(message);
    this.name = "JcsError";
  }
};
function canonicalize(value) {
  return serialize(value);
};
function canonicalizeBytes(value) {
  return new TextEncoder().encode(canonicalize(value));
};
function serialize(value) {
  if (value === null) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  const t = typeof value;
  if (t === "number") return serializeNumber(value);
  if (t === "string") return serializeString(value);
  if (t === "bigint")
    throw new JcsError("bigint is not representable in canonical JSON");
  if (Array.isArray(value)) {
    let out = "[";
    for (let i = 0; i < value.length; i++) {
      if (i > 0) out += ",";
      out += serialize(value[i]);
    };
    return out + "]";
  };
  if (t === "object") {
    const obj = value;
    const keys = Object.keys(obj).filter((k) => obj[k] !== void 0);
    keys.sort(compareUtf16);
    let out = "{";
    for (let i = 0; i < keys.length; i++) {
      if (i > 0) out += ",";
      const k = keys[i];
      out += serializeString(k) + ":" + serialize(obj[k]);
    };
    return out + "}";
  };
  throw new JcsError(`unsupported value of type ${t}`);
}
function serializeNumber(n) {
  if (!Number.isFinite(n)) throw new JcsError("non-finite number");
  if (Object.is(n, -0)) return "0";
  return String(n);
}
function compareUtf16(a, b) {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const ca = a.charCodeAt(i);
    const cb = b.charCodeAt(i);
    if (ca !== cb) return ca - cb;
  };
  return a.length - b.length;
}
function serializeString(s) {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 34) out += '\\"';
    else if (c === 92) out += "\\\\";
    else if (c === 8) out += "\\b";
    else if (c === 9) out += "\\t";
    else if (c === 10) out += "\\n";
    else if (c === 12) out += "\\f";
    else if (c === 13) out += "\\r";
    else if (c < 32)
      out += "\\u" + c.toString(16).padStart(4, "0");
    else out += s[i];
  };
  return out + '"';
}
//# sourceMappingSource=vite-generated
//# sourceMappingURL=data:application/json;base64,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TyxFQUFFLENBQUM7QUFBQSxFQUNqQjtBQUNBLFNBQU8sTUFBTTtBQUNmIiwibmFtZXMiOltdLCJpZ25vcmVMaXN0IjpbXSwic291cmNlcyI6WyJqY3MudHMiXSwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBSRkMgODc4NSBKU09OIENhbm9uaWNhbGl6YXRpb24gU2NoZW1lIChKQ1MpLlxuICpcbiAqIFByb2R1Y2VzIGEgZGV0ZXJtaW5pc3RpYyBieXRlLWZvci1ieXRlIHNlcmlhbGl6YXRpb24gb2YgYW55IEpTT04gdmFsdWUuXG4gKiBSZXF1aXJlZCBmb3IgY3Jvc3MtcnVudGltZSBoYXNoIGFncmVlbWVudDogV29ya2VyIChWOCBpc29sYXRlcykgYW5kIE5vZGVcbiAqIChWOCB3aXRoIGRpZmZlcmVudCBzdHJpbmdpZnkgcGF0aCkgbXVzdCBwcm9kdWNlIGlkZW50aWNhbCBieXRlcyBmb3IgdGhlXG4gKiBjYW5vbmljYWwtbWFuaWZlc3Qgc2hhMjU2IHRvIG1hdGNoIHRoZSBKV1QncyBgc2hhMjU2YCBjbGFpbS5cbiAqXG4gKiBSdWxlcyBpbXBsZW1lbnRlZDpcbiAqICAgLSBPYmplY3Qga2V5cyBzb3J0ZWQgYnkgVVRGLTE2IGNvZGUgdW5pdCBvcmRlciAoRUNNQS0yNjIgY29kZVBvaW50QXQpLlxuICogICAtIE5vIGluc2lnbmlmaWNhbnQgd2hpdGVzcGFjZS5cbiAqICAgLSBOdW1iZXJzIGluIHNob3J0ZXN0IHJvdW5kLXRyaXAgZm9ybSAoRUNNQVNjcmlwdCBgTnVtYmVyLnByb3RvdHlwZS50b1N0cmluZ2BcbiAqICAgICBoYXBwZW5zIHRvIG1hdGNoIFJGQyA3MTU5IC8gRVMyMDE5IE51bWJlciBzZXJpYWxpemF0aW9uIGZvciBmaW5pdGUgbnVtYmVycztcbiAqICAgICBub24tZmluaXRlIHZhbHVlcyByZWplY3RlZCkuXG4gKiAgIC0gU3RyaW5ncyBlc2NhcGVkIHBlciBSRkMgODI1OSDCpzcgbWluaW1hbCBlc2NhcGUgc2V0LlxuICovXG5cbmV4cG9ydCBjbGFzcyBKY3NFcnJvciBleHRlbmRzIEVycm9yIHtcbiAgY29uc3RydWN0b3IobWVzc2FnZTogc3RyaW5nKSB7XG4gICAgc3VwZXIobWVzc2FnZSk7XG4gICAgdGhpcy5uYW1lID0gJ0pjc0Vycm9yJztcbiAgfVxufVxuXG5leHBvcnQgZnVuY3Rpb24gY2Fub25pY2FsaXplKHZhbHVlOiB1bmtub3duKTogc3RyaW5nIHtcbiAgcmV0dXJuIHNlcmlhbGl6ZSh2YWx1ZSk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBjYW5vbmljYWxpemVCeXRlcyh2YWx1ZTogdW5rbm93bik6IFVpbnQ4QXJyYXkge1xuICByZXR1cm4gbmV3IFRleHRFbmNvZGVyKCkuZW5jb2RlKGNhbm9uaWNhbGl6ZSh2YWx1ZSkpO1xufVxuXG5mdW5jdGlvbiBzZXJpYWxpemUodmFsdWU6IHVua25vd24pOiBzdHJpbmcge1xuICBpZiAodmFsdWUgPT09IG51bGwpIHJldHVybiAnbnVsbCc7XG4gIGlmICh2YWx1ZSA9PT0gdHJ1ZSkgcmV0dXJuICd0cnVlJztcbiAgaWYgKHZhbHVlID09PSBmYWxzZSkgcmV0dXJuICdmYWxzZSc7XG5cbiAgY29uc3QgdCA9IHR5cGVvZiB2YWx1ZTtcbiAgaWYgKHQgPT09ICdudW1iZXInKSByZXR1cm4gc2VyaWFsaXplTnVtYmVyKHZhbHVlIGFzIG51bWJlcik7XG4gIGlmICh0ID09PSAnc3RyaW5nJykgcmV0dXJuIHNlcmlhbGl6ZVN0cmluZyh2YWx1ZSBhcyBzdHJpbmcpO1xuICBpZiAodCA9PT0gJ2JpZ2ludCcpXG4gICAgdGhyb3cgbmV3IEpjc0Vycm9yKCdiaWdpbnQgaXMgbm90IHJlcHJlc2VudGFibGUgaW4gY2Fub25pY2FsIEpTT04nKTtcblxuICBpZiAoQXJyYXkuaXNBcnJheSh2YWx1ZSkpIHtcbiAgICBsZXQgb3V0ID0gJ1snO1xuICAgIGZvciAobGV0IGkgPSAwOyBpIDwgdmFsdWUubGVuZ3RoOyBpKyspIHtcbiAgICAgIGlmIChpID4gMCkgb3V0ICs9ICcsJztcbiAgICAgIG91dCArPSBzZXJpYWxpemUodmFsdWVbaV0pO1xuICAgIH1cbiAgICByZXR1cm4gb3V0ICsgJ10nO1xuICB9XG5cbiAgaWYgKHQgPT09ICdvYmplY3QnKSB7XG4gICAgY29uc3Qgb2JqID0gdmFsdWUgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gICAgY29uc3Qga2V5cyA9IE9iamVjdC5rZXlzKG9iaikuZmlsdGVyKChrKSA9PiBvYmpba10gIT09IHVuZGVmaW5lZCk7XG4gICAga2V5cy5zb3J0KGNvbXBhcmVVdGYxNik7XG4gICAgbGV0IG91dCA9ICd7JztcbiAgICBmb3IgKGxldCBpID0gMDsgaSA8IGtleXMubGVuZ3RoOyBpKyspIHtcbiAgICAgIGlmIChpID4gMCkgb3V0ICs9ICcsJztcbiAgICAgIGNvbnN0IGsgPSBrZXlzW2ldITtcbiAgICAgIG91dCArPSBzZXJpYWxpemVTdHJpbmcoaykgKyAnOicgKyBzZXJpYWxpemUob2JqW2tdKTtcbiAgICB9XG4gICAgcmV0dXJuIG91dCArICd9JztcbiAgfVxuXG4gIHRocm93IG5ldyBKY3NFcnJvcihgdW5zdXBwb3J0ZWQgdmFsdWUgb2YgdHlwZSAke3R9YCk7XG59XG5cbmZ1bmN0aW9uIHNlcmlhbGl6ZU51bWJlcihuOiBudW1iZXIpOiBzdHJpbmcge1xuICBpZiAoIU51bWJlci5pc0Zpbml0ZShuKSkgdGhyb3cgbmV3IEpjc0Vycm9yKCdub24tZmluaXRlIG51bWJlcicpO1xuICBpZiAoT2JqZWN0LmlzKG4sIC0wKSkgcmV0dXJuICcwJztcbiAgcmV0dXJuIFN0cmluZyhuKTtcbn1cblxuZnVuY3Rpb24gY29tcGFyZVV0ZjE2KGE6IHN0cmluZywgYjogc3RyaW5nKTogbnVtYmVyIHtcbiAgY29uc3QgbGVuID0gTWF0aC5taW4oYS5sZW5ndGgsIGIubGVuZ3RoKTtcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBsZW47IGkrKykge1xuICAgIGNvbnN0IGNhID0gYS5jaGFyQ29kZUF0KGkpO1xuICAgIGNvbnN0IGNiID0gYi5jaGFyQ29kZUF0KGkpO1xuICAgIGlmIChjYSAhPT0gY2IpIHJldHVybiBjYSAtIGNiO1xuICB9XG4gIHJldHVybiBhLmxlbmd0aCAtIGIubGVuZ3RoO1xufVxuXG5mdW5jdGlvbiBzZXJpYWxpemVTdHJpbmcoczogc3RyaW5nKTogc3RyaW5nIHtcbiAgbGV0IG91dCA9ICdcIic7XG4gIGZvciAobGV0IGkgPSAwOyBpIDwgcy5sZW5ndGg7IGkrKykge1xuICAgIGNvbnN0IGMgPSBzLmNoYXJDb2RlQXQoaSk7XG4gICAgaWYgKGMgPT09IDB4MjIpIG91dCArPSAnXFxcXFwiJztcbiAgICBlbHNlIGlmIChjID09PSAweDVjKSBvdXQgKz0gJ1xcXFxcXFxcJztcbiAgICBlbHNlIGlmIChjID09PSAweDA4KSBvdXQgKz0gJ1xcXFxiJztcbiAgICBlbHNlIGlmIChjID09PSAweDA5KSBvdXQgKz0gJ1xcXFx0JztcbiAgICBlbHNlIGlmIChjID09PSAweDBhKSBvdXQgKz0gJ1xcXFxuJztcbiAgICBlbHNlIGlmIChjID09PSAweDBjKSBvdXQgKz0gJ1xcXFxmJztcbiAgICBlbHNlIGlmIChjID09PSAweDBkKSBvdXQgKz0gJ1xcXFxyJztcbiAgICBlbHNlIGlmIChjIDwgMHgyMClcbiAgICAgIG91dCArPSAnXFxcXHUnICsgYy50b1N0cmluZygxNikucGFkU3RhcnQoNCwgJzAnKTtcbiAgICBlbHNlIG91dCArPSBzW2ldO1xuICB9XG4gIHJldHVybiBvdXQgKyAnXCInO1xufVxuIl0sImZpbGUiOiIvQGZzL2hvbWUvbWFyc2gtb2ZmaWNlL3BhcGVyY3VwYWktd29ya3NwYWNlL3BhcGVyY3VzcC9saWJzL3BhcGVyY3VzcC1wdWJsaXNoLWF1dGgvc3JjL2pjcy50cyJ9

//# vitestCache=W3siZmlsZSI6IjEiLCJpZCI6IjEiLCJ1cmwiOiIyIiwiaW1wb3J0ZWRVcmxzIjoiMyIsIm1hcHBpbmdzIjpmYWxzZX0sIi9ob21lL21hcnNoLW9mZmljZS9wYXBlcmN1cGFpLXdvcmtzcGFjZS9wYXBlcmN1c3AvbGlicy9wYXBlcmN1c3AtcHVibGlzaC1hdXRoL3NyYy9qY3MudHMiLCIvQGZzL2hvbWUvbWFyc2gtb2ZmaWNlL3BhcGVyY3VwYWktd29ya3NwYWNlL3BhcGVyY3VzcC9saWJzL3BhcGVyY3VzcC1wdWJsaXNoLWF1dGgvc3JjL2pjcy50cyIsW11d