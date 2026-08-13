import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export const PASSING_TASK_VERDICT_CACHE_VERSION = 1;
export const PASSING_TASK_VERDICT_IMPLEMENTATION_VERSION =
  "affected-passing-task-verdict-v1";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function normalize(value) {
  if (Array.isArray(value)) return value.map((entry) => normalize(entry));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, normalize(entry)]),
    );
  }
  return value;
}

export function stableJson(value) {
  return JSON.stringify(normalize(value));
}

export function emptyPassingTaskVerdictCache() {
  return { version: PASSING_TASK_VERDICT_CACHE_VERSION, entries: {} };
}

/**
 * Read fail-closed: malformed, incomplete, or version-skewed state is an empty cache with an
 * operator-visible reason. A cache file can only save work; it never gets to block the gate.
 */
export function readPassingTaskVerdictCache(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (parsed?.version !== PASSING_TASK_VERDICT_CACHE_VERSION) {
      return {
        cache: emptyPassingTaskVerdictCache(),
        reason: "cache-version-mismatch",
      };
    }
    if (
      !parsed.entries ||
      typeof parsed.entries !== "object" ||
      Array.isArray(parsed.entries)
    ) {
      return {
        cache: emptyPassingTaskVerdictCache(),
        reason: "cache-shape-invalid",
      };
    }
    return { cache: parsed, reason: "cache-ready" };
  } catch (error) {
    return {
      cache: emptyPassingTaskVerdictCache(),
      reason: error?.code === "ENOENT" ? "cache-file-missing" : "cache-corrupt",
    };
  }
}

/** Write via same-directory rename so a reader observes the old complete file or the new one. */
export function writePassingTaskVerdictCacheAtomic(
  path,
  cache,
  nonce = `${process.pid}-${Date.now()}`,
) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${nonce}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(cache, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

function digestFile(root, file, digestCache) {
  if (typeof file !== "string" || !file || isAbsolute(file)) {
    return { ok: false, reason: "provenance-incomplete:invalid-path" };
  }
  const abs = resolve(root, file);
  const back = relative(root, abs);
  if (back === ".." || back.startsWith(`..${sep}`) || isAbsolute(back)) {
    return {
      ok: false,
      reason: `provenance-incomplete:path-escaped-root:${file}`,
    };
  }
  if (digestCache?.has(abs)) return { ok: true, ...digestCache.get(abs) };
  try {
    const stat = lstatSync(abs);
    let kind;
    let content;
    if (stat.isSymbolicLink()) {
      kind = "symlink";
      content = Buffer.from(readlinkSync(abs));
    } else if (stat.isFile()) {
      kind = "file";
      content = readFileSync(abs);
    } else {
      return {
        ok: false,
        reason: `provenance-incomplete:unsupported-file-type:${file}`,
      };
    }
    const value = {
      kind,
      mode: stat.mode & 0o777,
      digest: sha256(content),
    };
    digestCache?.set(abs, value);
    return { ok: true, ...value };
  } catch {
    return {
      ok: false,
      reason: `provenance-incomplete:unreadable-file:${file}`,
    };
  }
}

/**
 * Hash the exact paths, file kinds/modes, and bytes in a task's dependency closure. Callers pass
 * any known enumeration gaps via `unavailable`; uncertainty is a miss rather than a smaller hash.
 */
export function hashDependencyFileSet({
  root,
  files,
  unavailable = [],
  digestCache = new Map(),
}) {
  if (unavailable.length > 0) {
    return {
      ok: false,
      reason: `provenance-incomplete:unscanned-submodule:${[...unavailable].sort()[0]}`,
    };
  }
  const unique = [...new Set(files)].sort();
  if (unique.length === 0) {
    return {
      ok: false,
      reason: "provenance-incomplete:empty-dependency-closure",
    };
  }
  const hash = createHash("sha256");
  hash.update("passing-task-dependency-closure-v1\0");
  for (const file of unique) {
    const digest = digestFile(root, file, digestCache);
    if (!digest.ok) return digest;
    hash.update(file);
    hash.update("\0");
    hash.update(digest.kind);
    hash.update("\0");
    hash.update(String(digest.mode));
    hash.update("\0");
    hash.update(digest.digest);
    hash.update("\0");
  }
  return { ok: true, hash: hash.digest("hex"), fileCount: unique.length };
}

export function buildPassingTaskVerdictIdentity({
  taskKey,
  command,
  environment,
  gateConfig,
  dependencyHash,
  implementationVersion = PASSING_TASK_VERDICT_IMPLEMENTATION_VERSION,
}) {
  const components = {
    command: sha256(stableJson(command)),
    environment: sha256(stableJson(environment)),
    gateConfig: sha256(stableJson(gateConfig)),
    implementation: sha256(String(implementationVersion)),
    dependencyClosure: dependencyHash,
  };
  return {
    taskKey,
    components,
    fingerprint: sha256(stableJson({ taskKey, components })),
  };
}

const COMPONENT_REASON_ORDER = [
  ["implementation", "implementation-version-changed"],
  ["command", "command-changed"],
  ["environment", "environment-changed"],
  ["gateConfig", "gate-config-changed"],
  ["dependencyClosure", "dependency-closure-changed"],
];

export function decidePassingTaskVerdict({
  enabled,
  cacheRead,
  entry,
  identity,
}) {
  if (!enabled) return { hit: false, reason: "cache-disabled" };
  if (!identity) return { hit: false, reason: "provenance-incomplete" };
  if (!entry) {
    return {
      hit: false,
      reason:
        cacheRead?.reason === "cache-ready"
          ? "no-prior-verdict"
          : cacheRead?.reason,
    };
  }
  for (const [component, reason] of COMPONENT_REASON_ORDER) {
    if (entry.components?.[component] !== identity.components[component]) {
      return { hit: false, reason };
    }
  }
  if (entry.fingerprint !== identity.fingerprint) {
    return { hit: false, reason: "identity-fingerprint-mismatch" };
  }
  return { hit: true, reason: "identity-match" };
}

export function passingTaskVerdictEntry(
  identity,
  passedAt = new Date().toISOString(),
) {
  return {
    fingerprint: identity.fingerprint,
    components: identity.components,
    passedAt,
  };
}

export function mergePassingTaskVerdictUpdates(cache, updates) {
  return {
    version: PASSING_TASK_VERDICT_CACHE_VERSION,
    entries: { ...(cache?.entries ?? {}), ...updates },
  };
}
