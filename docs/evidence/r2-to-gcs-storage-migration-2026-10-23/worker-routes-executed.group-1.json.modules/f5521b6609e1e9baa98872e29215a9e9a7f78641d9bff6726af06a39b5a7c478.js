__vite_ssr_exportName__("WORKSPACE_HOST_AGENT_HOME_BUNDLE_VERSION", () => { try { return WORKSPACE_HOST_AGENT_HOME_BUNDLE_VERSION } catch {} });
__vite_ssr_exportName__("WORKSPACE_HOST_AGENT_HOME_MUTABLE_CACHE_BUNDLE_VERSION", () => { try { return WORKSPACE_HOST_AGENT_HOME_MUTABLE_CACHE_BUNDLE_VERSION } catch {} });
__vite_ssr_exportName__("WORKSPACE_HOST_AGENT_HOME_LEGACY_BUNDLE_VERSION", () => { try { return WORKSPACE_HOST_AGENT_HOME_LEGACY_BUNDLE_VERSION } catch {} });
__vite_ssr_exportName__("WORKSPACE_HOST_AGENT_HOME_FILES", () => { try { return WORKSPACE_HOST_AGENT_HOME_FILES } catch {} });
__vite_ssr_exportName__("WORKSPACE_HOST_AGENT_HOME_OMP_MODELS_RELATIVE_PATH", () => { try { return WORKSPACE_HOST_AGENT_HOME_OMP_MODELS_RELATIVE_PATH } catch {} });
__vite_ssr_exportName__("WORKSPACE_HOST_AGENT_HOME_OLLAMA_BASE_URL", () => { try { return WORKSPACE_HOST_AGENT_HOME_OLLAMA_BASE_URL } catch {} });
__vite_ssr_exportName__("WORKSPACE_HOST_AGENT_HOME_OMP_LOCAL_MODELS_YML", () => { try { return WORKSPACE_HOST_AGENT_HOME_OMP_LOCAL_MODELS_YML } catch {} });
__vite_ssr_exportName__("WORKSPACE_HOST_AGENT_HOME_STATE_VERSION", () => { try { return WORKSPACE_HOST_AGENT_HOME_STATE_VERSION } catch {} });
__vite_ssr_exportName__("WORKSPACE_HOST_AGENT_HOME_FAMILIES", () => { try { return WORKSPACE_HOST_AGENT_HOME_FAMILIES } catch {} });
__vite_ssr_exportName__("WorkspaceHostAgentHomeStateError", () => { try { return WorkspaceHostAgentHomeStateError } catch {} });
__vite_ssr_exportName__("WorkspaceHostAgentHomeBundleError", () => { try { return WorkspaceHostAgentHomeBundleError } catch {} });
__vite_ssr_exportName__("WORKSPACE_HOST_CODEX_NEUTRALIZED_REFRESH_TOKEN", () => { try { return WORKSPACE_HOST_CODEX_NEUTRALIZED_REFRESH_TOKEN } catch {} });
__vite_ssr_exportName__("WORKSPACE_HOST_CLAUDE_NEUTRALIZED_REFRESH_TOKEN", () => { try { return WORKSPACE_HOST_CLAUDE_NEUTRALIZED_REFRESH_TOKEN } catch {} });
__vite_ssr_exportName__("assertWorkspaceHostCodexAccessTokenProjection", () => { try { return assertWorkspaceHostCodexAccessTokenProjection } catch {} });
__vite_ssr_exportName__("assertWorkspaceHostCodexProjectionCliReadable", () => { try { return assertWorkspaceHostCodexProjectionCliReadable } catch {} });
__vite_ssr_exportName__("projectWorkspaceHostCodexAccessToken", () => { try { return projectWorkspaceHostCodexAccessToken } catch {} });
__vite_ssr_exportName__("assertWorkspaceHostClaudeAccessTokenProjection", () => { try { return assertWorkspaceHostClaudeAccessTokenProjection } catch {} });
__vite_ssr_exportName__("assertWorkspaceHostClaudeProjectionCliReadable", () => { try { return assertWorkspaceHostClaudeProjectionCliReadable } catch {} });
__vite_ssr_exportName__("projectWorkspaceHostClaudeAccessToken", () => { try { return projectWorkspaceHostClaudeAccessToken } catch {} });
__vite_ssr_exportName__("parseWorkspaceHostAgentHomeBundle", () => { try { return parseWorkspaceHostAgentHomeBundle } catch {} });
__vite_ssr_exportName__("encodeWorkspaceHostAgentHomeBundle", () => { try { return encodeWorkspaceHostAgentHomeBundle } catch {} });
__vite_ssr_exportName__("assertWorkspaceHostAgentHomeBundleAdmissionEligible", () => { try { return assertWorkspaceHostAgentHomeBundleAdmissionEligible } catch {} });
__vite_ssr_exportName__("workspaceHostAgentHomePaths", () => { try { return workspaceHostAgentHomePaths } catch {} });
__vite_ssr_exportName__("workspaceHostAgentHomeOmpModelsPath", () => { try { return workspaceHostAgentHomeOmpModelsPath } catch {} });
__vite_ssr_exportName__("requireExplicitWorkspaceHostHome", () => { try { return requireExplicitWorkspaceHostHome } catch {} });
__vite_ssr_exportName__("workspaceHostAgentHomeDirectories", () => { try { return workspaceHostAgentHomeDirectories } catch {} });
__vite_ssr_exportName__("workspaceHostAgentHomeStatePath", () => { try { return workspaceHostAgentHomeStatePath } catch {} });
__vite_ssr_exportName__("workspaceHostAgentHomeLockPath", () => { try { return workspaceHostAgentHomeLockPath } catch {} });
__vite_ssr_exportName__("encodeWorkspaceHostAgentHomeState", () => { try { return encodeWorkspaceHostAgentHomeState } catch {} });
__vite_ssr_exportName__("parseWorkspaceHostAgentHomeState", () => { try { return parseWorkspaceHostAgentHomeState } catch {} });
__vite_ssr_exportName__("WorkspaceHostAgentHomeConsumer", () => { try { return WorkspaceHostAgentHomeConsumer } catch {} });
const __vite_ssr_import_0__ = await __vite_ssr_import__("node:path", {"importedNames":["isAbsolute","join","normalize"]});
const __vite_ssr_import_1__ = await __vite_ssr_import__("/@fs/home/marsh-office/papercupai-workspace/papercusp/libs/generic/deployment-driver/src/workspace-host-credential-delivery.ts", {"importedNames":["withWorkspaceHostCredentialFilesystemLock"]});
const __vite_ssr_import_2__ = await __vite_ssr_import__("/@fs/home/marsh-office/papercupai-workspace/papercusp/libs/generic/deployment-driver/src/workspace-host-agent-authentication.ts", {"importedNames":["WORKSPACE_HOST_OMP_LOCAL_MODEL"]});



const WORKSPACE_HOST_AGENT_HOME_BUNDLE_VERSION = "papercusp-workspace-host-agent-home-bundle-v3";
const WORKSPACE_HOST_AGENT_HOME_MUTABLE_CACHE_BUNDLE_VERSION = "papercusp-workspace-host-agent-home-bundle-v2";
const WORKSPACE_HOST_AGENT_HOME_LEGACY_BUNDLE_VERSION = "papercusp-workspace-host-agent-home-bundle-v1";
const WORKSPACE_HOST_AGENT_HOME_FILES = {
  claude: [".claude", ".credentials.json"],
  codex: [".codex", "auth.json"],
  omp: [".omp", "agent", "auth.json"]
};
const WORKSPACE_HOST_AGENT_HOME_OMP_MODELS_RELATIVE_PATH = ".omp/agent/models.yml";
const WORKSPACE_HOST_AGENT_HOME_OLLAMA_BASE_URL = "http://127.0.0.1:11434/v1";
const WORKSPACE_HOST_AGENT_HOME_OMP_LOCAL_MODELS_YML = [
  "providers:",
  "  ollama:",
  `    baseUrl: ${WORKSPACE_HOST_AGENT_HOME_OLLAMA_BASE_URL}`,
  "    api: openai-completions",
  "    auth: none",
  "    discovery:",
  "      type: ollama",
  "    models:",
  `      - id: ${__vite_ssr_import_2__.WORKSPACE_HOST_OMP_LOCAL_MODEL}`,
  `        name: ${__vite_ssr_import_2__.WORKSPACE_HOST_OMP_LOCAL_MODEL}`,
  "        api: openai-completions",
  "        input:",
  "          - text",
  ""
].join("\n");
const WORKSPACE_HOST_AGENT_HOME_STATE_VERSION = "papercusp-workspace-host-agent-home-state-v1";
const WORKSPACE_HOST_AGENT_HOME_FAMILIES = [
  "agent-forwarded-reference",
  "agent-encrypted-reference"
];
class WorkspaceHostAgentHomeStateError extends Error {
  family;
  generation;
  constructor(message, details = {}) {
    super(message);
    this.name = "WorkspaceHostAgentHomeStateError";
    this.family = details.family;
    this.generation = details.generation;
  }
};
class WorkspaceHostAgentHomeBundleError extends Error {
  constructor(message) {
    super(message);
    this.name = "WorkspaceHostAgentHomeBundleError";
  }
};
function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkspaceHostAgentHomeBundleError(`${label} must be an object`);
  };
  return value;
}
function exactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new WorkspaceHostAgentHomeBundleError(
      `${label} must contain exactly ${wanted.join(", ")}`
    );
  }
}
function decodeJsonFile(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new WorkspaceHostAgentHomeBundleError(
      `files.${label} must be canonical base64`
    );
  };
  const bytes = Buffer.from(value, "base64");
  if (bytes.length === 0 || bytes.toString("base64") !== value) {
    throw new WorkspaceHostAgentHomeBundleError(
      `files.${label} must be canonical base64`
    );
  };
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new WorkspaceHostAgentHomeBundleError(
      `files.${label} must decode to valid JSON`
    );
  };
  record(parsed, `files.${label} JSON`);
  return bytes;
}
function parseJsonObjectBytes(bytes, label) {
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new WorkspaceHostAgentHomeBundleError(`${label} must be valid JSON`);
  };
  return record(parsed, label);
}
const WORKSPACE_HOST_CODEX_NEUTRALIZED_REFRESH_TOKEN = "";
const WORKSPACE_HOST_CLAUDE_NEUTRALIZED_REFRESH_TOKEN = "";
function normalizedKey(key) {
  return key.replace(/[_-]/g, "").toLowerCase();
}
function credentialKeyPaths(value, matches, path = []) {
  if (Array.isArray(value)) {
    return value.flatMap(
      (nested, index) => credentialKeyPaths(nested, matches, [...path, String(index)])
    );
  };
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, nested]) => {
    const here = [...path, key];
    const named = matches(normalizedKey(key)) ? [here.join(".")] : [];
    return [...named, ...credentialKeyPaths(nested, matches, here)];
  });
}
function refreshTokenKeyPaths(value, path = []) {
  return credentialKeyPaths(value, (key) => key === "refreshtoken", path);
}
function apiKeyPaths(value, path = []) {
  return credentialKeyPaths(
    value,
    (key) => key.endsWith("apikey") || key === "secretkey" || key === "apisecret",
    path
  );
}
function liveApiKeyPaths(value, path = []) {
  if (Array.isArray(value)) {
    return value.flatMap(
      (nested, index) => liveApiKeyPaths(nested, [...path, String(index)])
    );
  };
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, nested]) => {
    const here = [...path, key];
    const live = apiKeyPaths({ [key]: null }).length > 0 && nested !== null && nested !== "" ? [here.join(".")] : [];
    return [...live, ...liveApiKeyPaths(nested, here)];
  });
}
function neutralizeApiKeys(value) {
  if (Array.isArray(value)) return value.map(neutralizeApiKeys);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [
      key,
      apiKeyPaths({ [key]: null }).length ? null : neutralizeApiKeys(nested)
    ])
  );
}
function liveRefreshTokenPaths(value, path = []) {
  if (Array.isArray(value)) {
    return value.flatMap(
      (nested, index) => liveRefreshTokenPaths(nested, [...path, String(index)])
    );
  };
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, nested]) => {
    const here = [...path, key];
    const live = refreshTokenKeyPaths({ [key]: null }).length > 0 && nested !== null && nested !== "" ? [here.join(".")] : [];
    return [...live, ...liveRefreshTokenPaths(nested, here)];
  });
}
function neutralizeRefreshTokens(value) {
  if (Array.isArray(value)) return value.map(neutralizeRefreshTokens);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [
      key,
      refreshTokenKeyPaths({ [key]: null }).length ? WORKSPACE_HOST_CLAUDE_NEUTRALIZED_REFRESH_TOKEN : neutralizeRefreshTokens(nested)
    ])
  );
}
function assertWorkspaceHostCodexAccessTokenProjection(codex) {
  const body = parseJsonObjectBytes(codex, "files.codex JSON");
  const tokens = record(body.tokens, "files.codex JSON.tokens");
  if (typeof tokens.access_token !== "string" || tokens.access_token.length === 0) {
    throw new WorkspaceHostAgentHomeBundleError(
      "files.codex must contain a non-empty access token"
    );
  };
  const refreshKeys = refreshTokenKeyPaths(body);
  const onlyNeutralized = refreshKeys.every((path) => path === "tokens.refresh_token") && (!("refresh_token" in tokens) || tokens.refresh_token === WORKSPACE_HOST_CODEX_NEUTRALIZED_REFRESH_TOKEN);
  if (!onlyNeutralized) {
    throw new WorkspaceHostAgentHomeBundleError(
      "files.codex access-token projection must not contain a refresh token"
    );
  };
  if (liveApiKeyPaths(body).length > 0) {
    throw new WorkspaceHostAgentHomeBundleError(
      "files.codex access-token projection must not contain an API key"
    );
  }
};
function assertWorkspaceHostCodexProjectionCliReadable(codex) {
  assertWorkspaceHostCodexAccessTokenProjection(codex);
  const body = parseJsonObjectBytes(codex, "files.codex JSON");
  const tokens = record(body.tokens, "files.codex JSON.tokens");
  if (tokens.refresh_token !== WORKSPACE_HOST_CODEX_NEUTRALIZED_REFRESH_TOKEN) {
    throw new WorkspaceHostAgentHomeBundleError(
      "files.codex must retain an empty refresh_token field for the Codex CLI to deserialize it; this generation was projected before that fix and must be re-minted"
    );
  };
  if (typeof tokens.id_token !== "string" || tokens.id_token.length === 0) {
    throw new WorkspaceHostAgentHomeBundleError(
      "files.codex must contain a non-empty id_token for the Codex CLI to deserialize it"
    );
  }
};
function projectWorkspaceHostCodexAccessToken(codex) {
  const body = parseJsonObjectBytes(codex, "files.codex JSON");
  const tokens = record(body.tokens, "files.codex JSON.tokens");
  if (typeof tokens.access_token !== "string" || tokens.access_token.length === 0) {
    throw new WorkspaceHostAgentHomeBundleError(
      "files.codex must contain a non-empty access token"
    );
  };
  const projectedTokens = {
    ...neutralizeApiKeys(tokens),
    refresh_token: WORKSPACE_HOST_CODEX_NEUTRALIZED_REFRESH_TOKEN
  };
  const projected = Buffer.from(
    JSON.stringify({
      ...neutralizeApiKeys(body),
      tokens: projectedTokens
    }),
    "utf8"
  );
  assertWorkspaceHostCodexProjectionCliReadable(projected);
  return projected;
};
function assertWorkspaceHostClaudeAccessTokenProjection(claude) {
  const body = parseJsonObjectBytes(claude, "files.claude JSON");
  const oauth = record(body.claudeAiOauth, "files.claude JSON.claudeAiOauth");
  if (typeof oauth.accessToken !== "string" || oauth.accessToken.length === 0) {
    throw new WorkspaceHostAgentHomeBundleError(
      "files.claude must contain a non-empty access token"
    );
  };
  if (liveRefreshTokenPaths(body).length > 0) {
    throw new WorkspaceHostAgentHomeBundleError(
      "files.claude access-token projection must not contain a refresh token"
    );
  };
  if (liveApiKeyPaths(body).length > 0) {
    throw new WorkspaceHostAgentHomeBundleError(
      "files.claude access-token projection must not contain an API key"
    );
  }
};
function assertWorkspaceHostClaudeProjectionCliReadable(claude) {
  assertWorkspaceHostClaudeAccessTokenProjection(claude);
  const body = parseJsonObjectBytes(claude, "files.claude JSON");
  const oauth = record(body.claudeAiOauth, "files.claude JSON.claudeAiOauth");
  if (oauth.refreshToken !== WORKSPACE_HOST_CLAUDE_NEUTRALIZED_REFRESH_TOKEN) {
    throw new WorkspaceHostAgentHomeBundleError(
      "files.claude must retain an empty refreshToken field — the shape measured to authenticate; this generation was projected before that fix and must be re-minted"
    );
  }
};
function projectWorkspaceHostClaudeAccessToken(claude) {
  const body = parseJsonObjectBytes(claude, "files.claude JSON");
  const oauth = record(body.claudeAiOauth, "files.claude JSON.claudeAiOauth");
  if (typeof oauth.accessToken !== "string" || oauth.accessToken.length === 0) {
    throw new WorkspaceHostAgentHomeBundleError(
      "files.claude must contain a non-empty access token"
    );
  };
  const projectedOauth = {
    ...neutralizeApiKeys(neutralizeRefreshTokens(oauth)),
    refreshToken: WORKSPACE_HOST_CLAUDE_NEUTRALIZED_REFRESH_TOKEN
  };
  const projected = Buffer.from(
    JSON.stringify({
      ...neutralizeApiKeys(neutralizeRefreshTokens(body)),
      claudeAiOauth: projectedOauth
    }),
    "utf8"
  );
  assertWorkspaceHostClaudeProjectionCliReadable(projected);
  return projected;
};
function parseWorkspaceHostAgentHomeBundle(material) {
  let parsed;
  try {
    parsed = JSON.parse(material.toString("utf8"));
  } catch {
    throw new WorkspaceHostAgentHomeBundleError(
      "agent-home material must be valid JSON"
    );
  };
  const body = record(parsed, "agent-home material");
  exactKeys(body, ["contractVersion", "files"], "agent-home material");
  if (body.contractVersion !== WORKSPACE_HOST_AGENT_HOME_BUNDLE_VERSION && body.contractVersion !== WORKSPACE_HOST_AGENT_HOME_MUTABLE_CACHE_BUNDLE_VERSION && body.contractVersion !== WORKSPACE_HOST_AGENT_HOME_LEGACY_BUNDLE_VERSION) {
    throw new WorkspaceHostAgentHomeBundleError(
      `agent-home material must use ${WORKSPACE_HOST_AGENT_HOME_BUNDLE_VERSION}, ${WORKSPACE_HOST_AGENT_HOME_MUTABLE_CACHE_BUNDLE_VERSION}, or ${WORKSPACE_HOST_AGENT_HOME_LEGACY_BUNDLE_VERSION}`
    );
  };
  const files = record(body.files, "agent-home material.files");
  exactKeys(
    files,
    Object.keys(WORKSPACE_HOST_AGENT_HOME_FILES),
    "agent-home material.files"
  );
  const contractVersion = body.contractVersion;
  const claude = decodeJsonFile(files.claude, "claude");
  const codex = decodeJsonFile(files.codex, "codex");
  if (contractVersion === WORKSPACE_HOST_AGENT_HOME_BUNDLE_VERSION) {
    assertWorkspaceHostClaudeAccessTokenProjection(claude);
    assertWorkspaceHostCodexAccessTokenProjection(codex);
  };
  return {
    contractVersion,
    files: {
      claude,
      codex,
      omp: contractVersion !== WORKSPACE_HOST_AGENT_HOME_LEGACY_BUNDLE_VERSION && files.omp === null ? null : decodeJsonFile(files.omp, "omp")
    }
  };
};
function encodeWorkspaceHostAgentHomeBundle(files) {
  const claude = projectWorkspaceHostClaudeAccessToken(files.claude);
  const codex = projectWorkspaceHostCodexAccessToken(files.codex);
  if (files.omp !== null) {
    decodeJsonFile(files.omp.toString("base64"), "omp");
  };
  return Buffer.from(
    JSON.stringify({
      contractVersion: WORKSPACE_HOST_AGENT_HOME_BUNDLE_VERSION,
      files: {
        claude: claude.toString("base64"),
        codex: codex.toString("base64"),
        omp: files.omp?.toString("base64") ?? null
      }
    }),
    "utf8"
  );
};
function assertWorkspaceHostAgentHomeBundleAdmissionEligible(bundle) {
  if (bundle.contractVersion !== WORKSPACE_HOST_AGENT_HOME_BUNDLE_VERSION) {
    throw new WorkspaceHostAgentHomeBundleError(
      `agent-home authentication admission requires ${WORKSPACE_HOST_AGENT_HOME_BUNDLE_VERSION}; legacy mutable-cache bundles are read/revoke-only`
    );
  };
  assertWorkspaceHostClaudeProjectionCliReadable(bundle.files.claude);
  assertWorkspaceHostCodexProjectionCliReadable(bundle.files.codex);
};
function workspaceHostAgentHomePaths(home) {
  requireExplicitWorkspaceHostHome(home);
  return {
    claude: (0,__vite_ssr_import_0__.join)(home, ...WORKSPACE_HOST_AGENT_HOME_FILES.claude),
    codex: (0,__vite_ssr_import_0__.join)(home, ...WORKSPACE_HOST_AGENT_HOME_FILES.codex),
    omp: (0,__vite_ssr_import_0__.join)(home, ...WORKSPACE_HOST_AGENT_HOME_FILES.omp)
  };
};
function workspaceHostAgentHomeOmpModelsPath(home) {
  requireExplicitWorkspaceHostHome(home);
  return (0,__vite_ssr_import_0__.join)(
    home,
    ...WORKSPACE_HOST_AGENT_HOME_OMP_MODELS_RELATIVE_PATH.split("/")
  );
};
function requireExplicitWorkspaceHostHome(home) {
  if (typeof home !== "string" || !(0,__vite_ssr_import_0__.isAbsolute)(home) || home === "/" || (0,__vite_ssr_import_0__.normalize)(home) !== home || /[\r\n\0]/.test(home)) {
    throw new WorkspaceHostAgentHomeBundleError(
      "workspace user home must be an absolute, canonical, non-root path"
    );
  };
  return home;
};
function workspaceHostAgentHomeDirectories(home) {
  requireExplicitWorkspaceHostHome(home);
  return [
    home,
    (0,__vite_ssr_import_0__.join)(home, ".claude"),
    (0,__vite_ssr_import_0__.join)(home, ".codex"),
    (0,__vite_ssr_import_0__.join)(home, ".omp"),
    (0,__vite_ssr_import_0__.join)(home, ".omp", "agent")
  ];
};
function workspaceHostAgentHomeStatePath(materialRoot) {
  return (0,__vite_ssr_import_0__.join)(materialRoot, "active", "agent-home.json");
};
function workspaceHostAgentHomeLockPath(materialRoot) {
  return (0,__vite_ssr_import_0__.join)(materialRoot, "active", ".agent-home.lifecycle.lock");
};
function encodeWorkspaceHostAgentHomeState(family, generation, home) {
  if (!WORKSPACE_HOST_AGENT_HOME_FAMILIES.includes(family)) {
    throw new WorkspaceHostAgentHomeBundleError(
      `unsupported agent-home family '${family}'`
    );
  };
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new WorkspaceHostAgentHomeBundleError(
      "agent-home generation must be a positive safe integer"
    );
  };
  const files = workspaceHostAgentHomePaths(home);
  return Buffer.from(
    JSON.stringify({
      contractVersion: WORKSPACE_HOST_AGENT_HOME_STATE_VERSION,
      family,
      generation,
      home,
      files
    }),
    "utf8"
  );
};
function parseWorkspaceHostAgentHomeState(material) {
  let parsed;
  try {
    parsed = JSON.parse(material.toString("utf8"));
  } catch {
    throw new WorkspaceHostAgentHomeBundleError(
      "agent-home state must be valid JSON"
    );
  };
  const body = record(parsed, "agent-home state");
  exactKeys(
    body,
    ["contractVersion", "family", "generation", "home", "files"],
    "agent-home state"
  );
  if (body.contractVersion !== WORKSPACE_HOST_AGENT_HOME_STATE_VERSION) {
    throw new WorkspaceHostAgentHomeBundleError(
      `agent-home state must use ${WORKSPACE_HOST_AGENT_HOME_STATE_VERSION}`
    );
  };
  if (typeof body.family !== "string" || !WORKSPACE_HOST_AGENT_HOME_FAMILIES.includes(
    body.family
  )) {
    throw new WorkspaceHostAgentHomeBundleError(
      "agent-home state has an unsupported family"
    );
  };
  if (!Number.isSafeInteger(body.generation) || body.generation < 1) {
    throw new WorkspaceHostAgentHomeBundleError(
      "agent-home state generation must be a positive safe integer"
    );
  };
  if (typeof body.home !== "string") {
    throw new WorkspaceHostAgentHomeBundleError(
      "agent-home state.home must be a string"
    );
  };
  const home = requireExplicitWorkspaceHostHome(body.home);
  const files = record(body.files, "agent-home state.files");
  exactKeys(
    files,
    Object.keys(WORKSPACE_HOST_AGENT_HOME_FILES),
    "agent-home state.files"
  );
  const expected = workspaceHostAgentHomePaths(home);
  for (const label of Object.keys(expected)) {
    if (files[label] !== expected[label]) {
      throw new WorkspaceHostAgentHomeBundleError(
        `agent-home state.files.${label} does not resolve inside the recorded home`
      );
    }
  };
  return {
    contractVersion: WORKSPACE_HOST_AGENT_HOME_STATE_VERSION,
    family: body.family,
    generation: body.generation,
    home,
    files: expected
  };
};
function compareBytes(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
class WorkspaceHostAgentHomeConsumer {
  filesystem;
  materialRoot;
  agentHome;
  agentUser;
  agentGroup;
  legacyHomes;
  constructor(options) {
    this.filesystem = options.filesystem;
    this.materialRoot = options.materialRoot;
    this.agentHome = requireExplicitWorkspaceHostHome(options.agentHome);
    if (options.agentUser && !options.agentGroup || !options.agentUser && options.agentGroup) {
      throw new WorkspaceHostAgentHomeBundleError(
        "agentUser and agentGroup must be supplied together"
      );
    };
    this.agentUser = options.agentUser;
    this.agentGroup = options.agentGroup;
    this.legacyHomes = (options.legacyHomes ?? []).map((legacy) => {
      const home = requireExplicitWorkspaceHostHome(legacy.home);
      if (home === this.agentHome) {
        throw new WorkspaceHostAgentHomeBundleError(
          "a legacy agent home cannot be the home this consumer installs into"
        );
      };
      return home;
    });
  }
  async readState() {
    const raw = await this.filesystem.readFileIfPresent(
      workspaceHostAgentHomeStatePath(this.materialRoot)
    );
    if (raw === null) return null;
    const state = parseWorkspaceHostAgentHomeState(raw);
    if (state.home === this.agentHome) return { ...state, legacy: false };
    if (this.legacyHomes.includes(state.home)) return { ...state, legacy: true };
    throw new WorkspaceHostAgentHomeStateError(
      "active agent-home state names a different agent home",
      { family: state.family, generation: state.generation }
    );
  }
  /**
   * Remove every managed native credential file from each legacy home (D-421 migration).
   *
   * Runs on every install and revoke, not only when the active record names a legacy home: an
   * install that committed its new record and then died before this sweep would otherwise leave a
   * copy that no later operation looks for. Removal is idempotent and never creates anything in
   * the legacy home — a home that is absent, or a credential directory that is absent, is already
   * clean. Parents are lstat-checked so a symlinked credential directory cannot steer the root
   * consumer's unlink into another account's files.
   */
  async sweepLegacyHomes(family, generation) {
    for (const home of this.legacyHomes) {
      const paths = workspaceHostAgentHomePaths(home);
      for (const path of Object.values(paths)) {
        if (this.filesystem.pathKind) {
          let parentMissing = false;
          for (const directory of workspaceHostAgentHomeDirectories(home)) {
            if (!path.startsWith(`${directory}/`)) continue;
            const kind = await this.filesystem.pathKind(directory);
            if (kind === "missing") {
              parentMissing = true;
              break;
            };
            if (kind !== "directory") {
              throw new WorkspaceHostAgentHomeStateError(
                `legacy agent-home directory '${directory}' is not a real directory`,
                { family, generation }
              );
            }
          };
          if (parentMissing) continue;
        };
        await this.removeNativeFile(path, family, generation);
      }
    }
  }
  async own(path) {
    if (this.agentUser && this.agentGroup && this.filesystem.setOwnership) {
      await this.filesystem.setOwnership(path, this.agentUser, this.agentGroup);
    }
  }
  async requireRealDirectory(directory) {
    if (!this.filesystem.pathKind) return;
    const kind = await this.filesystem.pathKind(directory);
    if (kind !== "directory") {
      throw new WorkspaceHostAgentHomeStateError(
        `workspace agent-home directory '${directory}' is not a real directory`
      );
    }
  }
  /**
   * Temporarily make the home and credential directories root-owned while the root consumer
   * writes. This closes the check/write symlink race: the workspace user cannot swap a validated
   * parent out from under the subsequent atomic rename. Final ownership is restored in reverse
   * order with the home last, so the steady state remains a normal user-owned 0700 native home.
   */
  async secureHomeLayout() {
    const directories = workspaceHostAgentHomeDirectories(this.agentHome);
    const secured = [];
    try {
      for (const directory of directories) {
        await this.filesystem.ensureDirectory(directory);
        await this.requireRealDirectory(directory);
        if (this.agentUser && this.agentGroup && this.filesystem.setOwnership) {
          await this.filesystem.setOwnership(directory, "root", "root");
        };
        secured.push(directory);
      };
      return secured;
    } catch (error) {
      await this.restoreHomeLayout(secured).catch(() => void 0);
      throw error;
    }
  }
  async restoreHomeLayout(directories, files = []) {
    for (const path of files) await this.own(path);
    for (const directory of [...directories].reverse())
      await this.own(directory);
  }
  /**
   * Reconcile the non-secret OMP registry required by the credential-free local-inference path.
   *
   * The agent home is a platform-owned identity home, so this managed registry is deliberately
   * deterministic rather than merged with an ambient service-user config.  A stale gateway or
   * malformed registry would otherwise make the readiness probe select the wrong endpoint while
   * still looking like a valid OMP installation.  The write is idempotent and is performed while
   * secureHomeLayout() has pinned every parent directory root-owned.
   */
  async ensureLocalOmpModelsConfig(family, generation) {
    const path = workspaceHostAgentHomeOmpModelsPath(this.agentHome);
    const expected = Buffer.from(
      WORKSPACE_HOST_AGENT_HOME_OMP_LOCAL_MODELS_YML,
      "utf8"
    );
    let kind = "missing";
    if (this.filesystem.pathKind) {
      kind = await this.filesystem.pathKind(path);
      if (kind !== "missing" && kind !== "file") {
        throw new WorkspaceHostAgentHomeStateError(
          "workspace agent-home OMP models registry is not a regular file",
          { family, generation }
        );
      }
    };
    const existing = kind === "missing" && this.filesystem.pathKind ? null : await this.filesystem.readFileIfPresent(path);
    if (existing === null || !compareBytes(existing, expected)) {
      await this.filesystem.writePrivateFile(path, expected);
    };
    if (this.filesystem.pathKind) {
      const finalKind = await this.filesystem.pathKind(path);
      if (finalKind !== "file") {
        throw new WorkspaceHostAgentHomeStateError(
          "workspace agent-home OMP models registry is not a regular file after write",
          { family, generation }
        );
      }
    };
    return path;
  }
  async verifyLocalOmpModelsConfig(family, generation) {
    const path = workspaceHostAgentHomeOmpModelsPath(this.agentHome);
    if (this.filesystem.pathKind) {
      const kind = await this.filesystem.pathKind(path);
      if (kind !== "file") {
        throw new WorkspaceHostAgentHomeStateError(
          "workspace agent-home OMP models registry is absent or not a regular file",
          { family, generation }
        );
      }
    };
    const existing = await this.filesystem.readFileIfPresent(path);
    if (existing === null || !compareBytes(
      existing,
      Buffer.from(WORKSPACE_HOST_AGENT_HOME_OMP_LOCAL_MODELS_YML, "utf8")
    )) {
      throw new WorkspaceHostAgentHomeStateError(
        "workspace agent-home OMP models registry is absent or stale",
        { family, generation }
      );
    }
  }
  lockPath(family) {
    return workspaceHostAgentHomeLockPath(this.materialRoot);
  }
  async withLock(family, task, lockHeld = false) {
    if (lockHeld) return await task();
    return await (0,__vite_ssr_import_1__.withWorkspaceHostCredentialFilesystemLock)(
      this.filesystem,
      this.lockPath(family),
      task
    );
  }
  async installUnlocked(family, generation, material) {
    if (!WORKSPACE_HOST_AGENT_HOME_FAMILIES.includes(family)) {
      throw new WorkspaceHostAgentHomeStateError(
        `unsupported agent-home family '${family}'`
      );
    };
    if (!Number.isSafeInteger(generation) || generation < 1) {
      throw new WorkspaceHostAgentHomeStateError(
        "agent-home generation must be a positive safe integer"
      );
    };
    const bundle = parseWorkspaceHostAgentHomeBundle(material);
    const current = await this.readState();
    if (current && current.generation > generation) {
      throw new WorkspaceHostAgentHomeStateError(
        `agent-home generation ${generation} is older than active generation ${current.generation}`,
        { family, generation }
      );
    };
    if (current && current.generation === generation && current.family !== family) {
      throw new WorkspaceHostAgentHomeStateError(
        `agent-home generation ${generation} is already active for another family`,
        { family, generation }
      );
    };
    const securedDirectories = await this.secureHomeLayout();
    const installedFiles = [];
    try {
      const paths = workspaceHostAgentHomePaths(this.agentHome);
      const nativeFiles = await Promise.all(
        Object.keys(paths).map(
          async (label) => ({
            label,
            existing: await this.filesystem.readFileIfPresent(paths[label])
          })
        )
      );
      if (current?.generation === generation && !current.legacy) {
        for (const { label, existing } of nativeFiles) {
          const expected = bundle.files[label];
          if (existing !== null && expected !== null && !compareBytes(existing, expected)) {
            throw new WorkspaceHostAgentHomeStateError(
              `agent-home credential '${label}' changed after generation ${generation} was installed; a newer verified credential generation is required`,
              { family, generation }
            );
          }
        }
      };
      for (const { label, existing } of nativeFiles) {
        const bytes = bundle.files[label];
        if (bytes === null) {
          if (existing !== null) {
            await this.removeNativeFile(paths[label], family, generation);
          };
          if (this.filesystem.pathKind) {
            const kind = await this.filesystem.pathKind(paths[label]);
            if (kind !== "missing") {
              throw new WorkspaceHostAgentHomeStateError(
                `workspace agent-home file '${label}' must be absent for credential-free verification`,
                { family, generation }
              );
            }
          };
          continue;
        };
        if (existing === null || !compareBytes(existing, bytes)) {
          await this.filesystem.writePrivateFile(paths[label], bytes);
        };
        if (this.filesystem.pathKind) {
          const kind = await this.filesystem.pathKind(paths[label]);
          if (kind !== "file") {
            throw new WorkspaceHostAgentHomeStateError(
              `workspace agent-home file '${label}' is not a regular file`,
              { family, generation }
            );
          }
        };
        installedFiles.push(paths[label]);
      };
      if (bundle.files.omp === null) {
        installedFiles.push(
          await this.ensureLocalOmpModelsConfig(family, generation)
        );
      };
      await this.sweepLegacyHomes(family, generation);
      await this.filesystem.ensureDirectory((0,__vite_ssr_import_0__.join)(this.materialRoot, "active"));
      await this.filesystem.writePrivateFile(
        workspaceHostAgentHomeStatePath(this.materialRoot),
        encodeWorkspaceHostAgentHomeState(family, generation, this.agentHome)
      );
    } finally {
      await this.restoreHomeLayout(securedDirectories, installedFiles);
    };
    return { family, generation, present: true, home: this.agentHome };
  }
  async removeNativeFile(path, family, generation) {
    if (this.filesystem.pathKind) {
      const kind = await this.filesystem.pathKind(path);
      if (kind !== "missing" && kind !== "file") {
        throw new WorkspaceHostAgentHomeStateError(
          "refusing to remove a non-regular agent-home path",
          { family, generation }
        );
      }
    };
    await this.filesystem.removePath(path);
  }
  async install(family, generation, material, options = {}) {
    return await this.withLock(
      family,
      () => this.installUnlocked(family, generation, material),
      options.lockHeld === true
    );
  }
  async verify(family, generation, material, options = {}) {
    return await this.withLock(
      family,
      async () => {
        const bundle = parseWorkspaceHostAgentHomeBundle(material);
        const current = await this.readState();
        if (current?.legacy) {
          throw new WorkspaceHostAgentHomeStateError(
            `agent-home generation ${current.generation} is installed in the legacy home ${current.home}; bind a credential generation again to migrate it into the agent-running identity's home`,
            { family, generation }
          );
        };
        if (!current || current.family !== family || current.generation !== generation || current.home !== this.agentHome) {
          throw new WorkspaceHostAgentHomeStateError(
            `agent-home generation ${generation} is not the active installed generation`,
            { family, generation }
          );
        };
        const securedDirectories = await this.secureHomeLayout();
        try {
          const paths = workspaceHostAgentHomePaths(this.agentHome);
          for (const label of Object.keys(
            paths
          )) {
            const expectedBytes = bundle.files[label];
            if (this.filesystem.pathKind) {
              const kind = await this.filesystem.pathKind(paths[label]);
              if (expectedBytes === null ? kind !== "missing" : kind !== "file") {
                throw new WorkspaceHostAgentHomeStateError(
                  `agent-home file '${label}' is absent, stale, or points outside the explicit home`,
                  { family, generation }
                );
              }
            };
            const bytes = await this.filesystem.readFileIfPresent(paths[label]);
            if (expectedBytes === null) {
              if (bytes !== null) {
                throw new WorkspaceHostAgentHomeStateError(
                  `agent-home file '${label}' must be absent for credential-free verification`,
                  { family, generation }
                );
              };
              continue;
            };
            if (bytes === null || current.files[label] !== paths[label] || !compareBytes(bytes, expectedBytes)) {
              throw new WorkspaceHostAgentHomeStateError(
                `agent-home file '${label}' is absent, stale, or points outside the explicit home`,
                { family, generation }
              );
            }
          };
          if (bundle.files.omp === null) {
            await this.verifyLocalOmpModelsConfig(family, generation);
          }
        } finally {
          await this.restoreHomeLayout(securedDirectories);
        };
        return { family, generation, present: true, home: this.agentHome };
      },
      options.lockHeld === true
    );
  }
  async revoke(family, generation, options = {}) {
    return await this.withLock(
      family,
      async () => {
        const current = await this.readState();
        if (!current || current.family !== family || current.generation !== generation) {
          return {
            family,
            generation,
            present: false,
            home: this.agentHome
          };
        };
        if (current.legacy) {
          await this.sweepLegacyHomes(family, generation);
          await this.removeNativeFile(
            workspaceHostAgentHomeStatePath(this.materialRoot),
            family,
            generation
          );
          return { family, generation, present: false, home: this.agentHome };
        };
        const securedDirectories = await this.secureHomeLayout();
        try {
          const paths = workspaceHostAgentHomePaths(this.agentHome);
          for (const path of Object.values(paths)) {
            await this.removeNativeFile(path, family, generation);
          };
          await this.sweepLegacyHomes(family, generation);
          await this.removeNativeFile(
            workspaceHostAgentHomeStatePath(this.materialRoot),
            family,
            generation
          );
        } finally {
          await this.restoreHomeLayout(securedDirectories);
        };
        return { family, generation, present: false, home: this.agentHome };
      },
      options.lockHeld === true
    );
  }
  async verifyRevoked(family, generation, options = {}) {
    return await this.withLock(
      family,
      async () => {
        const current = await this.readState();
        if (current?.family === family && current.generation === generation) {
          throw new WorkspaceHostAgentHomeStateError(
            `agent-home generation ${generation} is still active after revocation`,
            { family, generation }
          );
        };
        return { family, generation, present: false, home: this.agentHome };
      },
      options.lockHeld === true
    );
  }
}
//# sourceMappingSource=vite-generated
//# sourceMappingURL=data:application/json;base64,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QUFFLFFBQVEsWUFBWSxTQUFTLE9BQU8sTUFBTSxLQUFLLFVBQVU7QUFBQSxNQUNwRTtBQUFBLE1BQ0EsUUFBUSxhQUFhO0FBQUEsSUFDdkI7QUFBQSxFQUNGO0FBQUEsRUFFQSxNQUFNLGNBQ0osUUFDQSxZQUNBLFVBQTJDLENBQUMsR0FDSztBQUNqRCxXQUFPLE1BQU0sS0FBSztBQUFBLE1BQ2hCO0FBQUEsTUFDQSxZQUFZO0FBQ1YsY0FBTSxVQUFVLE1BQU0sS0FBSyxVQUFVO0FBQ3JDLFlBQUksU0FBUyxXQUFXLFVBQVUsUUFBUSxlQUFlLFlBQVk7QUFDbkUsZ0JBQU0sSUFBSTtBQUFBLFlBQ1IseUJBQXlCLFVBQVU7QUFBQSxZQUNuQyxFQUFFLFFBQVEsV0FBVztBQUFBLFVBQ3ZCO0FBQUEsUUFDRjtBQUNBLGVBQU8sRUFBRSxRQUFRLFlBQVksU0FBUyxPQUFPLE1BQU0sS0FBSyxVQUFVO0FBQUEsTUFDcEU7QUFBQSxNQUNBLFFBQVEsYUFBYTtBQUFBLElBQ3ZCO0FBQUEsRUFDRjtBQUNGIiwibmFtZXMiOltdLCJpZ25vcmVMaXN0IjpbXSwic291cmNlcyI6WyJ3b3Jrc3BhY2UtaG9zdC1hZ2VudC1ob21lLnRzIl0sInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IGlzQWJzb2x1dGUsIGpvaW4sIG5vcm1hbGl6ZSB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IHdpdGhXb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbEZpbGVzeXN0ZW1Mb2NrIH0gZnJvbSBcIi4vd29ya3NwYWNlLWhvc3QtY3JlZGVudGlhbC1kZWxpdmVyeVwiO1xuaW1wb3J0IHsgV09SS1NQQUNFX0hPU1RfT01QX0xPQ0FMX01PREVMIH0gZnJvbSBcIi4vd29ya3NwYWNlLWhvc3QtYWdlbnQtYXV0aGVudGljYXRpb25cIjtcblxuLyoqIFRoZSBzZWFsZWQgbWF0ZXJpYWwgZm9ybWF0IGluc3RhbGxlZCBpbnRvIG9uZSB3b3Jrc3BhY2UgdXNlcidzIG5hdGl2ZSBhZ2VudCBob21lcy4gKi9cbmV4cG9ydCBjb25zdCBXT1JLU1BBQ0VfSE9TVF9BR0VOVF9IT01FX0JVTkRMRV9WRVJTSU9OID1cbiAgXCJwYXBlcmN1c3Atd29ya3NwYWNlLWhvc3QtYWdlbnQtaG9tZS1idW5kbGUtdjNcIjtcblxuLyoqIFJlYWQgY29tcGF0aWJpbGl0eSBmb3IgdGhlIG11dGFibGUgQ29kZXggT0F1dGgtY2FjaGUgZm9ybWF0IHN1cGVyc2VkZWQgYnkgRC0zMTEuICovXG5leHBvcnQgY29uc3QgV09SS1NQQUNFX0hPU1RfQUdFTlRfSE9NRV9NVVRBQkxFX0NBQ0hFX0JVTkRMRV9WRVJTSU9OID1cbiAgXCJwYXBlcmN1c3Atd29ya3NwYWNlLWhvc3QtYWdlbnQtaG9tZS1idW5kbGUtdjJcIjtcblxuLyoqIFJlYWQgY29tcGF0aWJpbGl0eSBmb3IgbWF0ZXJpYWwgc2VhbGVkIGJlZm9yZSBsb2NhbC1pbmZlcmVuY2UgT01QIHdhcyBzdXBwb3J0ZWQgKEQtMjMwKS4gKi9cbmV4cG9ydCBjb25zdCBXT1JLU1BBQ0VfSE9TVF9BR0VOVF9IT01FX0xFR0FDWV9CVU5ETEVfVkVSU0lPTiA9XG4gIFwicGFwZXJjdXNwLXdvcmtzcGFjZS1ob3N0LWFnZW50LWhvbWUtYnVuZGxlLXYxXCI7XG5cbmV4cG9ydCBjb25zdCBXT1JLU1BBQ0VfSE9TVF9BR0VOVF9IT01FX0ZJTEVTID0ge1xuICBjbGF1ZGU6IFtcIi5jbGF1ZGVcIiwgXCIuY3JlZGVudGlhbHMuanNvblwiXSxcbiAgY29kZXg6IFtcIi5jb2RleFwiLCBcImF1dGguanNvblwiXSxcbiAgb21wOiBbXCIub21wXCIsIFwiYWdlbnRcIiwgXCJhdXRoLmpzb25cIl0sXG59IGFzIGNvbnN0O1xuXG4vKipcbiAqIE9NUCdzIHVzZXItbGV2ZWwgbW9kZWwgcmVnaXN0cnkgaXMgc2VwYXJhdGUgZnJvbSBpdHMgY3JlZGVudGlhbCBmaWxlLiAgS2VlcCB0aGUgcmVsYXRpdmUgcGF0aFxuICogaGVyZSwgbmV4dCB0byB0aGUgbmF0aXZlLWhvbWUgbGF5b3V0LCBzbyB0aGUgYmluZCBhbmQgcHJvYmUgY2Fubm90IHNpbGVudGx5IGRpc2FncmVlIGFib3V0XG4gKiB3aGVyZSBhIGxvY2FsIHByb3ZpZGVyIGlzIHdyaXR0ZW4uICBUaGlzIGZpbGUgY29udGFpbnMgbm8gY3JlZGVudGlhbHM7IGl0IG9ubHkgcG9pbnRzIE9NUCBhdFxuICogdGhlIGhvc3QncyBsb29wYmFjayBPbGxhbWEgQVBJIGFuZCBlbmFibGVzIGl0cyBtb2RlbCBkaXNjb3ZlcnkgcHJvdG9jb2wuXG4gKi9cbmV4cG9ydCBjb25zdCBXT1JLU1BBQ0VfSE9TVF9BR0VOVF9IT01FX09NUF9NT0RFTFNfUkVMQVRJVkVfUEFUSCA9XG4gIFwiLm9tcC9hZ2VudC9tb2RlbHMueW1sXCI7XG5cbi8qKiBUaGUgZGlyZWN0LCBsb29wYmFjay1vbmx5IE9sbGFtYSBlbmRwb2ludCBpbnN0YWxsZWQgYnkgdGhlIGhvc3QgYm9vdHN0cmFwLiAqL1xuZXhwb3J0IGNvbnN0IFdPUktTUEFDRV9IT1NUX0FHRU5UX0hPTUVfT0xMQU1BX0JBU0VfVVJMID1cbiAgXCJodHRwOi8vMTI3LjAuMC4xOjExNDM0L3YxXCI7XG5cbi8qKlxuICogT01QIG1vZGVscy55bWwgZm9yIGEgY3JlZGVudGlhbC1mcmVlIGFnZW50IGJ1bmRsZS4gIERvIG5vdCBhZGQgYW4gQVBJIGtleSBoZXJlOiBgYXV0aDogbm9uZWBcbiAqIGtlZXBzIHRoZSBPTVAgY3JlZGVudGlhbCBjb250cmFjdCBob25lc3QuICBLZWVwIGJvdGggZGlzY292ZXJ5IGFuZCB0aGUgb25lIHBpbm5lZCBsb2NhbCBtb2RlbDpcbiAqIGRpc2NvdmVyeSByZWZyZXNoZXMgYSBob3N0IHdob3NlIG1vZGVsIHNldCBjaGFuZ2VzLCB3aGlsZSB0aGUgZXhwbGljaXQgZW50cnkgbWFrZXMgYSBjb2xkIGFnZW50XG4gKiBob21lIHVzYWJsZSBiZWZvcmUgT01QIGhhcyBjcmVhdGVkIGl0cyBtb2RlbCBjYXRhbG9nICh0aGUgcmVhZGluZXNzIHByb2JlIGlzIHRoZSBmaXJzdCBPTVAgY2FsbFxuICogb24gYSBmcmVzaGx5IHByb3Zpc2lvbmVkIGhvc3QgYW5kIGNhbm5vdCBhc3N1bWUgYG9tcCBtb2RlbHNgIHJhbiBmaXJzdCkuXG4gKi9cbmV4cG9ydCBjb25zdCBXT1JLU1BBQ0VfSE9TVF9BR0VOVF9IT01FX09NUF9MT0NBTF9NT0RFTFNfWU1MID0gW1xuICBcInByb3ZpZGVyczpcIixcbiAgXCIgIG9sbGFtYTpcIixcbiAgYCAgICBiYXNlVXJsOiAke1dPUktTUEFDRV9IT1NUX0FHRU5UX0hPTUVfT0xMQU1BX0JBU0VfVVJMfWAsXG4gIFwiICAgIGFwaTogb3BlbmFpLWNvbXBsZXRpb25zXCIsXG4gIFwiICAgIGF1dGg6IG5vbmVcIixcbiAgXCIgICAgZGlzY292ZXJ5OlwiLFxuICBcIiAgICAgIHR5cGU6IG9sbGFtYVwiLFxuICBcIiAgICBtb2RlbHM6XCIsXG4gIGAgICAgICAtIGlkOiAke1dPUktTUEFDRV9IT1NUX09NUF9MT0NBTF9NT0RFTH1gLFxuICBgICAgICAgICBuYW1lOiAke1dPUktTUEFDRV9IT1NUX09NUF9MT0NBTF9NT0RFTH1gLFxuICBcIiAgICAgICAgYXBpOiBvcGVuYWktY29tcGxldGlvbnNcIixcbiAgXCIgICAgICAgIGlucHV0OlwiLFxuICBcIiAgICAgICAgICAtIHRleHRcIixcbiAgXCJcIixcbl0uam9pbihcIlxcblwiKTtcblxuZXhwb3J0IGNvbnN0IFdPUktTUEFDRV9IT1NUX0FHRU5UX0hPTUVfU1RBVEVfVkVSU0lPTiA9XG4gIFwicGFwZXJjdXNwLXdvcmtzcGFjZS1ob3N0LWFnZW50LWhvbWUtc3RhdGUtdjFcIjtcblxuZXhwb3J0IGNvbnN0IFdPUktTUEFDRV9IT1NUX0FHRU5UX0hPTUVfRkFNSUxJRVMgPSBbXG4gIFwiYWdlbnQtZm9yd2FyZGVkLXJlZmVyZW5jZVwiLFxuICBcImFnZW50LWVuY3J5cHRlZC1yZWZlcmVuY2VcIixcbl0gYXMgY29uc3Q7XG5leHBvcnQgdHlwZSBXb3Jrc3BhY2VIb3N0QWdlbnRIb21lRmFtaWx5ID1cbiAgKHR5cGVvZiBXT1JLU1BBQ0VfSE9TVF9BR0VOVF9IT01FX0ZBTUlMSUVTKVtudW1iZXJdO1xuXG5leHBvcnQgdHlwZSBXb3Jrc3BhY2VIb3N0QWdlbnRIb21lRmlsZSA9XG4gIGtleW9mIHR5cGVvZiBXT1JLU1BBQ0VfSE9TVF9BR0VOVF9IT01FX0ZJTEVTO1xuXG5leHBvcnQgaW50ZXJmYWNlIFdvcmtzcGFjZUhvc3RBZ2VudEhvbWVCdW5kbGVGaWxlcyB7XG4gIHJlYWRvbmx5IGNsYXVkZTogQnVmZmVyO1xuICByZWFkb25seSBjb2RleDogQnVmZmVyO1xuICAvKipcbiAgICogYG51bGxgIG1lYW5zIE9NUCBpcyBpbnRlbnRpb25hbGx5IGNyZWRlbnRpYWwtZnJlZSBhbmQgbXVzdCBwcm92ZSByZWFkaW5lc3MgYnkgbG9jYWwgaW5mZXJlbmNlLlxuICAgKiBJdCBpcyBub3QgZW5jb2RlZCBhcyBge31gIGJlY2F1c2UgY3JlYXRpbmcgYSBwbGF1c2libGUtbG9va2luZyBhdXRoIGZpbGUgd291bGQgdHVybiBhYnNlbmNlIG9mXG4gICAqIGNyZWRlbnRpYWxzIGludG8gZmFicmljYXRlZCBhdXRoZW50aWNhdGlvbiBzdGF0ZS5cbiAgICovXG4gIHJlYWRvbmx5IG9tcDogQnVmZmVyIHwgbnVsbDtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBXb3Jrc3BhY2VIb3N0QWdlbnRIb21lQnVuZGxlIHtcbiAgcmVhZG9ubHkgY29udHJhY3RWZXJzaW9uOlxuICAgIHwgdHlwZW9mIFdPUktTUEFDRV9IT1NUX0FHRU5UX0hPTUVfQlVORExFX1ZFUlNJT05cbiAgICB8IHR5cGVvZiBXT1JLU1BBQ0VfSE9TVF9BR0VOVF9IT01FX01VVEFCTEVfQ0FDSEVfQlVORExFX1ZFUlNJT05cbiAgICB8IHR5cGVvZiBXT1JLU1BBQ0VfSE9TVF9BR0VOVF9IT01FX0xFR0FDWV9CVU5ETEVfVkVSU0lPTjtcbiAgcmVhZG9ubHkgZmlsZXM6IFdvcmtzcGFjZUhvc3RBZ2VudEhvbWVCdW5kbGVGaWxlcztcbn1cblxuLyoqIFB1YmxpYywgc2VjcmV0LWZyZWUgcmVjb3JkIG9mIHdoaWNoIGRlbGl2ZXJlZCBnZW5lcmF0aW9uIGN1cnJlbnRseSBiYWNrcyB0aGUgbmF0aXZlIGhvbWVzLiAqL1xuZXhwb3J0IGludGVyZmFjZSBXb3Jrc3BhY2VIb3N0QWdlbnRIb21lU3RhdGUge1xuICByZWFkb25seSBjb250cmFjdFZlcnNpb246IHR5cGVvZiBXT1JLU1BBQ0VfSE9TVF9BR0VOVF9IT01FX1NUQVRFX1ZFUlNJT047XG4gIHJlYWRvbmx5IGZhbWlseTogV29ya3NwYWNlSG9zdEFnZW50SG9tZUZhbWlseTtcbiAgcmVhZG9ubHkgZ2VuZXJhdGlvbjogbnVtYmVyO1xuICByZWFkb25seSBob21lOiBzdHJpbmc7XG4gIHJlYWRvbmx5IGZpbGVzOiBSZWFkb25seTxSZWNvcmQ8V29ya3NwYWNlSG9zdEFnZW50SG9tZUZpbGUsIHN0cmluZz4+O1xufVxuXG4vKiogTWluaW1hbCBob3N0IGZpbGVzeXN0ZW0gc2VhbSBzaGFyZWQgYnkgdGhlIGFnZW50LWhvbWUgY29uc3VtZXIgYW5kIHByb2R1Y3Rpb24gaG9zdCBhZGFwdGVyLiAqL1xuZXhwb3J0IGludGVyZmFjZSBXb3Jrc3BhY2VIb3N0QWdlbnRIb21lRmlsZXN5c3RlbSB7XG4gIGVuc3VyZURpcmVjdG9yeShwYXRoOiBzdHJpbmcpOiBQcm9taXNlPHZvaWQ+O1xuICB3cml0ZVByaXZhdGVGaWxlKHBhdGg6IHN0cmluZywgYnl0ZXM6IEJ1ZmZlcik6IFByb21pc2U8dm9pZD47XG4gIHJlYWRGaWxlSWZQcmVzZW50KHBhdGg6IHN0cmluZyk6IFByb21pc2U8QnVmZmVyIHwgbnVsbD47XG4gIHJlbW92ZVBhdGgocGF0aDogc3RyaW5nKTogUHJvbWlzZTx2b2lkPjtcbiAgcGF0aEV4aXN0cyhwYXRoOiBzdHJpbmcpOiBQcm9taXNlPGJvb2xlYW4+O1xuICAvKiogT3B0aW9uYWwgYmVjYXVzZSBoZXJtZXRpYyBkb3VibGVzIG5lZWQgbm90IG1vZGVsIHVpZC9naWQ7IHByb2R1Y3Rpb24gcHJvdmlkZXMgaXQuICovXG4gIHNldE93bmVyc2hpcD8ocGF0aDogc3RyaW5nLCBvd25lcjogc3RyaW5nLCBncm91cDogc3RyaW5nKTogUHJvbWlzZTx2b2lkPjtcbiAgLyoqIFJldHVybiB0aGUgbHN0YXQga2luZCB3aXRob3V0IGZvbGxvd2luZyBzeW1saW5rczsgcHJvZHVjdGlvbiB1c2VzIHRoaXMgdG8gcmVqZWN0IHJlZGlyZWN0aW9uLiAqL1xuICBwYXRoS2luZD8oXG4gICAgcGF0aDogc3RyaW5nLFxuICApOiBQcm9taXNlPFwibWlzc2luZ1wiIHwgXCJkaXJlY3RvcnlcIiB8IFwiZmlsZVwiIHwgXCJzeW1saW5rXCIgfCBcIm90aGVyXCI+O1xuICAvKiogT3B0aW9uYWwgY3Jvc3MtcHJvY2VzcyBjcml0aWNhbCBzZWN0aW9uIHNoYXJlZCB3aXRoIGNyZWRlbnRpYWwgZGVsaXZlcnkuICovXG4gIHdpdGhFeGNsdXNpdmVMb2NrPzxUPihwYXRoOiBzdHJpbmcsIHRhc2s6ICgpID0+IFByb21pc2U8VD4pOiBQcm9taXNlPFQ+O1xufVxuXG5leHBvcnQgY2xhc3MgV29ya3NwYWNlSG9zdEFnZW50SG9tZVN0YXRlRXJyb3IgZXh0ZW5kcyBFcnJvciB7XG4gIHJlYWRvbmx5IGZhbWlseT86IFdvcmtzcGFjZUhvc3RBZ2VudEhvbWVGYW1pbHk7XG4gIHJlYWRvbmx5IGdlbmVyYXRpb24/OiBudW1iZXI7XG5cbiAgY29uc3RydWN0b3IoXG4gICAgbWVzc2FnZTogc3RyaW5nLFxuICAgIGRldGFpbHM6IHtcbiAgICAgIGZhbWlseT86IFdvcmtzcGFjZUhvc3RBZ2VudEhvbWVGYW1pbHk7XG4gICAgICBnZW5lcmF0aW9uPzogbnVtYmVyO1xuICAgIH0gPSB7fSxcbiAgKSB7XG4gICAgc3VwZXIobWVzc2FnZSk7XG4gICAgdGhpcy5uYW1lID0gXCJXb3Jrc3BhY2VIb3N0QWdlbnRIb21lU3RhdGVFcnJvclwiO1xuICAgIHRoaXMuZmFtaWx5ID0gZGV0YWlscy5mYW1pbHk7XG4gICAgdGhpcy5nZW5lcmF0aW9uID0gZGV0YWlscy5nZW5lcmF0aW9uO1xuICB9XG59XG5cbmV4cG9ydCBjbGFzcyBXb3Jrc3BhY2VIb3N0QWdlbnRIb21lQnVuZGxlRXJyb3IgZXh0ZW5kcyBFcnJvciB7XG4gIGNvbnN0cnVjdG9yKG1lc3NhZ2U6IHN0cmluZykge1xuICAgIHN1cGVyKG1lc3NhZ2UpO1xuICAgIHRoaXMubmFtZSA9IFwiV29ya3NwYWNlSG9zdEFnZW50SG9tZUJ1bmRsZUVycm9yXCI7XG4gIH1cbn1cblxuZnVuY3Rpb24gcmVjb3JkKFxuICB2YWx1ZTogdW5rbm93bixcbiAgbGFiZWw6IHN0cmluZyxcbik6IFJlYWRvbmx5PFJlY29yZDxzdHJpbmcsIHVua25vd24+PiB7XG4gIGlmICghdmFsdWUgfHwgdHlwZW9mIHZhbHVlICE9PSBcIm9iamVjdFwiIHx8IEFycmF5LmlzQXJyYXkodmFsdWUpKSB7XG4gICAgdGhyb3cgbmV3IFdvcmtzcGFjZUhvc3RBZ2VudEhvbWVCdW5kbGVFcnJvcihgJHtsYWJlbH0gbXVzdCBiZSBhbiBvYmplY3RgKTtcbiAgfVxuICByZXR1cm4gdmFsdWUgYXMgUmVhZG9ubHk8UmVjb3JkPHN0cmluZywgdW5rbm93bj4+O1xufVxuXG5mdW5jdGlvbiBleGFjdEtleXMoXG4gIHZhbHVlOiBSZWFkb25seTxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4sXG4gIGV4cGVjdGVkOiByZWFkb25seSBzdHJpbmdbXSxcbiAgbGFiZWw6IHN0cmluZyxcbik6IHZvaWQge1xuICBjb25zdCBhY3R1YWwgPSBPYmplY3Qua2V5cyh2YWx1ZSkuc29ydCgpO1xuICBjb25zdCB3YW50ZWQgPSBbLi4uZXhwZWN0ZWRdLnNvcnQoKTtcbiAgaWYgKFxuICAgIGFjdHVhbC5sZW5ndGggIT09IHdhbnRlZC5sZW5ndGggfHxcbiAgICBhY3R1YWwuc29tZSgoa2V5LCBpbmRleCkgPT4ga2V5ICE9PSB3YW50ZWRbaW5kZXhdKVxuICApIHtcbiAgICB0aHJvdyBuZXcgV29ya3NwYWNlSG9zdEFnZW50SG9tZUJ1bmRsZUVycm9yKFxuICAgICAgYCR7bGFiZWx9IG11c3QgY29udGFpbiBleGFjdGx5ICR7d2FudGVkLmpvaW4oXCIsIFwiKX1gLFxuICAgICk7XG4gIH1cbn1cblxuZnVuY3Rpb24gZGVjb2RlSnNvbkZpbGUoXG4gIHZhbHVlOiB1bmtub3duLFxuICBsYWJlbDogV29ya3NwYWNlSG9zdEFnZW50SG9tZUZpbGUsXG4pOiBCdWZmZXIge1xuICBpZiAodHlwZW9mIHZhbHVlICE9PSBcInN0cmluZ1wiIHx8IHZhbHVlLmxlbmd0aCA9PT0gMCkge1xuICAgIHRocm93IG5ldyBXb3Jrc3BhY2VIb3N0QWdlbnRIb21lQnVuZGxlRXJyb3IoXG4gICAgICBgZmlsZXMuJHtsYWJlbH0gbXVzdCBiZSBjYW5vbmljYWwgYmFzZTY0YCxcbiAgICApO1xuICB9XG4gIGNvbnN0IGJ5dGVzID0gQnVmZmVyLmZyb20odmFsdWUsIFwiYmFzZTY0XCIpO1xuICBpZiAoYnl0ZXMubGVuZ3RoID09PSAwIHx8IGJ5dGVzLnRvU3RyaW5nKFwiYmFzZTY0XCIpICE9PSB2YWx1ZSkge1xuICAgIHRocm93IG5ldyBXb3Jrc3BhY2VIb3N0QWdlbnRIb21lQnVuZGxlRXJyb3IoXG4gICAgICBgZmlsZXMuJHtsYWJlbH0gbXVzdCBiZSBjYW5vbmljYWwgYmFzZTY0YCxcbiAgICApO1xuICB9XG4gIGxldCBwYXJzZWQ6IHVua25vd247XG4gIHRyeSB7XG4gICAgcGFyc2VkID0gSlNPTi5wYXJzZShieXRlcy50b1N0cmluZyhcInV0ZjhcIikpO1xuICB9IGNhdGNoIHtcbiAgICB0aHJvdyBuZXcgV29ya3NwYWNlSG9zdEFnZW50SG9tZUJ1bmRsZUVycm9yKFxuICAgICAgYGZpbGVzLiR7bGFiZWx9IG11c3QgZGVjb2RlIHRvIHZhbGlkIEpTT05gLFxuICAgICk7XG4gIH1cbiAgcmVjb3JkKHBhcnNlZCwgYGZpbGVzLiR7bGFiZWx9IEpTT05gKTtcbiAgcmV0dXJuIGJ5dGVzO1xufVxuXG5mdW5jdGlvbiBwYXJzZUpzb25PYmplY3RCeXRlcyhcbiAgYnl0ZXM6IEJ1ZmZlcixcbiAgbGFiZWw6IHN0cmluZyxcbik6IFJlYWRvbmx5PFJlY29yZDxzdHJpbmcsIHVua25vd24+PiB7XG4gIGxldCBwYXJzZWQ6IHVua25vd247XG4gIHRyeSB7XG4gICAgcGFyc2VkID0gSlNPTi5wYXJzZShieXRlcy50b1N0cmluZyhcInV0ZjhcIikpO1xuICB9IGNhdGNoIHtcbiAgICB0aHJvdyBuZXcgV29ya3NwYWNlSG9zdEFnZW50SG9tZUJ1bmRsZUVycm9yKGAke2xhYmVsfSBtdXN0IGJlIHZhbGlkIEpTT05gKTtcbiAgfVxuICByZXR1cm4gcmVjb3JkKHBhcnNlZCwgbGFiZWwpO1xufVxuXG4vKipcbiAqIFRoZSBDb2RleCBDTEkncyBgYXV0aC5qc29uYCBkZXNlcmlhbGl6ZXIgUkVRVUlSRVMgYHRva2Vucy5yZWZyZXNoX3Rva2VuYCBhbmQgYHRva2Vucy5pZF90b2tlbmBcbiAqIHRvIGJlIHByZXNlbnQgKHNlcmRlIGBtaXNzaW5nIGZpZWxkYCBvdGhlcndpc2UpLiBNRUFTVVJFRCAyMDI2LTA5LTExIG9uIGNvZGV4LWNsaSAwLjE1NC4wICh0aGVcbiAqIEc2IGZhaWx1cmUgcmFuIDAuMTUzLjQpOiBhIG1lbWJlciB3aG9zZSBgcmVmcmVzaF90b2tlbmAgS0VZIHdhcyBkZWxldGVkIG1ha2VzIGBjb2RleCBsb2dpblxuICogc3RhdHVzYCBleGl0IDEgd2l0aCBgbWlzc2luZyBmaWVsZCBcXGByZWZyZXNoX3Rva2VuXFxgYCBhbmQgYGNvZGV4IGV4ZWNgIHNlbmQgbm8gYmVhcmVyIGF0IGFsbFxuICogKEhUVFAgNDAxKSDigJQgc28gZXZlcnkgcHJvamVjdGlvbiB0aGF0IERFTEVURUQgdGhlIGtleSB3YXMgdW5hdXRoZW50aWNhdGFibGUgYnkgY29uc3RydWN0aW9uLFxuICogYW5kIGFkbWlzc2lvbiByZWNvcmRlZCBvbmx5IHRoZSBnZW5lcmljIGBub24temVyby1leGl0YC4gVGhlIHNhbWUgZmlsZSB3aXRoIGByZWZyZXNoX3Rva2VuOiBcIlwiYFxuICogcGFyc2VzIGFuZCBhdXRoZW50aWNhdGVzLiBUaGUgcmVmcmVzaCBjcmVkZW50aWFsIGlzIHRoZXJlZm9yZSBORVVUUkFMSVpFRCAoZW1wdHkgc3RyaW5nKSwgbmV2ZXJcbiAqIHJlbW92ZWQ6IHRoZSBrZXkgdGhlIENMSSBuZWVkcyBzdGF5cywgYW5kIG5vIHJvdGF0aW5nIHJlZnJlc2ggc2VjcmV0IGNhbiBjcm9zcyAoRC0zMTEpLlxuICovXG5leHBvcnQgY29uc3QgV09SS1NQQUNFX0hPU1RfQ09ERVhfTkVVVFJBTElaRURfUkVGUkVTSF9UT0tFTiA9IFwiXCI7XG5cbi8qKlxuICogVGhlIG5ldXRyYWwgdmFsdWUgZm9yIGBjbGF1ZGVBaU9hdXRoLnJlZnJlc2hUb2tlbmAgKFdJLTEwMDAxNjkxKS5cbiAqXG4gKiBNRUFTVVJFRCAyMDI2LTA5LTE2IG9uIHRoaXMgYm94LCB0d28gYXJtcyB3aXRoIGEgZGlzY3JpbWluYXRpbmcgbmVnYXRpdmUgY29udHJvbCwgYmVjYXVzZSB0aGVcbiAqIHdob2xlIHBvaW50IGlzIHRoYXQgYSBwcm9qZWN0aW9uIGlzIG9ubHkgc2FmZSBpZiB0aGUgQ0xJIHN0aWxsIGF1dGhlbnRpY2F0ZXMgYWZ0ZXJ3YXJkczpcbiAqICAgYXJtIDEgKG5lZ2F0aXZlIGNvbnRyb2wpOiB0aGUgc2FtZSBmaWxlIHNoYXBlIHdpdGggYW4gSU5WQUxJRCBhY2Nlc3MgdG9rZW4gYW5kXG4gKiAgICAgICAgICBgcmVmcmVzaFRva2VuOiBcIlwiYCAtPiBgY2xhdWRlIC1wYCBleGl0cyAxLCBgQVBJIEVycm9yOiA0MDEgSW52YWxpZCBiZWFyZXIgdG9rZW5gLlxuICogICBhcm0gMjogdGhlIFJFQUwgYWNjZXNzIHRva2VuIHdpdGggYHJlZnJlc2hUb2tlbjogXCJcImAgLT4gZXhpdHMgMCBhbmQgcmV0dXJucyBpdHMgbWFya2VyLlxuICogQXJtIDEgaXMgd2hhdCBtYWtlcyBhcm0gMiBtZWFuIGFueXRoaW5nOiB0aGlzIHJlcG8ncyBzZXNzaW9ucyBmcmVxdWVudGx5IGNhcnJ5XG4gKiBgQU5USFJPUElDX0FVVEhfVE9LRU5gIGZvciBnYXRld2F5IHJvdXRpbmcsIGFuZCBpZiB0aGUgQ0xJIGhhZCBiZWVuIGFuc3dlcmluZyBmcm9tIGFtYmllbnQgZW52XG4gKiBhdXRoIHJhdGhlciB0aGFuIGBDTEFVREVfQ09ORklHX0RJUmAsIGFybSAyIHdvdWxkIGhhdmUgcGFzc2VkIG9uIGFueSBieXRlcyB3aGF0c29ldmVyLlxuICpcbiAqIOKaoCBTRVBBUkFURSBDT05TVEFOVCBGUk9NIFRIRSBDT0RFWCBPTkUgT04gUFVSUE9TRSwgZGVzcGl0ZSBib3RoIGJlaW5nIGBcIlwiYCB0b2RheS4gRWFjaCBpcyBhXG4gKiBtZWFzdXJlZCBmYWN0IGFib3V0IGEgRElGRkVSRU5UIGRlc2VyaWFsaXplcjsgc2hhcmluZyBvbmUgc3ltYm9sIHdvdWxkIG1lYW4gYSBmdXR1cmUgbWVhc3VyZW1lbnRcbiAqIGFnYWluc3Qgb25lIENMSSBzaWxlbnRseSByZWRlZmluZWQgdGhlIHByb2plY3Rpb24gc2hpcHBlZCB0byB0aGUgb3RoZXIuXG4gKlxuICog4pqgIFRoZSBmaWVsZCBpcyBFTUlUVEVELUFORC1FTVBUWSByYXRoZXIgdGhhbiBhYnNlbnQsIGFuZCB0aGUgaG9uZXN0IHJlYXNvbiBpcyB0aGF0IGFic2VudCBpc1xuICogVU5NRUFTVVJFRCBoZXJlLiBDb2RleCBoYXMgYSBtZWFzdXJlZCBgbWlzc2luZyBmaWVsZGAgZmFpbHVyZSBmb3IgdGhlIGRlbGV0ZWQta2V5IHNoYXBlIChELTMyMCk7XG4gKiBmb3IgY2xhdWRlIHdlIGtub3cgb25seSB0aGF0IHByZXNlbnQtYW5kLWVtcHR5IGF1dGhlbnRpY2F0ZXMuIFNvIHRoZSBwcm9qZWN0aW9uIGFsd2F5cyB3cml0ZXMgdGhlXG4gKiBzaGFwZSB0aGF0IHdhcyBkZW1vbnN0cmF0ZWQgdG8gd29yayBpbnN0ZWFkIG9mIHRoZSBvbmUgd2UgY291bGQgYXJndWUgb3VnaHQgdG8uXG4gKi9cbmV4cG9ydCBjb25zdCBXT1JLU1BBQ0VfSE9TVF9DTEFVREVfTkVVVFJBTElaRURfUkVGUkVTSF9UT0tFTiA9IFwiXCI7XG5cbi8qKiBLZXkgY29tcGFyaXNvbiBpcyBzaGFwZS1iYXNlZCwgc28gYHJlZnJlc2gtdG9rZW5gLCBgcmVmcmVzaF90b2tlbmAgYW5kIGByZWZyZXNoVG9rZW5gIGFsbCBtYXRjaC4gKi9cbmZ1bmN0aW9uIG5vcm1hbGl6ZWRLZXkoa2V5OiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4ga2V5LnJlcGxhY2UoL1tfLV0vZywgXCJcIikudG9Mb3dlckNhc2UoKTtcbn1cblxuLyoqXG4gKiBSZWN1cnNpdmVseSBjb2xsZWN0IHRoZSBwYXRocyBvZiBldmVyeSBrZXkgdGhlIHByZWRpY2F0ZSBuYW1lcy5cbiAqXG4gKiBHZW5lcmFsaXplZCBmcm9tIHRoZSBvcmlnaW5hbCByZWZyZXNoLXRva2VuLW9ubHkgd2Fsa2VyIHNvIGEgc2Vjb25kIGNyZWRlbnRpYWwgU0hBUEUgY2FuIHJldXNlXG4gKiB0aGUgaWRlbnRpY2FsIHRyYXZlcnNhbCAoV0ktMTAwMDE2ODgpLiBUaGUgdHJhdmVyc2FsIGlzIHRoZSBwYXJ0IHRoYXQgbWF0dGVycyDigJQgYSBrZXkgYXQgYW55XG4gKiBkZXB0aCwgaW5jbHVkaW5nIGluc2lkZSBhbiBhcnJheSwgaXMgZm91bmQg4oCUIGFuZCBkdXBsaWNhdGluZyBpdCBmb3IgZWFjaCBuZXcgc2hhcGUgaXMgaG93IG9uZVxuICogY29weSBlbmRzIHVwIHNoYWxsb3dlciB0aGFuIHRoZSBvdGhlci5cbiAqL1xuZnVuY3Rpb24gY3JlZGVudGlhbEtleVBhdGhzKFxuICB2YWx1ZTogdW5rbm93bixcbiAgbWF0Y2hlczogKG5vcm1hbGl6ZWQ6IHN0cmluZykgPT4gYm9vbGVhbixcbiAgcGF0aDogcmVhZG9ubHkgc3RyaW5nW10gPSBbXSxcbik6IHN0cmluZ1tdIHtcbiAgaWYgKEFycmF5LmlzQXJyYXkodmFsdWUpKSB7XG4gICAgcmV0dXJuIHZhbHVlLmZsYXRNYXAoKG5lc3RlZCwgaW5kZXgpID0+XG4gICAgICBjcmVkZW50aWFsS2V5UGF0aHMobmVzdGVkLCBtYXRjaGVzLCBbLi4ucGF0aCwgU3RyaW5nKGluZGV4KV0pLFxuICAgICk7XG4gIH1cbiAgaWYgKCF2YWx1ZSB8fCB0eXBlb2YgdmFsdWUgIT09IFwib2JqZWN0XCIpIHJldHVybiBbXTtcbiAgcmV0dXJuIE9iamVjdC5lbnRyaWVzKHZhbHVlKS5mbGF0TWFwKChba2V5LCBuZXN0ZWRdKSA9PiB7XG4gICAgY29uc3QgaGVyZSA9IFsuLi5wYXRoLCBrZXldO1xuICAgIGNvbnN0IG5hbWVkID0gbWF0Y2hlcyhub3JtYWxpemVkS2V5KGtleSkpID8gW2hlcmUuam9pbihcIi5cIildIDogW107XG4gICAgcmV0dXJuIFsuLi5uYW1lZCwgLi4uY3JlZGVudGlhbEtleVBhdGhzKG5lc3RlZCwgbWF0Y2hlcywgaGVyZSldO1xuICB9KTtcbn1cblxuZnVuY3Rpb24gcmVmcmVzaFRva2VuS2V5UGF0aHModmFsdWU6IHVua25vd24sIHBhdGg6IHJlYWRvbmx5IHN0cmluZ1tdID0gW10pOiBzdHJpbmdbXSB7XG4gIHJldHVybiBjcmVkZW50aWFsS2V5UGF0aHModmFsdWUsIChrZXkpID0+IGtleSA9PT0gXCJyZWZyZXNodG9rZW5cIiwgcGF0aCk7XG59XG5cbi8qKlxuICogQVBJLWtleS1zaGFwZWQga2V5cywgd2hpY2ggYSByZWFsIGB+Ly5jb2RleC9hdXRoLmpzb25gIGNhcnJpZXMgYXQgdG9wIGxldmVsIGFzIGBPUEVOQUlfQVBJX0tFWWAuXG4gKlxuICogV0hZIFRISVMgRVhJU1RTIEFMT05HU0lERSBUSEUgUkVGUkVTSC1UT0tFTiBTQ0FOTkVSIChXSS0xMDAwMTY4OCkuIFRoZSBwcm9qZWN0aW9uIGh1bnRlZFxuICogcmVmcmVzaC10b2tlbi1zaGFwZWQga2V5cyBleGhhdXN0aXZlbHkgd2hpbGUgc3ByZWFkaW5nIGB7IC4uLmJvZHkgfWAsIHNvIGEgcmF3IEFQSSBrZXkgcm9kZVxuICogdGhyb3VnaCB1bnRvdWNoZWQg4oCUIGFuZCBhbiBBUEkga2V5IGlzIFNUUklDVExZIE1PUkUgcG93ZXJmdWwgdGhhbiB0aGUgcmVmcmVzaCB0b2tlbiB0aGUgaHVudFxuICogZXhpc3RzIHRvIHN0cmlwOiBhIHJlZnJlc2ggdG9rZW4gbWludHMgYWNjZXNzIGZvciBvbmUgYWNjb3VudCBzZXNzaW9uLCB3aGVyZWFzIGBPUEVOQUlfQVBJX0tFWWBcbiAqIGlzIGEgZGlyZWN0LCBsb25nLWxpdmVkLCBpbmRlcGVuZGVudGx5LWJpbGxhYmxlIGNyZWRlbnRpYWwgdGhhdCBubyBnZW5lcmF0aW9uIHJldm9jYXRpb25cbiAqIChgcGMtYWdlbnQtcmV2b2NhdGlvbmApIGNhbiByZWFjaC4gTWF0Y2hpbmcgb24gbmFtZSBTSEFQRSByYXRoZXIgdGhhbiBvbmUgbGl0ZXJhbCBrZWVwcyBhXG4gKiBwcm92aWRlci1wcmVmaXhlZCB2YXJpYW50IChgQU5USFJPUElDX0FQSV9LRVlgLCBgb3BlbmFpQXBpS2V5YCkgZnJvbSByZS1vcGVuaW5nIGl0LlxuICovXG5mdW5jdGlvbiBhcGlLZXlQYXRocyh2YWx1ZTogdW5rbm93biwgcGF0aDogcmVhZG9ubHkgc3RyaW5nW10gPSBbXSk6IHN0cmluZ1tdIHtcbiAgcmV0dXJuIGNyZWRlbnRpYWxLZXlQYXRocyhcbiAgICB2YWx1ZSxcbiAgICAoa2V5KSA9PiBrZXkuZW5kc1dpdGgoXCJhcGlrZXlcIikgfHwga2V5ID09PSBcInNlY3JldGtleVwiIHx8IGtleSA9PT0gXCJhcGlzZWNyZXRcIixcbiAgICBwYXRoLFxuICApO1xufVxuXG4vKipcbiAqIEFQSS1rZXktc2hhcGVkIGtleXMgc3RpbGwgY2FycnlpbmcgYSBMSVZFIHZhbHVlLlxuICpcbiAqIFRoZSBuZXV0cmFsaXplZCBzdGF0ZSBpcyBgbnVsbGAgKHNlZSBgbmV1dHJhbGl6ZUFwaUtleXNgKSwgc28gcHJlc2VuY2UgYWxvbmUgY2Fubm90IGJlIHRoZVxuICogYWRtaXNzaW9uIHByZWRpY2F0ZSDigJQgYSBjb3JyZWN0bHktcHJvamVjdGVkIGZpbGUgaGFzIHRoZSBrZXkgYW5kIG11c3QgcGFzcy4gQW4gZW1wdHkgc3RyaW5nXG4gKiBjb3VudHMgYXMgbmV1dHJhbCB0b286IGl0IGNhcnJpZXMgbm8gc2VjcmV0LCBhbmQgcmVmdXNpbmcgaXQgd291bGQgcmVqZWN0IGEgZmlsZSB0aGF0IGlzIGFscmVhZHlcbiAqIGhhcm1sZXNzLlxuICovXG5mdW5jdGlvbiBsaXZlQXBpS2V5UGF0aHModmFsdWU6IHVua25vd24sIHBhdGg6IHJlYWRvbmx5IHN0cmluZ1tdID0gW10pOiBzdHJpbmdbXSB7XG4gIGlmIChBcnJheS5pc0FycmF5KHZhbHVlKSkge1xuICAgIHJldHVybiB2YWx1ZS5mbGF0TWFwKChuZXN0ZWQsIGluZGV4KSA9PlxuICAgICAgbGl2ZUFwaUtleVBhdGhzKG5lc3RlZCwgWy4uLnBhdGgsIFN0cmluZyhpbmRleCldKSxcbiAgICApO1xuICB9XG4gIGlmICghdmFsdWUgfHwgdHlwZW9mIHZhbHVlICE9PSBcIm9iamVjdFwiKSByZXR1cm4gW107XG4gIHJldHVybiBPYmplY3QuZW50cmllcyh2YWx1ZSkuZmxhdE1hcCgoW2tleSwgbmVzdGVkXSkgPT4ge1xuICAgIGNvbnN0IGhlcmUgPSBbLi4ucGF0aCwga2V5XTtcbiAgICBjb25zdCBsaXZlID1cbiAgICAgIGFwaUtleVBhdGhzKHsgW2tleV06IG51bGwgfSkubGVuZ3RoID4gMCAmJiBuZXN0ZWQgIT09IG51bGwgJiYgbmVzdGVkICE9PSBcIlwiXG4gICAgICAgID8gW2hlcmUuam9pbihcIi5cIildXG4gICAgICAgIDogW107XG4gICAgcmV0dXJuIFsuLi5saXZlLCAuLi5saXZlQXBpS2V5UGF0aHMobmVzdGVkLCBoZXJlKV07XG4gIH0pO1xufVxuXG4vKipcbiAqIE5ldXRyYWxpemUgZXZlcnkgYXBpLWtleS1zaGFwZWQga2V5IGF0IGFueSBkZXB0aCwgUFJFU0VSVklORyB0aGUgZmllbGQuXG4gKlxuICog4pqgIE5FVVRSQUxJWkVEIElOIFBMQUNFLCBOT1QgREVMRVRFRCDigJQgYW5kIHRoZSBkaXN0aW5jdGlvbiBpcyBsb2FkLWJlYXJpbmcsIG5vdCBzdHlsaXN0aWMuXG4gKiBELTMyMCAoV0ktMTAwMDEwMTQvV0ktMTAwMDEwMTUpIGlzIHRoZSBtZWFzdXJlZCBwcmVjZWRlbnQ6IGFuIGVhcmxpZXIgcHJvamVjdGlvbiBERUxFVEVEXG4gKiBgdG9rZW5zLnJlZnJlc2hfdG9rZW5gLCBhbmQgY29kZXgtY2xpIHRoZW4gY291bGQgbm90IGRlc2VyaWFsaXplIGl0cyBvd24gYXV0aC5qc29uLCB3aGljaCBpcyB3aHlcbiAqIHRoYXQgZmllbGQgaXMgZW1wdGllZCByYXRoZXIgdGhhbiByZW1vdmVkIHRvZGF5LiBEZWxldGluZyBhbiBhcGkta2V5IGZpZWxkIHdvdWxkIGJlIHRoZSBzYW1lXG4gKiBiZXQgb24gdGhlIHNhbWUgZGVzZXJpYWxpemVyLlxuICpcbiAqIGBudWxsYCBhbmQgbm90IGBcIlwiYCBiZWNhdXNlIG51bGwgaXMgdGhlIHZhbHVlIGEgUkVBTCBDaGF0R1BULW1vZGUgYXV0aC5qc29uIGFscmVhZHkgY2Fycmllc1xuICogKGBPUEVOQUlfQVBJX0tFWTogbnVsbGAg4oCUIG9ic2VydmVkIGJvdGggaW4gdGhpcyByZXBvJ3MgY2Fub25pY2FsIGZpeHR1cmUgYW5kIGluIHRoZSBmaWVsZCwgY2ZcbiAqIEVJLTIxNTI2MzUwODUwNzMxODU3KS4gU28gdGhlIHByb2plY3RlZCBmaWxlIGlzIGJ5dGUtc2hhcGVkIGxpa2UgYW4gb3JkaW5hcnkgT0F1dGgtbW9kZSBsb2dpblxuICogcmF0aGVyIHRoYW4gbGlrZSBhIGZpbGUgc29tZW9uZSBlZGl0ZWQ6IHRoZSBuZXV0cmFsIHN0YXRlIGlzIG9uZSB0aGUgQ0xJIGRlbW9uc3RyYWJseSBhY2NlcHRzLFxuICogaW5zdGVhZCBvZiBvbmUgd2UgcmVhc29uZWQgaXQgb3VnaHQgdG8uXG4gKi9cbmZ1bmN0aW9uIG5ldXRyYWxpemVBcGlLZXlzKHZhbHVlOiB1bmtub3duKTogdW5rbm93biB7XG4gIGlmIChBcnJheS5pc0FycmF5KHZhbHVlKSkgcmV0dXJuIHZhbHVlLm1hcChuZXV0cmFsaXplQXBpS2V5cyk7XG4gIGlmICghdmFsdWUgfHwgdHlwZW9mIHZhbHVlICE9PSBcIm9iamVjdFwiKSByZXR1cm4gdmFsdWU7XG4gIHJldHVybiBPYmplY3QuZnJvbUVudHJpZXMoXG4gICAgT2JqZWN0LmVudHJpZXModmFsdWUpLm1hcCgoW2tleSwgbmVzdGVkXSkgPT4gW1xuICAgICAga2V5LFxuICAgICAgYXBpS2V5UGF0aHMoeyBba2V5XTogbnVsbCB9KS5sZW5ndGggPyBudWxsIDogbmV1dHJhbGl6ZUFwaUtleXMobmVzdGVkKSxcbiAgICBdKSxcbiAgKTtcbn1cblxuLyoqXG4gKiBSZWZyZXNoLXRva2VuLXNoYXBlZCBrZXlzIHN0aWxsIGNhcnJ5aW5nIGEgTElWRSB2YWx1ZSAoV0ktMTAwMDE2OTEpLlxuICpcbiAqIFRoZSBzaWJsaW5nIG9mIGBsaXZlQXBpS2V5UGF0aHNgLCBhbmQgZm9yIHRoZSBzYW1lIHJlYXNvbjogdGhlIG5ldXRyYWxpemVkIHN0YXRlIFBSRVNFUlZFUyB0aGVcbiAqIGZpZWxkLCBzbyBwcmVzZW5jZSBhbG9uZSBjYW5ub3QgYmUgdGhlIHByZWRpY2F0ZSDigJQgYSBjb3JyZWN0bHktcHJvamVjdGVkIGZpbGUgaGFzIHRoZSBrZXkgYW5kXG4gKiBtdXN0IHBhc3MuIE9ubHkgYSBub24tZW1wdHkgdmFsdWUgaXMgYSBmaW5kaW5nLlxuICovXG5mdW5jdGlvbiBsaXZlUmVmcmVzaFRva2VuUGF0aHMoXG4gIHZhbHVlOiB1bmtub3duLFxuICBwYXRoOiByZWFkb25seSBzdHJpbmdbXSA9IFtdLFxuKTogc3RyaW5nW10ge1xuICBpZiAoQXJyYXkuaXNBcnJheSh2YWx1ZSkpIHtcbiAgICByZXR1cm4gdmFsdWUuZmxhdE1hcCgobmVzdGVkLCBpbmRleCkgPT5cbiAgICAgIGxpdmVSZWZyZXNoVG9rZW5QYXRocyhuZXN0ZWQsIFsuLi5wYXRoLCBTdHJpbmcoaW5kZXgpXSksXG4gICAgKTtcbiAgfVxuICBpZiAoIXZhbHVlIHx8IHR5cGVvZiB2YWx1ZSAhPT0gXCJvYmplY3RcIikgcmV0dXJuIFtdO1xuICByZXR1cm4gT2JqZWN0LmVudHJpZXModmFsdWUpLmZsYXRNYXAoKFtrZXksIG5lc3RlZF0pID0+IHtcbiAgICBjb25zdCBoZXJlID0gWy4uLnBhdGgsIGtleV07XG4gICAgY29uc3QgbGl2ZSA9XG4gICAgICByZWZyZXNoVG9rZW5LZXlQYXRocyh7IFtrZXldOiBudWxsIH0pLmxlbmd0aCA+IDAgJiZcbiAgICAgIG5lc3RlZCAhPT0gbnVsbCAmJlxuICAgICAgbmVzdGVkICE9PSBcIlwiXG4gICAgICAgID8gW2hlcmUuam9pbihcIi5cIildXG4gICAgICAgIDogW107XG4gICAgcmV0dXJuIFsuLi5saXZlLCAuLi5saXZlUmVmcmVzaFRva2VuUGF0aHMobmVzdGVkLCBoZXJlKV07XG4gIH0pO1xufVxuXG4vKipcbiAqIE5ldXRyYWxpemUgZXZlcnkgcmVmcmVzaC10b2tlbi1zaGFwZWQga2V5IGF0IGFueSBkZXB0aCwgUFJFU0VSVklORyB0aGUgZmllbGQgKFdJLTEwMDAxNjkxKS5cbiAqXG4gKiBFeGhhdXN0aXZlIHJhdGhlciB0aGFuIHRhcmdldGVkIGF0IG9uZSBrbm93biBwYXRoLCB3aGljaCBpcyB0aGUgbGVzc29uIFdJLTEwMDAxNjg4IHBhaWQgZm9yOiB0aGVcbiAqIGNvZGV4IHByb2plY3Rpb24gc3ByZWFkIGB7IC4uLmJvZHkgfWAgYW5kIGh1bnRlZCBvbmUgc2hhcGUsIHNvIGEgZGlmZmVyZW50bHktbmFtZWQgY3JlZGVudGlhbCBpblxuICogdGhlIHNhbWUgb2JqZWN0IHJvZGUgdGhyb3VnaCB1bnRvdWNoZWQuIE5ldXRyYWxpemluZyBieSBTSEFQRSBhdCBldmVyeSBkZXB0aCBtZWFucyBhIGZ1dHVyZVxuICogYGNsYXVkZUFpT2F1dGgucmVmcmVzaF90b2tlbmAsIG9yIGEgc2Vjb25kIGFjY291bnQgYmxvY2ssIGNhbm5vdCByZW9wZW4gaXQuXG4gKi9cbmZ1bmN0aW9uIG5ldXRyYWxpemVSZWZyZXNoVG9rZW5zKHZhbHVlOiB1bmtub3duKTogdW5rbm93biB7XG4gIGlmIChBcnJheS5pc0FycmF5KHZhbHVlKSkgcmV0dXJuIHZhbHVlLm1hcChuZXV0cmFsaXplUmVmcmVzaFRva2Vucyk7XG4gIGlmICghdmFsdWUgfHwgdHlwZW9mIHZhbHVlICE9PSBcIm9iamVjdFwiKSByZXR1cm4gdmFsdWU7XG4gIHJldHVybiBPYmplY3QuZnJvbUVudHJpZXMoXG4gICAgT2JqZWN0LmVudHJpZXModmFsdWUpLm1hcCgoW2tleSwgbmVzdGVkXSkgPT4gW1xuICAgICAga2V5LFxuICAgICAgcmVmcmVzaFRva2VuS2V5UGF0aHMoeyBba2V5XTogbnVsbCB9KS5sZW5ndGhcbiAgICAgICAgPyBXT1JLU1BBQ0VfSE9TVF9DTEFVREVfTkVVVFJBTElaRURfUkVGUkVTSF9UT0tFTlxuICAgICAgICA6IG5ldXRyYWxpemVSZWZyZXNoVG9rZW5zKG5lc3RlZCksXG4gICAgXSksXG4gICk7XG59XG5cbi8qKlxuICogVmFsaWRhdGUgdGhlIGltbXV0YWJsZSBDb2RleCBtZW1iZXIgd2l0aG91dCBldmVyIHJldHVybmluZyBvciBuYW1pbmcgYSB0b2tlbiB2YWx1ZS5cbiAqXG4gKiBTZWNyZXQgaXNvbGF0aW9uIChldmVyeSB2MyBwYXJzZSwgaW5jbHVkaW5nIHJlYWQvcmV2b2tlIG9mIGFuIG9sZGVyIGdlbmVyYXRpb24pOiB0aGUgb25seVxuICogcmVmcmVzaC10b2tlbi1zaGFwZWQga2V5IGFsbG93ZWQgYW55d2hlcmUgaXMgYHRva2Vucy5yZWZyZXNoX3Rva2VuYCwgYW5kIG9ubHkgd2hlbiBpdCBpcyB0aGVcbiAqIG5ldXRyYWxpemVkIGVtcHR5IHN0cmluZy4gQSBtZW1iZXIgdGhhdCBzaW1wbHkgTEFDS1MgdGhlIGtleSBpcyBzdGlsbCByZWFkYWJsZSBoZXJlIOKAlCBpdCBpcyBhXG4gKiBwcmUtZml4IHYzIHByb2plY3Rpb24gdGhhdCBgYXNzZXJ0V29ya3NwYWNlSG9zdENvZGV4UHJvamVjdGlvbkNsaVJlYWRhYmxlYCByZWZ1c2VzIGF0XG4gKiBhZG1pc3Npb24sIHNvIGl0IGNhbiBiZSByZXZva2VkIGJ1dCBuZXZlciBzcGVuZHMgYSBwcm9iZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGFzc2VydFdvcmtzcGFjZUhvc3RDb2RleEFjY2Vzc1Rva2VuUHJvamVjdGlvbihcbiAgY29kZXg6IEJ1ZmZlcixcbik6IHZvaWQge1xuICBjb25zdCBib2R5ID0gcGFyc2VKc29uT2JqZWN0Qnl0ZXMoY29kZXgsIFwiZmlsZXMuY29kZXggSlNPTlwiKTtcbiAgY29uc3QgdG9rZW5zID0gcmVjb3JkKGJvZHkudG9rZW5zLCBcImZpbGVzLmNvZGV4IEpTT04udG9rZW5zXCIpO1xuICBpZiAoXG4gICAgdHlwZW9mIHRva2Vucy5hY2Nlc3NfdG9rZW4gIT09IFwic3RyaW5nXCIgfHxcbiAgICB0b2tlbnMuYWNjZXNzX3Rva2VuLmxlbmd0aCA9PT0gMFxuICApIHtcbiAgICB0aHJvdyBuZXcgV29ya3NwYWNlSG9zdEFnZW50SG9tZUJ1bmRsZUVycm9yKFxuICAgICAgXCJmaWxlcy5jb2RleCBtdXN0IGNvbnRhaW4gYSBub24tZW1wdHkgYWNjZXNzIHRva2VuXCIsXG4gICAgKTtcbiAgfVxuICBjb25zdCByZWZyZXNoS2V5cyA9IHJlZnJlc2hUb2tlbktleVBhdGhzKGJvZHkpO1xuICBjb25zdCBvbmx5TmV1dHJhbGl6ZWQgPVxuICAgIHJlZnJlc2hLZXlzLmV2ZXJ5KChwYXRoKSA9PiBwYXRoID09PSBcInRva2Vucy5yZWZyZXNoX3Rva2VuXCIpICYmXG4gICAgKCEoXCJyZWZyZXNoX3Rva2VuXCIgaW4gdG9rZW5zKSB8fFxuICAgICAgdG9rZW5zLnJlZnJlc2hfdG9rZW4gPT09IFdPUktTUEFDRV9IT1NUX0NPREVYX05FVVRSQUxJWkVEX1JFRlJFU0hfVE9LRU4pO1xuICBpZiAoIW9ubHlOZXV0cmFsaXplZCkge1xuICAgIHRocm93IG5ldyBXb3Jrc3BhY2VIb3N0QWdlbnRIb21lQnVuZGxlRXJyb3IoXG4gICAgICBcImZpbGVzLmNvZGV4IGFjY2Vzcy10b2tlbiBwcm9qZWN0aW9uIG11c3Qgbm90IGNvbnRhaW4gYSByZWZyZXNoIHRva2VuXCIsXG4gICAgKTtcbiAgfVxuICAvLyBUaGUgc2Vjb25kIGhhbGYgb2YgcHJvamVjdC10aGVuLWFzc2VydCAoV0ktMTAwMDE2ODgpLiBUaGUgcHJvamVjdGlvbiBhbHJlYWR5IHN0cmlwcyB0aGVzZSwgc29cbiAgLy8gcmVhY2hpbmcgaGVyZSBtZWFucyB0aGUgbWF0ZXJpYWwgd2FzIG1pbnRlZCBieSBzb21ldGhpbmcgT1RIRVIgdGhhbiB0aGUgY3VycmVudCBwcm9qZWN0aW9uIOKAlFxuICAvLyBleGFjdGx5IHRoZSBjYXNlIGFuIGFkbWlzc2lvbiBnYXRlIGV4aXN0cyB0byByZWZ1c2UsIGFuZCB0aGUgb25lIGEgc3RyaXBwaW5nIHByb2plY3Rpb24gYWxvbmVcbiAgLy8gY2Fubm90IGNhdGNoLiBObyBwYXRoIGlzIG5hbWVkIGluIHRoZSBtZXNzYWdlOiBuYW1pbmcgaXQgd291bGQgZWNobyB3aGVyZSBhIHNlY3JldCBzYXQuXG4gIC8vIE1pcnJvcnMgdGhlIHJlZnJlc2gtdG9rZW4gYWxsb3dhbmNlIGRpcmVjdGx5IGFib3ZlOiB0aGUgS0VZIG1heSBiZSBwcmVzZW50IChELTMyMCDigJQgdGhlIGZpZWxkXG4gIC8vIG11c3Qgc3Vydml2ZSBmb3IgY29kZXgtY2xpIHRvIGRlc2VyaWFsaXplKSwgYnV0IG9ubHkgY2FycnlpbmcgaXRzIG5ldXRyYWxpemVkIHZhbHVlLiBBXG4gIC8vIG5vbi1udWxsIGFwaSBrZXkgbWVhbnMgdGhlIG1hdGVyaWFsIHdhcyBtaW50ZWQgYnkgc29tZXRoaW5nIG90aGVyIHRoYW4gdGhlIGN1cnJlbnRcbiAgLy8gcHJvamVjdGlvbiwgd2hpY2ggaXMgcHJlY2lzZWx5IHdoYXQgYW4gYWRtaXNzaW9uIGdhdGUgZXhpc3RzIHRvIHJlZnVzZS5cbiAgaWYgKGxpdmVBcGlLZXlQYXRocyhib2R5KS5sZW5ndGggPiAwKSB7XG4gICAgdGhyb3cgbmV3IFdvcmtzcGFjZUhvc3RBZ2VudEhvbWVCdW5kbGVFcnJvcihcbiAgICAgIFwiZmlsZXMuY29kZXggYWNjZXNzLXRva2VuIHByb2plY3Rpb24gbXVzdCBub3QgY29udGFpbiBhbiBBUEkga2V5XCIsXG4gICAgKTtcbiAgfVxufVxuXG4vKipcbiAqIEFkbWlzc2lvbi10aW1lIGNvbnRyYWN0OiB0aGUgYnl0ZXMgbXVzdCBiZSB3aGF0IHRoZSBDb2RleCBDTEkgY2FuIGFjdHVhbGx5IGRlc2VyaWFsaXplLlxuICpcbiAqIENsb3NlZCBmYWlsdXJlLCBubyBwcm9iZSBzcGVudDogYSBnZW5lcmF0aW9uIHdob3NlIENvZGV4IG1lbWJlciBsYWNrcyB0aGUgbmV1dHJhbGl6ZWRcbiAqIGByZWZyZXNoX3Rva2VuYCBrZXkgb3IgYW4gYGlkX3Rva2VuYCBpcyByZWZ1c2VkIEhFUkUgd2l0aCBhIHJlYXNvbiB0aGF0IG5hbWVzIHRoZSByZXBhaXJcbiAqIChyZS1taW50IHVuZGVyIHRoZSBjdXJyZW50IHByb2plY3Rpb24pLCBpbnN0ZWFkIG9mIGV4aXRpbmcgYSBwYWlkIHByb2JlIGFzIGBub24temVyby1leGl0YC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGFzc2VydFdvcmtzcGFjZUhvc3RDb2RleFByb2plY3Rpb25DbGlSZWFkYWJsZShcbiAgY29kZXg6IEJ1ZmZlcixcbik6IHZvaWQge1xuICBhc3NlcnRXb3Jrc3BhY2VIb3N0Q29kZXhBY2Nlc3NUb2tlblByb2plY3Rpb24oY29kZXgpO1xuICBjb25zdCBib2R5ID0gcGFyc2VKc29uT2JqZWN0Qnl0ZXMoY29kZXgsIFwiZmlsZXMuY29kZXggSlNPTlwiKTtcbiAgY29uc3QgdG9rZW5zID0gcmVjb3JkKGJvZHkudG9rZW5zLCBcImZpbGVzLmNvZGV4IEpTT04udG9rZW5zXCIpO1xuICBpZiAodG9rZW5zLnJlZnJlc2hfdG9rZW4gIT09IFdPUktTUEFDRV9IT1NUX0NPREVYX05FVVRSQUxJWkVEX1JFRlJFU0hfVE9LRU4pIHtcbiAgICB0aHJvdyBuZXcgV29ya3NwYWNlSG9zdEFnZW50SG9tZUJ1bmRsZUVycm9yKFxuICAgICAgXCJmaWxlcy5jb2RleCBtdXN0IHJldGFpbiBhbiBlbXB0eSByZWZyZXNoX3Rva2VuIGZpZWxkIGZvciB0aGUgQ29kZXggQ0xJIHRvIGRlc2VyaWFsaXplIGl0OyBcIiArXG4gICAgICAgIFwidGhpcyBnZW5lcmF0aW9uIHdhcyBwcm9qZWN0ZWQgYmVmb3JlIHRoYXQgZml4IGFuZCBtdXN0IGJlIHJlLW1pbnRlZFwiLFxuICAgICk7XG4gIH1cbiAgaWYgKHR5cGVvZiB0b2tlbnMuaWRfdG9rZW4gIT09IFwic3RyaW5nXCIgfHwgdG9rZW5zLmlkX3Rva2VuLmxlbmd0aCA9PT0gMCkge1xuICAgIHRocm93IG5ldyBXb3Jrc3BhY2VIb3N0QWdlbnRIb21lQnVuZGxlRXJyb3IoXG4gICAgICBcImZpbGVzLmNvZGV4IG11c3QgY29udGFpbiBhIG5vbi1lbXB0eSBpZF90b2tlbiBmb3IgdGhlIENvZGV4IENMSSB0byBkZXNlcmlhbGl6ZSBpdFwiLFxuICAgICk7XG4gIH1cbn1cblxuLyoqXG4gKiBQcm9qZWN0IG9uZSBjYW5vbmljYWwgQ29kZXggT0F1dGggaG9tZSBpbnRvIGltbXV0YWJsZSwgYWNjZXNzLXRva2VuLW9ubHkgZ2VuZXJhdGlvbiBieXRlcy5cbiAqXG4gKiBUaGUgY2FsbGVyIHJlbWFpbnMgcmVzcG9uc2libGUgZm9yIHJlc29sdmluZy9yZWZyZXNoaW5nIHRoZSBjYW5vbmljYWwgaG9tZSBmaXJzdC4gVGhpcyBwdXJlXG4gKiBib3VuZGFyeSBuZXV0cmFsaXplcyB0aGUgcm90YXRpbmcgc2luZ2xlLXVzZSByZWZyZXNoIGNyZWRlbnRpYWwgKGVtcHR5IHN0cmluZyDigJQgdGhlIENMSVxuICogcmVxdWlyZXMgdGhlIGZpZWxkIHRvIGV4aXN0KSB3aGlsZSByZXRhaW5pbmcgdGhlIGFjY2VzcyB0b2tlbiBhbmQgYWxsIGFjY291bnQvaWQgbWV0YWRhdGFcbiAqIENvZGV4IG5lZWRzIGZvciBkaXJlY3QgZ3Vlc3QtdG8tcHJvdmlkZXIgaW5mZXJlbmNlIChELTMxMSkuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwcm9qZWN0V29ya3NwYWNlSG9zdENvZGV4QWNjZXNzVG9rZW4oXG4gIGNvZGV4OiBCdWZmZXIsXG4pOiBCdWZmZXIge1xuICBjb25zdCBib2R5ID0gcGFyc2VKc29uT2JqZWN0Qnl0ZXMoY29kZXgsIFwiZmlsZXMuY29kZXggSlNPTlwiKTtcbiAgY29uc3QgdG9rZW5zID0gcmVjb3JkKGJvZHkudG9rZW5zLCBcImZpbGVzLmNvZGV4IEpTT04udG9rZW5zXCIpO1xuICBpZiAoXG4gICAgdHlwZW9mIHRva2Vucy5hY2Nlc3NfdG9rZW4gIT09IFwic3RyaW5nXCIgfHxcbiAgICB0b2tlbnMuYWNjZXNzX3Rva2VuLmxlbmd0aCA9PT0gMFxuICApIHtcbiAgICB0aHJvdyBuZXcgV29ya3NwYWNlSG9zdEFnZW50SG9tZUJ1bmRsZUVycm9yKFxuICAgICAgXCJmaWxlcy5jb2RleCBtdXN0IGNvbnRhaW4gYSBub24tZW1wdHkgYWNjZXNzIHRva2VuXCIsXG4gICAgKTtcbiAgfVxuICAvLyBgeyAuLi5ib2R5IH1gIHByZXZpb3VzbHkgc3ByZWFkIEVWRVJZIHRvcC1sZXZlbCBrZXksIHNvIGEgcmVhbCBgfi8uY29kZXgvYXV0aC5qc29uYCBjYXJyaWVkXG4gIC8vIGl0cyBgT1BFTkFJX0FQSV9LRVlgIHN0cmFpZ2h0IHRvIHRoZSBob3N0IHBhc3QgdGhlIHJlZnJlc2gtdG9rZW4gaHVudCBiZWxvdyAoV0ktMTAwMDE2ODgpLlxuICBjb25zdCBwcm9qZWN0ZWRUb2tlbnM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge1xuICAgIC4uLihuZXV0cmFsaXplQXBpS2V5cyh0b2tlbnMpIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KSxcbiAgICByZWZyZXNoX3Rva2VuOiBXT1JLU1BBQ0VfSE9TVF9DT0RFWF9ORVVUUkFMSVpFRF9SRUZSRVNIX1RPS0VOLFxuICB9O1xuICBjb25zdCBwcm9qZWN0ZWQgPSBCdWZmZXIuZnJvbShcbiAgICBKU09OLnN0cmluZ2lmeSh7XG4gICAgICAuLi4obmV1dHJhbGl6ZUFwaUtleXMoYm9keSkgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4pLFxuICAgICAgdG9rZW5zOiBwcm9qZWN0ZWRUb2tlbnMsXG4gICAgfSksXG4gICAgXCJ1dGY4XCIsXG4gICk7XG4gIGFzc2VydFdvcmtzcGFjZUhvc3RDb2RleFByb2plY3Rpb25DbGlSZWFkYWJsZShwcm9qZWN0ZWQpO1xuICByZXR1cm4gcHJvamVjdGVkO1xufVxuXG4vKipcbiAqIFZhbGlkYXRlIHRoZSBpbW11dGFibGUgQ2xhdWRlIG1lbWJlciB3aXRob3V0IGV2ZXIgcmV0dXJuaW5nIG9yIG5hbWluZyBhIHRva2VuIHZhbHVlIChXSS0xMDAwMTY5MSkuXG4gKlxuICogV0hZIFRISVMgRVhJU1RTIEFUIEFMTC4gYGVuY29kZVdvcmtzcGFjZUhvc3RBZ2VudEhvbWVCdW5kbGVgIHVzZWQgdG8gY2FsbCBgZGVjb2RlSnNvbkZpbGVgIG9uIHRoZVxuICogY2xhdWRlIG1lbWJlciBhbmQgRElTQ0FSRCB0aGUgcmVzdWx0IOKAlCB2YWxpZGF0aW9uIG9ubHkg4oCUIHRoZW4gY2FycnkgdGhlIE9SSUdJTkFMIGJ5dGVzLiBTbyBhIHJlYWxcbiAqIGB+Ly5jbGF1ZGUvLmNyZWRlbnRpYWxzLmpzb25gIHdhcyBjb3BpZWQgV0hPTEUgb250byBhIGNsb3VkIFZNLCBgY2xhdWRlQWlPYXV0aC5yZWZyZXNoVG9rZW5gXG4gKiBpbmNsdWRlZCwgd2hpbGUgaXRzIGNvZGV4IHNpYmxpbmcgb25lIGxpbmUgYmVsb3cgd2FzIHByb2plY3RlZC4gQSByZWZyZXNoIHRva2VuIG1pbnRzIG5ldyBhY2Nlc3NcbiAqIGZvciB0aGF0IGFjY291bnQgc2Vzc2lvbiBpbmRlZmluaXRlbHk7IHRoZSBhY2Nlc3MgdG9rZW4gYmVzaWRlIGl0IGV4cGlyZXMgaW4gfjZoLiBFdmVyeSBwaWVjZSBvZlxuICogbWFjaGluZXJ5IG5lZWRlZCB0byBzdG9wIGl0IGFscmVhZHkgZXhpc3RlZCBhbmQgd2FzIGFscmVhZHkgc2hhcGUtYmFzZWQg4oCUIGl0IHdhcyBzaW1wbHkgbmV2ZXJcbiAqIHBvaW50ZWQgYXQgY2xhdWRlLlxuICpcbiAqIOKaoCBUSEUgT0xEIEZJWFRVUkVTIENPVUxEIE5PVCBIQVZFIENBVUdIVCBUSElTLiBCb3RoIHRlc3QgZml4dHVyZXMgd2VyZVxuICogYHsgY2xhdWRlQWlPYXV0aDogeyBhY2Nlc3NUb2tlbiB9IH1gIHdpdGggbm8gcmVmcmVzaC10b2tlbiBmaWVsZCBhdCBhbGwsIHNvIGV2ZXJ5IGFzc2VydGlvbiBhYm91dFxuICogdGhlIGNsYXVkZSBtZW1iZXIgcGFzc2VkIHdoaWxlIHRoZSBieXRlLWlkZW50aWNhbCBjYXJyeSB3YXMgaW52aXNpYmxlLiBBIGZpeHR1cmUgdGhhdCBjYW5ub3RcbiAqIGV4cHJlc3MgdGhlIGRlZmVjdCBjYW5ub3QgZmFpbCBvbiBpdCwgd2hpY2ggaXMgd2h5IHRoZSBndWFyZHMgYmVsb3cgYXJlIHBhaXJlZCB3aXRoIGZpeHR1cmVzIHRoYXRcbiAqIERPIGNhcnJ5IGEgbGl2ZSByZWZyZXNoIHRva2VuLlxuICpcbiAqIOKaoCBQUkVESUNBVEUgRElGRkVSUyBGUk9NIFRIRSBDT0RFWCBTSUJMSU5HIERFTElCRVJBVEVMWS4gQ29kZXggYWxsb3dsaXN0cyBvbmUgUEFUSFxuICogKGB0b2tlbnMucmVmcmVzaF90b2tlbmApIGFuZCByZWZ1c2VzIHRoZSBrZXkgYW55d2hlcmUgZWxzZTsgdGhpcyBhbGxvd3MgdGhlIGtleSBhdCBBTlkgZGVwdGggc29cbiAqIGxvbmcgYXMgaXQgY2FycmllcyBubyBsaXZlIHZhbHVlLiBDbGF1ZGUncyBmaWxlIGlzIGEgc2luZ2xlIGFjY291bnQgb2JqZWN0IHRvZGF5LCBhbmQgYVxuICogdmFsdWUtYmFzZWQgcHJlZGljYXRlIHN0YXlzIGNvcnJlY3QgaWYgYSBzZWNvbmQgYWNjb3VudCBibG9jayBvciBhIHJlbmFtZWQgZmllbGQgYXBwZWFycywgd2hlcmUgYVxuICogcGF0aCBhbGxvd2xpc3Qgd291bGQgcmVmdXNlIGEgY29ycmVjdGx5LW5ldXRyYWxpemVkIGZpbGUgZm9yIGJlaW5nIHNoYXBlZCBkaWZmZXJlbnRseS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGFzc2VydFdvcmtzcGFjZUhvc3RDbGF1ZGVBY2Nlc3NUb2tlblByb2plY3Rpb24oXG4gIGNsYXVkZTogQnVmZmVyLFxuKTogdm9pZCB7XG4gIGNvbnN0IGJvZHkgPSBwYXJzZUpzb25PYmplY3RCeXRlcyhjbGF1ZGUsIFwiZmlsZXMuY2xhdWRlIEpTT05cIik7XG4gIGNvbnN0IG9hdXRoID0gcmVjb3JkKGJvZHkuY2xhdWRlQWlPYXV0aCwgXCJmaWxlcy5jbGF1ZGUgSlNPTi5jbGF1ZGVBaU9hdXRoXCIpO1xuICBpZiAoXG4gICAgdHlwZW9mIG9hdXRoLmFjY2Vzc1Rva2VuICE9PSBcInN0cmluZ1wiIHx8XG4gICAgb2F1dGguYWNjZXNzVG9rZW4ubGVuZ3RoID09PSAwXG4gICkge1xuICAgIHRocm93IG5ldyBXb3Jrc3BhY2VIb3N0QWdlbnRIb21lQnVuZGxlRXJyb3IoXG4gICAgICBcImZpbGVzLmNsYXVkZSBtdXN0IGNvbnRhaW4gYSBub24tZW1wdHkgYWNjZXNzIHRva2VuXCIsXG4gICAgKTtcbiAgfVxuICAvLyBObyBwYXRoIGlzIG5hbWVkIGluIGVpdGhlciBtZXNzYWdlIGJlbG93OiBuYW1pbmcgaXQgd291bGQgZWNobyB3aGVyZSBhIHNlY3JldCBzYXQuXG4gIGlmIChsaXZlUmVmcmVzaFRva2VuUGF0aHMoYm9keSkubGVuZ3RoID4gMCkge1xuICAgIHRocm93IG5ldyBXb3Jrc3BhY2VIb3N0QWdlbnRIb21lQnVuZGxlRXJyb3IoXG4gICAgICBcImZpbGVzLmNsYXVkZSBhY2Nlc3MtdG9rZW4gcHJvamVjdGlvbiBtdXN0IG5vdCBjb250YWluIGEgcmVmcmVzaCB0b2tlblwiLFxuICAgICk7XG4gIH1cbiAgaWYgKGxpdmVBcGlLZXlQYXRocyhib2R5KS5sZW5ndGggPiAwKSB7XG4gICAgdGhyb3cgbmV3IFdvcmtzcGFjZUhvc3RBZ2VudEhvbWVCdW5kbGVFcnJvcihcbiAgICAgIFwiZmlsZXMuY2xhdWRlIGFjY2Vzcy10b2tlbiBwcm9qZWN0aW9uIG11c3Qgbm90IGNvbnRhaW4gYW4gQVBJIGtleVwiLFxuICAgICk7XG4gIH1cbn1cblxuLyoqXG4gKiBBZG1pc3Npb24tdGltZSBjb250cmFjdDogdGhlIGJ5dGVzIG11c3QgYmUgdGhlIHNoYXBlIHRoZSBDbGF1ZGUgQ0xJIHdhcyBNRUFTVVJFRCB0byBhdXRoZW50aWNhdGVcbiAqIHdpdGggKFdJLTEwMDAxNjkxKS5cbiAqXG4gKiBDbG9zZWQgZmFpbHVyZSwgbm8gcHJvYmUgc3BlbnQg4oCUIHRoZSBjb2RleCByYXRpb25hbGUgYXBwbGllcyB1bmNoYW5nZWQ6IGEgZ2VuZXJhdGlvbiB3aG9zZSBjbGF1ZGVcbiAqIG1lbWJlciBwcmVkYXRlcyB0aGlzIHByb2plY3Rpb24gaXMgcmVmdXNlZCBIRVJFLCB3aXRoIGEgcmVhc29uIG5hbWluZyB0aGUgcmVwYWlyIChyZS1taW50IHVuZGVyXG4gKiB0aGUgY3VycmVudCBwcm9qZWN0aW9uKSwgcmF0aGVyIHRoYW4gYnVybmluZyBhIHBhaWQgcmVhZGluZXNzIHByb2JlIHRvIGV4aXQgYXMgYG5vbi16ZXJvLWV4aXRgLlxuICovXG5leHBvcnQgZnVuY3Rpb24gYXNzZXJ0V29ya3NwYWNlSG9zdENsYXVkZVByb2plY3Rpb25DbGlSZWFkYWJsZShcbiAgY2xhdWRlOiBCdWZmZXIsXG4pOiB2b2lkIHtcbiAgYXNzZXJ0V29ya3NwYWNlSG9zdENsYXVkZUFjY2Vzc1Rva2VuUHJvamVjdGlvbihjbGF1ZGUpO1xuICBjb25zdCBib2R5ID0gcGFyc2VKc29uT2JqZWN0Qnl0ZXMoY2xhdWRlLCBcImZpbGVzLmNsYXVkZSBKU09OXCIpO1xuICBjb25zdCBvYXV0aCA9IHJlY29yZChib2R5LmNsYXVkZUFpT2F1dGgsIFwiZmlsZXMuY2xhdWRlIEpTT04uY2xhdWRlQWlPYXV0aFwiKTtcbiAgaWYgKG9hdXRoLnJlZnJlc2hUb2tlbiAhPT0gV09SS1NQQUNFX0hPU1RfQ0xBVURFX05FVVRSQUxJWkVEX1JFRlJFU0hfVE9LRU4pIHtcbiAgICB0aHJvdyBuZXcgV29ya3NwYWNlSG9zdEFnZW50SG9tZUJ1bmRsZUVycm9yKFxuICAgICAgXCJmaWxlcy5jbGF1ZGUgbXVzdCByZXRhaW4gYW4gZW1wdHkgcmVmcmVzaFRva2VuIGZpZWxkIOKAlCB0aGUgc2hhcGUgbWVhc3VyZWQgdG8gYXV0aGVudGljYXRlOyBcIiArXG4gICAgICAgIFwidGhpcyBnZW5lcmF0aW9uIHdhcyBwcm9qZWN0ZWQgYmVmb3JlIHRoYXQgZml4IGFuZCBtdXN0IGJlIHJlLW1pbnRlZFwiLFxuICAgICk7XG4gIH1cbn1cblxuLyoqXG4gKiBQcm9qZWN0IG9uZSBjYW5vbmljYWwgQ2xhdWRlIE9BdXRoIGhvbWUgaW50byBpbW11dGFibGUsIGFjY2Vzcy10b2tlbi1vbmx5IGdlbmVyYXRpb24gYnl0ZXMuXG4gKlxuICogVGhlIHNpYmxpbmcgb2YgYHByb2plY3RXb3Jrc3BhY2VIb3N0Q29kZXhBY2Nlc3NUb2tlbmAsIGFuZCB0aGUgcmVhc29uIHRoZSBhc3ltbWV0cnkgYWJvdmUgaXMgbm93XG4gKiBjbG9zZWQuIFJldGFpbnMgdGhlIGFjY2VzcyB0b2tlbiBhbmQgYWxsIGFjY291bnQgbWV0YWRhdGEgdGhlIENMSSBuZWVkcyBmb3IgZGlyZWN0XG4gKiBndWVzdC10by1wcm92aWRlciBpbmZlcmVuY2UsIGFuZCBuZXV0cmFsaXplcyB0aGUgcm90YXRpbmcgcmVmcmVzaCBjcmVkZW50aWFsIGluIHBsYWNlLlxuICpcbiAqIE1FQVNVUkVELCBub3QgcmVhc29uZWQ6IGEgY3JlZGVudGlhbCBwcm9qZWN0ZWQgZXhhY3RseSB0aGlzIHdheSBwZXJmb3JtcyBSRUFMIGluZmVyZW5jZSwgdmVyaWZpZWRcbiAqIGFnYWluc3QgYSBuZWdhdGl2ZSBjb250cm9sIHRoYXQgcnVsZXMgb3V0IGFtYmllbnQgZ2F0ZXdheSBhdXRoIChzZWVcbiAqIGBXT1JLU1BBQ0VfSE9TVF9DTEFVREVfTkVVVFJBTElaRURfUkVGUkVTSF9UT0tFTmApLiBUaGUgZXhwbGljaXQgYHJlZnJlc2hUb2tlbmAgYXNzaWdubWVudCBhZnRlclxuICogdGhlIGV4aGF1c3RpdmUgbmV1dHJhbGl6ZSBpcyBub3QgcmVkdW5kYW50OiBhIHNvdXJjZSBmaWxlIGxhY2tpbmcgdGhlIGtleSBlbnRpcmVseSB3b3VsZCBvdGhlcndpc2VcbiAqIHlpZWxkIG5vIGZpZWxkIGF0IGFsbCwgYW5kIGFic2VudCBpcyB0aGUgb25lIHNoYXBlIHRoYXQgd2FzIE5PVCBtZWFzdXJlZC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHByb2plY3RXb3Jrc3BhY2VIb3N0Q2xhdWRlQWNjZXNzVG9rZW4oY2xhdWRlOiBCdWZmZXIpOiBCdWZmZXIge1xuICBjb25zdCBib2R5ID0gcGFyc2VKc29uT2JqZWN0Qnl0ZXMoY2xhdWRlLCBcImZpbGVzLmNsYXVkZSBKU09OXCIpO1xuICBjb25zdCBvYXV0aCA9IHJlY29yZChib2R5LmNsYXVkZUFpT2F1dGgsIFwiZmlsZXMuY2xhdWRlIEpTT04uY2xhdWRlQWlPYXV0aFwiKTtcbiAgaWYgKFxuICAgIHR5cGVvZiBvYXV0aC5hY2Nlc3NUb2tlbiAhPT0gXCJzdHJpbmdcIiB8fFxuICAgIG9hdXRoLmFjY2Vzc1Rva2VuLmxlbmd0aCA9PT0gMFxuICApIHtcbiAgICB0aHJvdyBuZXcgV29ya3NwYWNlSG9zdEFnZW50SG9tZUJ1bmRsZUVycm9yKFxuICAgICAgXCJmaWxlcy5jbGF1ZGUgbXVzdCBjb250YWluIGEgbm9uLWVtcHR5IGFjY2VzcyB0b2tlblwiLFxuICAgICk7XG4gIH1cbiAgY29uc3QgcHJvamVjdGVkT2F1dGg6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge1xuICAgIC4uLihuZXV0cmFsaXplQXBpS2V5cyhuZXV0cmFsaXplUmVmcmVzaFRva2VucyhvYXV0aCkpIGFzIFJlY29yZDxcbiAgICAgIHN0cmluZyxcbiAgICAgIHVua25vd25cbiAgICA+KSxcbiAgICByZWZyZXNoVG9rZW46IFdPUktTUEFDRV9IT1NUX0NMQVVERV9ORVVUUkFMSVpFRF9SRUZSRVNIX1RPS0VOLFxuICB9O1xuICBjb25zdCBwcm9qZWN0ZWQgPSBCdWZmZXIuZnJvbShcbiAgICBKU09OLnN0cmluZ2lmeSh7XG4gICAgICAuLi4obmV1dHJhbGl6ZUFwaUtleXMobmV1dHJhbGl6ZVJlZnJlc2hUb2tlbnMoYm9keSkpIGFzIFJlY29yZDxcbiAgICAgICAgc3RyaW5nLFxuICAgICAgICB1bmtub3duXG4gICAgICA+KSxcbiAgICAgIGNsYXVkZUFpT2F1dGg6IHByb2plY3RlZE9hdXRoLFxuICAgIH0pLFxuICAgIFwidXRmOFwiLFxuICApO1xuICBhc3NlcnRXb3Jrc3BhY2VIb3N0Q2xhdWRlUHJvamVjdGlvbkNsaVJlYWRhYmxlKHByb2plY3RlZCk7XG4gIHJldHVybiBwcm9qZWN0ZWQ7XG59XG5cbi8qKiBQYXJzZSB3aXRob3V0IGV2ZXIgZWNob2luZyBhIGRlY29kZWQgYnl0ZSBpbnRvIGFuIGVycm9yIG9yIHJlY2VpcHQuICovXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VXb3Jrc3BhY2VIb3N0QWdlbnRIb21lQnVuZGxlKFxuICBtYXRlcmlhbDogQnVmZmVyLFxuKTogV29ya3NwYWNlSG9zdEFnZW50SG9tZUJ1bmRsZSB7XG4gIGxldCBwYXJzZWQ6IHVua25vd247XG4gIHRyeSB7XG4gICAgcGFyc2VkID0gSlNPTi5wYXJzZShtYXRlcmlhbC50b1N0cmluZyhcInV0ZjhcIikpO1xuICB9IGNhdGNoIHtcbiAgICB0aHJvdyBuZXcgV29ya3NwYWNlSG9zdEFnZW50SG9tZUJ1bmRsZUVycm9yKFxuICAgICAgXCJhZ2VudC1ob21lIG1hdGVyaWFsIG11c3QgYmUgdmFsaWQgSlNPTlwiLFxuICAgICk7XG4gIH1cbiAgY29uc3QgYm9keSA9IHJlY29yZChwYXJzZWQsIFwiYWdlbnQtaG9tZSBtYXRlcmlhbFwiKTtcbiAgZXhhY3RLZXlzKGJvZHksIFtcImNvbnRyYWN0VmVyc2lvblwiLCBcImZpbGVzXCJdLCBcImFnZW50LWhvbWUgbWF0ZXJpYWxcIik7XG4gIGlmIChcbiAgICBib2R5LmNvbnRyYWN0VmVyc2lvbiAhPT0gV09SS1NQQUNFX0hPU1RfQUdFTlRfSE9NRV9CVU5ETEVfVkVSU0lPTiAmJlxuICAgIGJvZHkuY29udHJhY3RWZXJzaW9uICE9PVxuICAgICAgV09SS1NQQUNFX0hPU1RfQUdFTlRfSE9NRV9NVVRBQkxFX0NBQ0hFX0JVTkRMRV9WRVJTSU9OICYmXG4gICAgYm9keS5jb250cmFjdFZlcnNpb24gIT09IFdPUktTUEFDRV9IT1NUX0FHRU5UX0hPTUVfTEVHQUNZX0JVTkRMRV9WRVJTSU9OXG4gICkge1xuICAgIHRocm93IG5ldyBXb3Jrc3BhY2VIb3N0QWdlbnRIb21lQnVuZGxlRXJyb3IoXG4gICAgICBgYWdlbnQtaG9tZSBtYXRlcmlhbCBtdXN0IHVzZSAke1dPUktTUEFDRV9IT1NUX0FHRU5UX0hPTUVfQlVORExFX1ZFUlNJT059LCAke1dPUktTUEFDRV9IT1NUX0FHRU5UX0hPTUVfTVVUQUJMRV9DQUNIRV9CVU5ETEVfVkVSU0lPTn0sIG9yICR7V09SS1NQQUNFX0hPU1RfQUdFTlRfSE9NRV9MRUdBQ1lfQlVORExFX1ZFUlNJT059YCxcbiAgICApO1xuICB9XG4gIGNvbnN0IGZpbGVzID0gcmVjb3JkKGJvZHkuZmlsZXMsIFwiYWdlbnQtaG9tZSBtYXRlcmlhbC5maWxlc1wiKTtcbiAgZXhhY3RLZXlzKFxuICAgIGZpbGVzLFxuICAgIE9iamVjdC5rZXlzKFdPUktTUEFDRV9IT1NUX0FHRU5UX0hPTUVfRklMRVMpLFxuICAgIFwiYWdlbnQtaG9tZSBtYXRlcmlhbC5maWxlc1wiLFxuICApO1xuICBjb25zdCBjb250cmFjdFZlcnNpb24gPSBib2R5LmNvbnRyYWN0VmVyc2lvbiBhc1xuICAgIHwgdHlwZW9mIFdPUktTUEFDRV9IT1NUX0FHRU5UX0hPTUVfQlVORExFX1ZFUlNJT05cbiAgICB8IHR5cGVvZiBXT1JLU1BBQ0VfSE9TVF9BR0VOVF9IT01FX01VVEFCTEVfQ0FDSEVfQlVORExFX1ZFUlNJT05cbiAgICB8IHR5cGVvZiBXT1JLU1BBQ0VfSE9TVF9BR0VOVF9IT01FX0xFR0FDWV9CVU5ETEVfVkVSU0lPTjtcbiAgY29uc3QgY2xhdWRlID0gZGVjb2RlSnNvbkZpbGUoZmlsZXMuY2xhdWRlLCBcImNsYXVkZVwiKTtcbiAgY29uc3QgY29kZXggPSBkZWNvZGVKc29uRmlsZShmaWxlcy5jb2RleCwgXCJjb2RleFwiKTtcbiAgaWYgKGNvbnRyYWN0VmVyc2lvbiA9PT0gV09SS1NQQUNFX0hPU1RfQUdFTlRfSE9NRV9CVU5ETEVfVkVSU0lPTikge1xuICAgIGFzc2VydFdvcmtzcGFjZUhvc3RDbGF1ZGVBY2Nlc3NUb2tlblByb2plY3Rpb24oY2xhdWRlKTtcbiAgICBhc3NlcnRXb3Jrc3BhY2VIb3N0Q29kZXhBY2Nlc3NUb2tlblByb2plY3Rpb24oY29kZXgpO1xuICB9XG4gIHJldHVybiB7XG4gICAgY29udHJhY3RWZXJzaW9uLFxuICAgIGZpbGVzOiB7XG4gICAgICBjbGF1ZGUsXG4gICAgICBjb2RleCxcbiAgICAgIG9tcDpcbiAgICAgICAgY29udHJhY3RWZXJzaW9uICE9PSBXT1JLU1BBQ0VfSE9TVF9BR0VOVF9IT01FX0xFR0FDWV9CVU5ETEVfVkVSU0lPTiAmJlxuICAgICAgICBmaWxlcy5vbXAgPT09IG51bGxcbiAgICAgICAgICA/IG51bGxcbiAgICAgICAgICA6IGRlY29kZUpzb25GaWxlKGZpbGVzLm9tcCwgXCJvbXBcIiksXG4gICAgfSxcbiAgfTtcbn1cblxuLyoqIEV4cGxpY2l0IHNlY3JldC1iZWFyaW5nIGVuY29kZXIgdXNlZCBieSBzZXR1cCBjb2RlIGFuZCBoZXJtZXRpYyB0ZXN0cy4gKi9cbmV4cG9ydCBmdW5jdGlvbiBlbmNvZGVXb3Jrc3BhY2VIb3N0QWdlbnRIb21lQnVuZGxlKFxuICBmaWxlczogV29ya3NwYWNlSG9zdEFnZW50SG9tZUJ1bmRsZUZpbGVzLFxuKTogQnVmZmVyIHtcbiAgLy8gV0ktMTAwMDE2OTE6IHRoaXMgbGluZSB1c2VkIHRvIGJlIGBkZWNvZGVKc29uRmlsZShmaWxlcy5jbGF1ZGUuLi4pYCB3aXRoIGl0cyByZXN1bHQgRElTQ0FSREVELFxuICAvLyBhbmQgdGhlIG1lbWJlciBiZWxvdyBjYXJyaWVkIGBmaWxlcy5jbGF1ZGVgIOKAlCB0aGUgT1JJR0lOQUwgYnl0ZXMsIHJlZnJlc2ggdG9rZW4gYW5kIGFsbC5cbiAgY29uc3QgY2xhdWRlID0gcHJvamVjdFdvcmtzcGFjZUhvc3RDbGF1ZGVBY2Nlc3NUb2tlbihmaWxlcy5jbGF1ZGUpO1xuICBjb25zdCBjb2RleCA9IHByb2plY3RXb3Jrc3BhY2VIb3N0Q29kZXhBY2Nlc3NUb2tlbihmaWxlcy5jb2RleCk7XG4gIGlmIChmaWxlcy5vbXAgIT09IG51bGwpIHtcbiAgICBkZWNvZGVKc29uRmlsZShmaWxlcy5vbXAudG9TdHJpbmcoXCJiYXNlNjRcIiksIFwib21wXCIpO1xuICB9XG4gIHJldHVybiBCdWZmZXIuZnJvbShcbiAgICBKU09OLnN0cmluZ2lmeSh7XG4gICAgICBjb250cmFjdFZlcnNpb246IFdPUktTUEFDRV9IT1NUX0FHRU5UX0hPTUVfQlVORExFX1ZFUlNJT04sXG4gICAgICBmaWxlczoge1xuICAgICAgICBjbGF1ZGU6IGNsYXVkZS50b1N0cmluZyhcImJhc2U2NFwiKSxcbiAgICAgICAgY29kZXg6IGNvZGV4LnRvU3RyaW5nKFwiYmFzZTY0XCIpLFxuICAgICAgICBvbXA6IGZpbGVzLm9tcD8udG9TdHJpbmcoXCJiYXNlNjRcIikgPz8gbnVsbCxcbiAgICAgIH0sXG4gICAgfSksXG4gICAgXCJ1dGY4XCIsXG4gICk7XG59XG5cbi8qKiBOZXcgcGFpZCBvcGVyYXRpb25zIG1heSBjb25zdW1lIG9ubHkgdGhlIGltbXV0YWJsZSB2MyBwcm9qZWN0aW9uIChELTMxMSkuICovXG5leHBvcnQgZnVuY3Rpb24gYXNzZXJ0V29ya3NwYWNlSG9zdEFnZW50SG9tZUJ1bmRsZUFkbWlzc2lvbkVsaWdpYmxlKFxuICBidW5kbGU6IFdvcmtzcGFjZUhvc3RBZ2VudEhvbWVCdW5kbGUsXG4pOiB2b2lkIHtcbiAgaWYgKGJ1bmRsZS5jb250cmFjdFZlcnNpb24gIT09IFdPUktTUEFDRV9IT1NUX0FHRU5UX0hPTUVfQlVORExFX1ZFUlNJT04pIHtcbiAgICB0aHJvdyBuZXcgV29ya3NwYWNlSG9zdEFnZW50SG9tZUJ1bmRsZUVycm9yKFxuICAgICAgYGFnZW50LWhvbWUgYXV0aGVudGljYXRpb24gYWRtaXNzaW9uIHJlcXVpcmVzICR7V09SS1NQQUNFX0hPU1RfQUdFTlRfSE9NRV9CVU5ETEVfVkVSU0lPTn07IGxlZ2FjeSBtdXRhYmxlLWNhY2hlIGJ1bmRsZXMgYXJlIHJlYWQvcmV2b2tlLW9ubHlgLFxuICAgICk7XG4gIH1cbiAgYXNzZXJ0V29ya3NwYWNlSG9zdENsYXVkZVByb2plY3Rpb25DbGlSZWFkYWJsZShidW5kbGUuZmlsZXMuY2xhdWRlKTtcbiAgYXNzZXJ0V29ya3NwYWNlSG9zdENvZGV4UHJvamVjdGlvbkNsaVJlYWRhYmxlKGJ1bmRsZS5maWxlcy5jb2RleCk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiB3b3Jrc3BhY2VIb3N0QWdlbnRIb21lUGF0aHMoXG4gIGhvbWU6IHN0cmluZyxcbik6IFJlYWRvbmx5PFJlY29yZDxXb3Jrc3BhY2VIb3N0QWdlbnRIb21lRmlsZSwgc3RyaW5nPj4ge1xuICByZXF1aXJlRXhwbGljaXRXb3Jrc3BhY2VIb3N0SG9tZShob21lKTtcbiAgcmV0dXJuIHtcbiAgICBjbGF1ZGU6IGpvaW4oaG9tZSwgLi4uV09SS1NQQUNFX0hPU1RfQUdFTlRfSE9NRV9GSUxFUy5jbGF1ZGUpLFxuICAgIGNvZGV4OiBqb2luKGhvbWUsIC4uLldPUktTUEFDRV9IT1NUX0FHRU5UX0hPTUVfRklMRVMuY29kZXgpLFxuICAgIG9tcDogam9pbihob21lLCAuLi5XT1JLU1BBQ0VfSE9TVF9BR0VOVF9IT01FX0ZJTEVTLm9tcCksXG4gIH07XG59XG5cbi8qKiBSZXNvbHZlIE9NUCdzIG1vZGVsIHJlZ2lzdHJ5IGJlbG93IHRoZSBleHBsaWNpdCBhZ2VudCBpZGVudGl0eSBob21lLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHdvcmtzcGFjZUhvc3RBZ2VudEhvbWVPbXBNb2RlbHNQYXRoKGhvbWU6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJlcXVpcmVFeHBsaWNpdFdvcmtzcGFjZUhvc3RIb21lKGhvbWUpO1xuICByZXR1cm4gam9pbihcbiAgICBob21lLFxuICAgIC4uLldPUktTUEFDRV9IT1NUX0FHRU5UX0hPTUVfT01QX01PREVMU19SRUxBVElWRV9QQVRILnNwbGl0KFwiL1wiKSxcbiAgKTtcbn1cblxuLyoqXG4gKiBSZWZ1c2UgYW4gaW5mZXJyZWQsIHJlbGF0aXZlLCBvciBub24tY2Fub25pY2FsIGhvbWUgYmVmb3JlIGEgcm9vdC1vd25lZCBjb25zdW1lciB3cml0ZXMgaW50byBpdC5cbiAqIFRoZSBjYWxsZXIgc3VwcGxpZXMgdGhlIHRhcmdldCBob21lIGV4cGxpY2l0bHk7IGl0IGlzIG5ldmVyIHJlY292ZXJlZCBmcm9tIHRoZSBhbWJpZW50IEhPTUUg4oCUXG4gKiB3aGljaCBtYXR0ZXJzIG1vcmUgc2luY2UgRC0yNDgsIGJlY2F1c2UgdGhlIHJvb3QgY29uc3VtZXIgbm93IHdyaXRlcyBpbnRvIHRoZSBBR0VOVCBpZGVudGl0eSdzXG4gKiBob21lIGFuZCB0aGUgcHJvY2VzcyBydW5uaW5nIGl0IGlzIHJvb3QsIHdob3NlIG93biBIT01FIGlzIGAvcm9vdGAuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZXF1aXJlRXhwbGljaXRXb3Jrc3BhY2VIb3N0SG9tZShob21lOiBzdHJpbmcpOiBzdHJpbmcge1xuICBpZiAoXG4gICAgdHlwZW9mIGhvbWUgIT09IFwic3RyaW5nXCIgfHxcbiAgICAhaXNBYnNvbHV0ZShob21lKSB8fFxuICAgIGhvbWUgPT09IFwiL1wiIHx8XG4gICAgbm9ybWFsaXplKGhvbWUpICE9PSBob21lIHx8XG4gICAgL1tcXHJcXG5cXDBdLy50ZXN0KGhvbWUpXG4gICkge1xuICAgIHRocm93IG5ldyBXb3Jrc3BhY2VIb3N0QWdlbnRIb21lQnVuZGxlRXJyb3IoXG4gICAgICBcIndvcmtzcGFjZSB1c2VyIGhvbWUgbXVzdCBiZSBhbiBhYnNvbHV0ZSwgY2Fub25pY2FsLCBub24tcm9vdCBwYXRoXCIsXG4gICAgKTtcbiAgfVxuICByZXR1cm4gaG9tZTtcbn1cblxuLyoqIERpcmVjdG9yaWVzIHRoZSBjb25zdW1lciBjcmVhdGVzL2NoZWNrcyBpbiBwYXJlbnQtZmlyc3Qgb3JkZXIuICovXG5leHBvcnQgZnVuY3Rpb24gd29ya3NwYWNlSG9zdEFnZW50SG9tZURpcmVjdG9yaWVzKFxuICBob21lOiBzdHJpbmcsXG4pOiByZWFkb25seSBzdHJpbmdbXSB7XG4gIHJlcXVpcmVFeHBsaWNpdFdvcmtzcGFjZUhvc3RIb21lKGhvbWUpO1xuICByZXR1cm4gW1xuICAgIGhvbWUsXG4gICAgam9pbihob21lLCBcIi5jbGF1ZGVcIiksXG4gICAgam9pbihob21lLCBcIi5jb2RleFwiKSxcbiAgICBqb2luKGhvbWUsIFwiLm9tcFwiKSxcbiAgICBqb2luKGhvbWUsIFwiLm9tcFwiLCBcImFnZW50XCIpLFxuICBdO1xufVxuXG4vKiogUm9vdC1wcml2YXRlIGFjdGl2ZSByZWNvcmQ7IHRoZSBuYXRpdmUgZmlsZXMgdGhlbXNlbHZlcyByZW1haW4gYmVsb3cgdGhlIGV4cGxpY2l0IHVzZXIgaG9tZS4gKi9cbmV4cG9ydCBmdW5jdGlvbiB3b3Jrc3BhY2VIb3N0QWdlbnRIb21lU3RhdGVQYXRoKG1hdGVyaWFsUm9vdDogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIGpvaW4obWF0ZXJpYWxSb290LCBcImFjdGl2ZVwiLCBcImFnZW50LWhvbWUuanNvblwiKTtcbn1cblxuLyoqIE9uZSBsb2NrIGZvciB0aGUgc2hhcmVkIHRocmVlLWZpbGUgbmF0aXZlIGhvbWUsIHJlZ2FyZGxlc3Mgb2Ygd2hpY2ggYWdlbnQgZmFtaWx5IHN1cHBsaWVkIGl0LiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHdvcmtzcGFjZUhvc3RBZ2VudEhvbWVMb2NrUGF0aChtYXRlcmlhbFJvb3Q6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBqb2luKG1hdGVyaWFsUm9vdCwgXCJhY3RpdmVcIiwgXCIuYWdlbnQtaG9tZS5saWZlY3ljbGUubG9ja1wiKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGVuY29kZVdvcmtzcGFjZUhvc3RBZ2VudEhvbWVTdGF0ZShcbiAgZmFtaWx5OiBXb3Jrc3BhY2VIb3N0QWdlbnRIb21lRmFtaWx5LFxuICBnZW5lcmF0aW9uOiBudW1iZXIsXG4gIGhvbWU6IHN0cmluZyxcbik6IEJ1ZmZlciB7XG4gIGlmICghV09SS1NQQUNFX0hPU1RfQUdFTlRfSE9NRV9GQU1JTElFUy5pbmNsdWRlcyhmYW1pbHkpKSB7XG4gICAgdGhyb3cgbmV3IFdvcmtzcGFjZUhvc3RBZ2VudEhvbWVCdW5kbGVFcnJvcihcbiAgICAgIGB1bnN1cHBvcnRlZCBhZ2VudC1ob21lIGZhbWlseSAnJHtmYW1pbHl9J2AsXG4gICAgKTtcbiAgfVxuICBpZiAoIU51bWJlci5pc1NhZmVJbnRlZ2VyKGdlbmVyYXRpb24pIHx8IGdlbmVyYXRpb24gPCAxKSB7XG4gICAgdGhyb3cgbmV3IFdvcmtzcGFjZUhvc3RBZ2VudEhvbWVCdW5kbGVFcnJvcihcbiAgICAgIFwiYWdlbnQtaG9tZSBnZW5lcmF0aW9uIG11c3QgYmUgYSBwb3NpdGl2ZSBzYWZlIGludGVnZXJcIixcbiAgICApO1xuICB9XG4gIGNvbnN0IGZpbGVzID0gd29ya3NwYWNlSG9zdEFnZW50SG9tZVBhdGhzKGhvbWUpO1xuICByZXR1cm4gQnVmZmVyLmZyb20oXG4gICAgSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgY29udHJhY3RWZXJzaW9uOiBXT1JLU1BBQ0VfSE9TVF9BR0VOVF9IT01FX1NUQVRFX1ZFUlNJT04sXG4gICAgICBmYW1pbHksXG4gICAgICBnZW5lcmF0aW9uLFxuICAgICAgaG9tZSxcbiAgICAgIGZpbGVzLFxuICAgIH0pLFxuICAgIFwidXRmOFwiLFxuICApO1xufVxuXG4vKiogUGFyc2UgZmFpbC1jbG9zZWQ6IGEgdGFtcGVyZWQgc3RhdGUgZmlsZSBtdXN0IG5ldmVyIHJlZGlyZWN0IHJvb3Qtb3duZWQgY2xlYW51cCBvdXRzaWRlIEhPTUUuICovXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VXb3Jrc3BhY2VIb3N0QWdlbnRIb21lU3RhdGUoXG4gIG1hdGVyaWFsOiBCdWZmZXIsXG4pOiBXb3Jrc3BhY2VIb3N0QWdlbnRIb21lU3RhdGUge1xuICBsZXQgcGFyc2VkOiB1bmtub3duO1xuICB0cnkge1xuICAgIHBhcnNlZCA9IEpTT04ucGFyc2UobWF0ZXJpYWwudG9TdHJpbmcoXCJ1dGY4XCIpKTtcbiAgfSBjYXRjaCB7XG4gICAgdGhyb3cgbmV3IFdvcmtzcGFjZUhvc3RBZ2VudEhvbWVCdW5kbGVFcnJvcihcbiAgICAgIFwiYWdlbnQtaG9tZSBzdGF0ZSBtdXN0IGJlIHZhbGlkIEpTT05cIixcbiAgICApO1xuICB9XG4gIGNvbnN0IGJvZHkgPSByZWNvcmQocGFyc2VkLCBcImFnZW50LWhvbWUgc3RhdGVcIik7XG4gIGV4YWN0S2V5cyhcbiAgICBib2R5LFxuICAgIFtcImNvbnRyYWN0VmVyc2lvblwiLCBcImZhbWlseVwiLCBcImdlbmVyYXRpb25cIiwgXCJob21lXCIsIFwiZmlsZXNcIl0sXG4gICAgXCJhZ2VudC1ob21lIHN0YXRlXCIsXG4gICk7XG4gIGlmIChib2R5LmNvbnRyYWN0VmVyc2lvbiAhPT0gV09SS1NQQUNFX0hPU1RfQUdFTlRfSE9NRV9TVEFURV9WRVJTSU9OKSB7XG4gICAgdGhyb3cgbmV3IFdvcmtzcGFjZUhvc3RBZ2VudEhvbWVCdW5kbGVFcnJvcihcbiAgICAgIGBhZ2VudC1ob21lIHN0YXRlIG11c3QgdXNlICR7V09SS1NQQUNFX0hPU1RfQUdFTlRfSE9NRV9TVEFURV9WRVJTSU9OfWAsXG4gICAgKTtcbiAgfVxuICBpZiAoXG4gICAgdHlwZW9mIGJvZHkuZmFtaWx5ICE9PSBcInN0cmluZ1wiIHx8XG4gICAgIVdPUktTUEFDRV9IT1NUX0FHRU5UX0hPTUVfRkFNSUxJRVMuaW5jbHVkZXMoXG4gICAgICBib2R5LmZhbWlseSBhcyBXb3Jrc3BhY2VIb3N0QWdlbnRIb21lRmFtaWx5LFxuICAgIClcbiAgKSB7XG4gICAgdGhyb3cgbmV3IFdvcmtzcGFjZUhvc3RBZ2VudEhvbWVCdW5kbGVFcnJvcihcbiAgICAgIFwiYWdlbnQtaG9tZSBzdGF0ZSBoYXMgYW4gdW5zdXBwb3J0ZWQgZmFtaWx5XCIsXG4gICAgKTtcbiAgfVxuICBpZiAoXG4gICAgIU51bWJlci5pc1NhZmVJbnRlZ2VyKGJvZHkuZ2VuZXJhdGlvbikgfHxcbiAgICAoYm9keS5nZW5lcmF0aW9uIGFzIG51bWJlcikgPCAxXG4gICkge1xuICAgIHRocm93IG5ldyBXb3Jrc3BhY2VIb3N0QWdlbnRIb21lQnVuZGxlRXJyb3IoXG4gICAgICBcImFnZW50LWhvbWUgc3RhdGUgZ2VuZXJhdGlvbiBtdXN0IGJlIGEgcG9zaXRpdmUgc2FmZSBpbnRlZ2VyXCIsXG4gICAgKTtcbiAgfVxuICBpZiAodHlwZW9mIGJvZHkuaG9tZSAhPT0gXCJzdHJpbmdcIikge1xuICAgIHRocm93IG5ldyBXb3Jrc3BhY2VIb3N0QWdlbnRIb21lQnVuZGxlRXJyb3IoXG4gICAgICBcImFnZW50LWhvbWUgc3RhdGUuaG9tZSBtdXN0IGJlIGEgc3RyaW5nXCIsXG4gICAgKTtcbiAgfVxuICBjb25zdCBob21lID0gcmVxdWlyZUV4cGxpY2l0V29ya3NwYWNlSG9zdEhvbWUoYm9keS5ob21lKTtcbiAgY29uc3QgZmlsZXMgPSByZWNvcmQoYm9keS5maWxlcywgXCJhZ2VudC1ob21lIHN0YXRlLmZpbGVzXCIpO1xuICBleGFjdEtleXMoXG4gICAgZmlsZXMsXG4gICAgT2JqZWN0LmtleXMoV09SS1NQQUNFX0hPU1RfQUdFTlRfSE9NRV9GSUxFUyksXG4gICAgXCJhZ2VudC1ob21lIHN0YXRlLmZpbGVzXCIsXG4gICk7XG4gIGNvbnN0IGV4cGVjdGVkID0gd29ya3NwYWNlSG9zdEFnZW50SG9tZVBhdGhzKGhvbWUpO1xuICBmb3IgKGNvbnN0IGxhYmVsIG9mIE9iamVjdC5rZXlzKGV4cGVjdGVkKSBhcyBXb3Jrc3BhY2VIb3N0QWdlbnRIb21lRmlsZVtdKSB7XG4gICAgaWYgKGZpbGVzW2xhYmVsXSAhPT0gZXhwZWN0ZWRbbGFiZWxdKSB7XG4gICAgICB0aHJvdyBuZXcgV29ya3NwYWNlSG9zdEFnZW50SG9tZUJ1bmRsZUVycm9yKFxuICAgICAgICBgYWdlbnQtaG9tZSBzdGF0ZS5maWxlcy4ke2xhYmVsfSBkb2VzIG5vdCByZXNvbHZlIGluc2lkZSB0aGUgcmVjb3JkZWQgaG9tZWAsXG4gICAgICApO1xuICAgIH1cbiAgfVxuICByZXR1cm4ge1xuICAgIGNvbnRyYWN0VmVyc2lvbjogV09SS1NQQUNFX0hPU1RfQUdFTlRfSE9NRV9TVEFURV9WRVJTSU9OLFxuICAgIGZhbWlseTogYm9keS5mYW1pbHkgYXMgV29ya3NwYWNlSG9zdEFnZW50SG9tZUZhbWlseSxcbiAgICBnZW5lcmF0aW9uOiBib2R5LmdlbmVyYXRpb24gYXMgbnVtYmVyLFxuICAgIGhvbWUsXG4gICAgZmlsZXM6IGV4cGVjdGVkLFxuICB9O1xufVxuXG4vKipcbiAqIEEgaG9tZSBhIHByZXZpb3VzIHJlbGVhc2UgaW5zdGFsbGVkIGFnZW50IGNyZWRlbnRpYWxzIGludG8gYW5kIHRoaXMgb25lIG5vIGxvbmdlciB0YXJnZXRzLlxuICpcbiAqIEQtMjQ4IHB1dCBjdXN0b21lci1zdXBwbGllZCBDbGF1ZGUvQ29kZXggbWF0ZXJpYWwgaW4gdGhlIHBsYXRmb3JtIGFnZW50IGlkZW50aXR5J3MgaG9tZS4gRC00MjFcbiAqIG1vdmVkIGV2ZXJ5IGN1c3RvbWVyLWRyaXZlbiBhZ2VudCBvbnRvIHRoZSBjdXN0b21lciB3b3Jrc3BhY2UgYWNjb3VudCwgc28gdGhhdCBtYXRlcmlhbCBub3dcbiAqIGJlbG9uZ3MgaW4gdGhlIGN1c3RvbWVyJ3MgaG9tZSwgYW5kIGEgY29weSBsZWZ0IGluIHRoZSBvbGQgaG9tZSBpcyBhIGNyZWRlbnRpYWwgbm8gcmV2b2tlIHdvdWxkXG4gKiBldmVyIHJlYWNoLiBUaGUgY29uc3VtZXIgdGhlcmVmb3JlIHN0aWxsIHJlY29nbml6ZXMgYW4gYWN0aXZlIHJlY29yZCBuYW1pbmcgYSBsZWdhY3kgaG9tZSAoYXMgYVxuICogbWlncmF0aW9uLCBub3QgYSB0YW1wZXJlZCByZWNvcmQpIGFuZCByZW1vdmVzIHRoZSBtYW5hZ2VkIG5hdGl2ZSBmaWxlcyBpdCBmaW5kcyB0aGVyZS5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBXb3Jrc3BhY2VIb3N0QWdlbnRIb21lTGVnYWN5SG9tZSB7XG4gIHJlYWRvbmx5IGhvbWU6IHN0cmluZztcbn1cblxuZXhwb3J0IGludGVyZmFjZSBXb3Jrc3BhY2VIb3N0QWdlbnRIb21lQ29uc3VtZXJPcHRpb25zIHtcbiAgcmVhZG9ubHkgZmlsZXN5c3RlbTogV29ya3NwYWNlSG9zdEFnZW50SG9tZUZpbGVzeXN0ZW07XG4gIHJlYWRvbmx5IG1hdGVyaWFsUm9vdDogc3RyaW5nO1xuICAvKipcbiAgICogSG9tZSBvZiB0aGUgaWRlbnRpdHkgdGhhdCBSVU5TIHRoZSBjdXN0b21lci1kcml2ZW4gYWdlbnRzLCBhbmQgdGhlIG93bmVyIG9mIHRoZSBkZWxpdmVyZWRcbiAgICogbWF0ZXJpYWwuIFNpbmNlIEQtNDIxIHRoYXQgaXMgdGhlIGN1c3RvbWVyIHdvcmtzcGFjZSBhY2NvdW50LCB0aGUgb25lIGlkZW50aXR5IEQtMDQzIGtlZXBzXG4gICAqIGF3YXkgZnJvbSB0aGUgUGFwZXJjdXNwIHJ1bnRpbWU7IGJldHdlZW4gRC0yNDggYW5kIEQtNDIxIGl0IHdhcyBgcGFwZXJjdXNwLWFnZW50YC5cbiAgICpcbiAgICogVGhlIGZpZWxkIGtlZXBzIHRoZSBgYWdlbnRgIG5hbWUgb24gcHVycG9zZTogaXQgbmFtZXMgdGhlIFJPTEUgKHdob2V2ZXIgcnVucyB0aGUgYWdlbnRzKSwgc28gYVxuICAgKiBjYWxsZXIgaGFzIHRvIGRlY2lkZSB3aGljaCBhY2NvdW50IHBsYXlzIGl0IHJhdGhlciB0aGFuIGluaGVyaXQgb25lIGZyb20gYSBmaWVsZCBuYW1lLlxuICAgKi9cbiAgcmVhZG9ubHkgYWdlbnRIb21lOiBzdHJpbmc7XG4gIHJlYWRvbmx5IGFnZW50VXNlcj86IHN0cmluZztcbiAgcmVhZG9ubHkgYWdlbnRHcm91cD86IHN0cmluZztcbiAgLyoqIEhvbWVzIGVhcmxpZXIgcmVsZWFzZXMgaW5zdGFsbGVkIGludG87IGFuIGFjdGl2ZSByZWNvcmQgbmFtaW5nIG9uZSBpcyBtaWdyYXRlZCwgbmV2ZXIgdHJ1c3RlZC4gKi9cbiAgcmVhZG9ubHkgbGVnYWN5SG9tZXM/OiByZWFkb25seSBXb3Jrc3BhY2VIb3N0QWdlbnRIb21lTGVnYWN5SG9tZVtdO1xufVxuXG4vKiogVGhlIGFjdGl2ZSByZWNvcmQsIG1hcmtlZCB3aGVuIGl0IHN0aWxsIG5hbWVzIGEgaG9tZSB0aGlzIGNvbnN1bWVyIG9ubHkgbWlncmF0ZXMgYXdheSBmcm9tLiAqL1xudHlwZSBXb3Jrc3BhY2VIb3N0QWdlbnRIb21lQWN0aXZlU3RhdGUgPSBXb3Jrc3BhY2VIb3N0QWdlbnRIb21lU3RhdGUgJiB7XG4gIHJlYWRvbmx5IGxlZ2FjeTogYm9vbGVhbjtcbn07XG5cbmV4cG9ydCBpbnRlcmZhY2UgV29ya3NwYWNlSG9zdEFnZW50SG9tZUNvbnN1bWVyRXZpZGVuY2Uge1xuICByZWFkb25seSBmYW1pbHk6IFdvcmtzcGFjZUhvc3RBZ2VudEhvbWVGYW1pbHk7XG4gIHJlYWRvbmx5IGdlbmVyYXRpb246IG51bWJlcjtcbiAgcmVhZG9ubHkgcHJlc2VudDogYm9vbGVhbjtcbiAgcmVhZG9ubHkgaG9tZTogc3RyaW5nO1xufVxuXG5mdW5jdGlvbiBjb21wYXJlQnl0ZXMobGVmdDogQnVmZmVyLCByaWdodDogQnVmZmVyKTogYm9vbGVhbiB7XG4gIHJldHVybiAoXG4gICAgbGVmdC5sZW5ndGggPT09IHJpZ2h0Lmxlbmd0aCAmJlxuICAgIGxlZnQuZXZlcnkoKHZhbHVlLCBpbmRleCkgPT4gdmFsdWUgPT09IHJpZ2h0W2luZGV4XSlcbiAgKTtcbn1cblxuLyoqXG4gKiBJbnN0YWxscyBhbmQgdmVyaWZpZXMgdGhlIG1hbmFnZWQgbmF0aXZlIGFnZW50IGNyZWRlbnRpYWwgZmlsZXMgZnJvbSBkZWxpdmVyZWQgbWF0ZXJpYWwuXG4gKlxuICogQSB2MiBidW5kbGUgbWF5IGV4cGxpY2l0bHkgbmFtZSBPTVAgYXMgY3JlZGVudGlhbC1mcmVlIChgZmlsZXMub21wOiBudWxsYCkuIEluIHRoYXQgY2FzZSB0aGVcbiAqIGNvbnN1bWVyIHBvc2l0aXZlbHkgcmVtb3ZlcyBhbmQgdmVyaWZpZXMgYWJzZW5jZSBvZiBgLm9tcC9hZ2VudC9hdXRoLmpzb25gOyB0aGUgc2VwYXJhdGUgRC0yMzBcbiAqIHJlYWRpbmVzcyBwcm9iZSBtdXN0IHByb3ZlIHJlYWwgbG9jYWwgaW5mZXJlbmNlLiBDbGF1ZGUgYW5kIENvZGV4IHJlbWFpbiBtYW5kYXRvcnkgbWF0ZXJpYWwuXG4gKlxuICogVGhlIGFjdGl2ZSByZWNvcmQgaXMgY29tbWl0dGVkIExBU1QuIEEgZnJlc2ggaW5pdGlhbGl6ZXIgcHJvY2VzcyB0aGVyZWZvcmUgc2VlcyBlaXRoZXIgdGhlXG4gKiBwcmV2aW91cyBjb21wbGV0ZSBnZW5lcmF0aW9uIG9yIHRoZSBuZXcgY29tcGxldGUgZ2VuZXJhdGlvbiwgbmV2ZXIgYSBwcm9jZXNzLWxvY2FsIGhhbGYtc3RhdGUuXG4gKiBHZW5lcmF0aW9uIGNoZWNrcyBtYWtlIGFuIG9sZCByZXZva2UgaGFybWxlc3MgYWZ0ZXIgYSBuZXdlciByb3RhdGlvbiBoYXMgd29uIHRoZSByYWNlLlxuICovXG5leHBvcnQgY2xhc3MgV29ya3NwYWNlSG9zdEFnZW50SG9tZUNvbnN1bWVyIHtcbiAgcHJpdmF0ZSByZWFkb25seSBmaWxlc3lzdGVtOiBXb3Jrc3BhY2VIb3N0QWdlbnRIb21lRmlsZXN5c3RlbTtcbiAgcHJpdmF0ZSByZWFkb25seSBtYXRlcmlhbFJvb3Q6IHN0cmluZztcbiAgcHJpdmF0ZSByZWFkb25seSBhZ2VudEhvbWU6IHN0cmluZztcbiAgcHJpdmF0ZSByZWFkb25seSBhZ2VudFVzZXI/OiBzdHJpbmc7XG4gIHByaXZhdGUgcmVhZG9ubHkgYWdlbnRHcm91cD86IHN0cmluZztcbiAgcHJpdmF0ZSByZWFkb25seSBsZWdhY3lIb21lczogcmVhZG9ubHkgc3RyaW5nW107XG5cbiAgY29uc3RydWN0b3Iob3B0aW9uczogV29ya3NwYWNlSG9zdEFnZW50SG9tZUNvbnN1bWVyT3B0aW9ucykge1xuICAgIHRoaXMuZmlsZXN5c3RlbSA9IG9wdGlvbnMuZmlsZXN5c3RlbTtcbiAgICB0aGlzLm1hdGVyaWFsUm9vdCA9IG9wdGlvbnMubWF0ZXJpYWxSb290O1xuICAgIHRoaXMuYWdlbnRIb21lID0gcmVxdWlyZUV4cGxpY2l0V29ya3NwYWNlSG9zdEhvbWUob3B0aW9ucy5hZ2VudEhvbWUpO1xuICAgIGlmIChcbiAgICAgIChvcHRpb25zLmFnZW50VXNlciAmJiAhb3B0aW9ucy5hZ2VudEdyb3VwKSB8fFxuICAgICAgKCFvcHRpb25zLmFnZW50VXNlciAmJiBvcHRpb25zLmFnZW50R3JvdXApXG4gICAgKSB7XG4gICAgICB0aHJvdyBuZXcgV29ya3NwYWNlSG9zdEFnZW50SG9tZUJ1bmRsZUVycm9yKFxuICAgICAgICBcImFnZW50VXNlciBhbmQgYWdlbnRHcm91cCBtdXN0IGJlIHN1cHBsaWVkIHRvZ2V0aGVyXCIsXG4gICAgICApO1xuICAgIH1cbiAgICB0aGlzLmFnZW50VXNlciA9IG9wdGlvbnMuYWdlbnRVc2VyO1xuICAgIHRoaXMuYWdlbnRHcm91cCA9IG9wdGlvbnMuYWdlbnRHcm91cDtcbiAgICB0aGlzLmxlZ2FjeUhvbWVzID0gKG9wdGlvbnMubGVnYWN5SG9tZXMgPz8gW10pLm1hcCgobGVnYWN5KSA9PiB7XG4gICAgICBjb25zdCBob21lID0gcmVxdWlyZUV4cGxpY2l0V29ya3NwYWNlSG9zdEhvbWUobGVnYWN5LmhvbWUpO1xuICAgICAgaWYgKGhvbWUgPT09IHRoaXMuYWdlbnRIb21lKSB7XG4gICAgICAgIHRocm93IG5ldyBXb3Jrc3BhY2VIb3N0QWdlbnRIb21lQnVuZGxlRXJyb3IoXG4gICAgICAgICAgXCJhIGxlZ2FjeSBhZ2VudCBob21lIGNhbm5vdCBiZSB0aGUgaG9tZSB0aGlzIGNvbnN1bWVyIGluc3RhbGxzIGludG9cIixcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIHJldHVybiBob21lO1xuICAgIH0pO1xuICB9XG5cbiAgcHJpdmF0ZSBhc3luYyByZWFkU3RhdGUoKTogUHJvbWlzZTxXb3Jrc3BhY2VIb3N0QWdlbnRIb21lQWN0aXZlU3RhdGUgfCBudWxsPiB7XG4gICAgY29uc3QgcmF3ID0gYXdhaXQgdGhpcy5maWxlc3lzdGVtLnJlYWRGaWxlSWZQcmVzZW50KFxuICAgICAgd29ya3NwYWNlSG9zdEFnZW50SG9tZVN0YXRlUGF0aCh0aGlzLm1hdGVyaWFsUm9vdCksXG4gICAgKTtcbiAgICBpZiAocmF3ID09PSBudWxsKSByZXR1cm4gbnVsbDtcbiAgICBjb25zdCBzdGF0ZSA9IHBhcnNlV29ya3NwYWNlSG9zdEFnZW50SG9tZVN0YXRlKHJhdyk7XG4gICAgaWYgKHN0YXRlLmhvbWUgPT09IHRoaXMuYWdlbnRIb21lKSByZXR1cm4geyAuLi5zdGF0ZSwgbGVnYWN5OiBmYWxzZSB9O1xuICAgIC8vIEEgcmVjb3JkIGZyb20gYSByZWxlYXNlIHRoYXQgaW5zdGFsbGVkIGludG8gYW4gZWFybGllciBob21lIGlzIGEgbWlncmF0aW9uIHRvIHBlcmZvcm0sIG5vdFxuICAgIC8vIGEgcmVkaXJlY3QgdG8gZm9sbG93OiB0aGUgY29uc3VtZXIgbmV2ZXIgd3JpdGVzIHRoZXJlIGFnYWluLCBpdCBvbmx5IHJlbW92ZXMgd2hhdCBpdCBsZWZ0LlxuICAgIGlmICh0aGlzLmxlZ2FjeUhvbWVzLmluY2x1ZGVzKHN0YXRlLmhvbWUpKSByZXR1cm4geyAuLi5zdGF0ZSwgbGVnYWN5OiB0cnVlIH07XG4gICAgdGhyb3cgbmV3IFdvcmtzcGFjZUhvc3RBZ2VudEhvbWVTdGF0ZUVycm9yKFxuICAgICAgXCJhY3RpdmUgYWdlbnQtaG9tZSBzdGF0ZSBuYW1lcyBhIGRpZmZlcmVudCBhZ2VudCBob21lXCIsXG4gICAgICB7IGZhbWlseTogc3RhdGUuZmFtaWx5LCBnZW5lcmF0aW9uOiBzdGF0ZS5nZW5lcmF0aW9uIH0sXG4gICAgKTtcbiAgfVxuXG4gIC8qKlxuICAgKiBSZW1vdmUgZXZlcnkgbWFuYWdlZCBuYXRpdmUgY3JlZGVudGlhbCBmaWxlIGZyb20gZWFjaCBsZWdhY3kgaG9tZSAoRC00MjEgbWlncmF0aW9uKS5cbiAgICpcbiAgICogUnVucyBvbiBldmVyeSBpbnN0YWxsIGFuZCByZXZva2UsIG5vdCBvbmx5IHdoZW4gdGhlIGFjdGl2ZSByZWNvcmQgbmFtZXMgYSBsZWdhY3kgaG9tZTogYW5cbiAgICogaW5zdGFsbCB0aGF0IGNvbW1pdHRlZCBpdHMgbmV3IHJlY29yZCBhbmQgdGhlbiBkaWVkIGJlZm9yZSB0aGlzIHN3ZWVwIHdvdWxkIG90aGVyd2lzZSBsZWF2ZSBhXG4gICAqIGNvcHkgdGhhdCBubyBsYXRlciBvcGVyYXRpb24gbG9va3MgZm9yLiBSZW1vdmFsIGlzIGlkZW1wb3RlbnQgYW5kIG5ldmVyIGNyZWF0ZXMgYW55dGhpbmcgaW5cbiAgICogdGhlIGxlZ2FjeSBob21lIOKAlCBhIGhvbWUgdGhhdCBpcyBhYnNlbnQsIG9yIGEgY3JlZGVudGlhbCBkaXJlY3RvcnkgdGhhdCBpcyBhYnNlbnQsIGlzIGFscmVhZHlcbiAgICogY2xlYW4uIFBhcmVudHMgYXJlIGxzdGF0LWNoZWNrZWQgc28gYSBzeW1saW5rZWQgY3JlZGVudGlhbCBkaXJlY3RvcnkgY2Fubm90IHN0ZWVyIHRoZSByb290XG4gICAqIGNvbnN1bWVyJ3MgdW5saW5rIGludG8gYW5vdGhlciBhY2NvdW50J3MgZmlsZXMuXG4gICAqL1xuICBwcml2YXRlIGFzeW5jIHN3ZWVwTGVnYWN5SG9tZXMoXG4gICAgZmFtaWx5OiBXb3Jrc3BhY2VIb3N0QWdlbnRIb21lRmFtaWx5LFxuICAgIGdlbmVyYXRpb246IG51bWJlcixcbiAgKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgZm9yIChjb25zdCBob21lIG9mIHRoaXMubGVnYWN5SG9tZXMpIHtcbiAgICAgIGNvbnN0IHBhdGhzID0gd29ya3NwYWNlSG9zdEFnZW50SG9tZVBhdGhzKGhvbWUpO1xuICAgICAgZm9yIChjb25zdCBwYXRoIG9mIE9iamVjdC52YWx1ZXMocGF0aHMpKSB7XG4gICAgICAgIGlmICh0aGlzLmZpbGVzeXN0ZW0ucGF0aEtpbmQpIHtcbiAgICAgICAgICBsZXQgcGFyZW50TWlzc2luZyA9IGZhbHNlO1xuICAgICAgICAgIGZvciAoY29uc3QgZGlyZWN0b3J5IG9mIHdvcmtzcGFjZUhvc3RBZ2VudEhvbWVEaXJlY3Rvcmllcyhob21lKSkge1xuICAgICAgICAgICAgaWYgKCFwYXRoLnN0YXJ0c1dpdGgoYCR7ZGlyZWN0b3J5fS9gKSkgY29udGludWU7XG4gICAgICAgICAgICBjb25zdCBraW5kID0gYXdhaXQgdGhpcy5maWxlc3lzdGVtLnBhdGhLaW5kKGRpcmVjdG9yeSk7XG4gICAgICAgICAgICBpZiAoa2luZCA9PT0gXCJtaXNzaW5nXCIpIHtcbiAgICAgICAgICAgICAgcGFyZW50TWlzc2luZyA9IHRydWU7XG4gICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKGtpbmQgIT09IFwiZGlyZWN0b3J5XCIpIHtcbiAgICAgICAgICAgICAgdGhyb3cgbmV3IFdvcmtzcGFjZUhvc3RBZ2VudEhvbWVTdGF0ZUVycm9yKFxuICAgICAgICAgICAgICAgIGBsZWdhY3kgYWdlbnQtaG9tZSBkaXJlY3RvcnkgJyR7ZGlyZWN0b3J5fScgaXMgbm90IGEgcmVhbCBkaXJlY3RvcnlgLFxuICAgICAgICAgICAgICAgIHsgZmFtaWx5LCBnZW5lcmF0aW9uIH0sXG4gICAgICAgICAgICAgICk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfVxuICAgICAgICAgIGlmIChwYXJlbnRNaXNzaW5nKSBjb250aW51ZTtcbiAgICAgICAgfVxuICAgICAgICBhd2FpdCB0aGlzLnJlbW92ZU5hdGl2ZUZpbGUocGF0aCwgZmFtaWx5LCBnZW5lcmF0aW9uKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBwcml2YXRlIGFzeW5jIG93bihwYXRoOiBzdHJpbmcpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBpZiAodGhpcy5hZ2VudFVzZXIgJiYgdGhpcy5hZ2VudEdyb3VwICYmIHRoaXMuZmlsZXN5c3RlbS5zZXRPd25lcnNoaXApIHtcbiAgICAgIGF3YWl0IHRoaXMuZmlsZXN5c3RlbS5zZXRPd25lcnNoaXAocGF0aCwgdGhpcy5hZ2VudFVzZXIsIHRoaXMuYWdlbnRHcm91cCk7XG4gICAgfVxuICB9XG5cbiAgcHJpdmF0ZSBhc3luYyByZXF1aXJlUmVhbERpcmVjdG9yeShkaXJlY3Rvcnk6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xuICAgIGlmICghdGhpcy5maWxlc3lzdGVtLnBhdGhLaW5kKSByZXR1cm47XG4gICAgY29uc3Qga2luZCA9IGF3YWl0IHRoaXMuZmlsZXN5c3RlbS5wYXRoS2luZChkaXJlY3RvcnkpO1xuICAgIGlmIChraW5kICE9PSBcImRpcmVjdG9yeVwiKSB7XG4gICAgICB0aHJvdyBuZXcgV29ya3NwYWNlSG9zdEFnZW50SG9tZVN0YXRlRXJyb3IoXG4gICAgICAgIGB3b3Jrc3BhY2UgYWdlbnQtaG9tZSBkaXJlY3RvcnkgJyR7ZGlyZWN0b3J5fScgaXMgbm90IGEgcmVhbCBkaXJlY3RvcnlgLFxuICAgICAgKTtcbiAgICB9XG4gIH1cblxuICAvKipcbiAgICogVGVtcG9yYXJpbHkgbWFrZSB0aGUgaG9tZSBhbmQgY3JlZGVudGlhbCBkaXJlY3RvcmllcyByb290LW93bmVkIHdoaWxlIHRoZSByb290IGNvbnN1bWVyXG4gICAqIHdyaXRlcy4gVGhpcyBjbG9zZXMgdGhlIGNoZWNrL3dyaXRlIHN5bWxpbmsgcmFjZTogdGhlIHdvcmtzcGFjZSB1c2VyIGNhbm5vdCBzd2FwIGEgdmFsaWRhdGVkXG4gICAqIHBhcmVudCBvdXQgZnJvbSB1bmRlciB0aGUgc3Vic2VxdWVudCBhdG9taWMgcmVuYW1lLiBGaW5hbCBvd25lcnNoaXAgaXMgcmVzdG9yZWQgaW4gcmV2ZXJzZVxuICAgKiBvcmRlciB3aXRoIHRoZSBob21lIGxhc3QsIHNvIHRoZSBzdGVhZHkgc3RhdGUgcmVtYWlucyBhIG5vcm1hbCB1c2VyLW93bmVkIDA3MDAgbmF0aXZlIGhvbWUuXG4gICAqL1xuICBwcml2YXRlIGFzeW5jIHNlY3VyZUhvbWVMYXlvdXQoKTogUHJvbWlzZTxyZWFkb25seSBzdHJpbmdbXT4ge1xuICAgIGNvbnN0IGRpcmVjdG9yaWVzID0gd29ya3NwYWNlSG9zdEFnZW50SG9tZURpcmVjdG9yaWVzKHRoaXMuYWdlbnRIb21lKTtcbiAgICBjb25zdCBzZWN1cmVkOiBzdHJpbmdbXSA9IFtdO1xuICAgIHRyeSB7XG4gICAgICBmb3IgKGNvbnN0IGRpcmVjdG9yeSBvZiBkaXJlY3Rvcmllcykge1xuICAgICAgICBhd2FpdCB0aGlzLmZpbGVzeXN0ZW0uZW5zdXJlRGlyZWN0b3J5KGRpcmVjdG9yeSk7XG4gICAgICAgIGF3YWl0IHRoaXMucmVxdWlyZVJlYWxEaXJlY3RvcnkoZGlyZWN0b3J5KTtcbiAgICAgICAgaWYgKHRoaXMuYWdlbnRVc2VyICYmIHRoaXMuYWdlbnRHcm91cCAmJiB0aGlzLmZpbGVzeXN0ZW0uc2V0T3duZXJzaGlwKSB7XG4gICAgICAgICAgYXdhaXQgdGhpcy5maWxlc3lzdGVtLnNldE93bmVyc2hpcChkaXJlY3RvcnksIFwicm9vdFwiLCBcInJvb3RcIik7XG4gICAgICAgIH1cbiAgICAgICAgc2VjdXJlZC5wdXNoKGRpcmVjdG9yeSk7XG4gICAgICB9XG4gICAgICByZXR1cm4gc2VjdXJlZDtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgYXdhaXQgdGhpcy5yZXN0b3JlSG9tZUxheW91dChzZWN1cmVkKS5jYXRjaCgoKSA9PiB1bmRlZmluZWQpO1xuICAgICAgdGhyb3cgZXJyb3I7XG4gICAgfVxuICB9XG5cbiAgcHJpdmF0ZSBhc3luYyByZXN0b3JlSG9tZUxheW91dChcbiAgICBkaXJlY3RvcmllczogcmVhZG9ubHkgc3RyaW5nW10sXG4gICAgZmlsZXM6IHJlYWRvbmx5IHN0cmluZ1tdID0gW10sXG4gICk6IFByb21pc2U8dm9pZD4ge1xuICAgIC8vIFJlc3RvcmUgY2hpbGRyZW4gZmlyc3QgYW5kIHRoZSBob21lIGxhc3QuIFVudGlsIHRoZSBmaW5hbCBjaG93biB0aGUgd29ya3NwYWNlIHVzZXIgY2Fubm90XG4gICAgLy8gcmVuYW1lIGEgdmFsaWRhdGVkIGNoaWxkIGludG8gYSBzeW1saW5rIHRocm91Z2ggaXRzIHBhcmVudC5cbiAgICBmb3IgKGNvbnN0IHBhdGggb2YgZmlsZXMpIGF3YWl0IHRoaXMub3duKHBhdGgpO1xuICAgIGZvciAoY29uc3QgZGlyZWN0b3J5IG9mIFsuLi5kaXJlY3Rvcmllc10ucmV2ZXJzZSgpKVxuICAgICAgYXdhaXQgdGhpcy5vd24oZGlyZWN0b3J5KTtcbiAgfVxuXG4gIC8qKlxuICAgKiBSZWNvbmNpbGUgdGhlIG5vbi1zZWNyZXQgT01QIHJlZ2lzdHJ5IHJlcXVpcmVkIGJ5IHRoZSBjcmVkZW50aWFsLWZyZWUgbG9jYWwtaW5mZXJlbmNlIHBhdGguXG4gICAqXG4gICAqIFRoZSBhZ2VudCBob21lIGlzIGEgcGxhdGZvcm0tb3duZWQgaWRlbnRpdHkgaG9tZSwgc28gdGhpcyBtYW5hZ2VkIHJlZ2lzdHJ5IGlzIGRlbGliZXJhdGVseVxuICAgKiBkZXRlcm1pbmlzdGljIHJhdGhlciB0aGFuIG1lcmdlZCB3aXRoIGFuIGFtYmllbnQgc2VydmljZS11c2VyIGNvbmZpZy4gIEEgc3RhbGUgZ2F0ZXdheSBvclxuICAgKiBtYWxmb3JtZWQgcmVnaXN0cnkgd291bGQgb3RoZXJ3aXNlIG1ha2UgdGhlIHJlYWRpbmVzcyBwcm9iZSBzZWxlY3QgdGhlIHdyb25nIGVuZHBvaW50IHdoaWxlXG4gICAqIHN0aWxsIGxvb2tpbmcgbGlrZSBhIHZhbGlkIE9NUCBpbnN0YWxsYXRpb24uICBUaGUgd3JpdGUgaXMgaWRlbXBvdGVudCBhbmQgaXMgcGVyZm9ybWVkIHdoaWxlXG4gICAqIHNlY3VyZUhvbWVMYXlvdXQoKSBoYXMgcGlubmVkIGV2ZXJ5IHBhcmVudCBkaXJlY3Rvcnkgcm9vdC1vd25lZC5cbiAgICovXG4gIHByaXZhdGUgYXN5bmMgZW5zdXJlTG9jYWxPbXBNb2RlbHNDb25maWcoXG4gICAgZmFtaWx5OiBXb3Jrc3BhY2VIb3N0QWdlbnRIb21lRmFtaWx5LFxuICAgIGdlbmVyYXRpb246IG51bWJlcixcbiAgKTogUHJvbWlzZTxzdHJpbmc+IHtcbiAgICBjb25zdCBwYXRoID0gd29ya3NwYWNlSG9zdEFnZW50SG9tZU9tcE1vZGVsc1BhdGgodGhpcy5hZ2VudEhvbWUpO1xuICAgIGNvbnN0IGV4cGVjdGVkID0gQnVmZmVyLmZyb20oXG4gICAgICBXT1JLU1BBQ0VfSE9TVF9BR0VOVF9IT01FX09NUF9MT0NBTF9NT0RFTFNfWU1MLFxuICAgICAgXCJ1dGY4XCIsXG4gICAgKTtcbiAgICBsZXQga2luZDogXCJtaXNzaW5nXCIgfCBcImRpcmVjdG9yeVwiIHwgXCJmaWxlXCIgfCBcInN5bWxpbmtcIiB8IFwib3RoZXJcIiA9XG4gICAgICBcIm1pc3NpbmdcIjtcbiAgICBpZiAodGhpcy5maWxlc3lzdGVtLnBhdGhLaW5kKSB7XG4gICAgICBraW5kID0gYXdhaXQgdGhpcy5maWxlc3lzdGVtLnBhdGhLaW5kKHBhdGgpO1xuICAgICAgaWYgKGtpbmQgIT09IFwibWlzc2luZ1wiICYmIGtpbmQgIT09IFwiZmlsZVwiKSB7XG4gICAgICAgIHRocm93IG5ldyBXb3Jrc3BhY2VIb3N0QWdlbnRIb21lU3RhdGVFcnJvcihcbiAgICAgICAgICBcIndvcmtzcGFjZSBhZ2VudC1ob21lIE9NUCBtb2RlbHMgcmVnaXN0cnkgaXMgbm90IGEgcmVndWxhciBmaWxlXCIsXG4gICAgICAgICAgeyBmYW1pbHksIGdlbmVyYXRpb24gfSxcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICB9XG4gICAgLy8gV2hlbiBwYXRoS2luZCBpcyB1bmF2YWlsYWJsZSAodGhlIGhlcm1ldGljIHNlYW0pLCByZWFkRmlsZUlmUHJlc2VudCBpcyB0aGUgb25seSBwcmVzZW5jZVxuICAgIC8vIHNpZ25hbDsgZG8gbm90IHRyZWF0IGl0cyBkZWZhdWx0IGBtaXNzaW5nYCBzZW50aW5lbCBhcyBwcm9vZiB0aGF0IGEgZmlsZSBpcyBhYnNlbnQgb3IgdGhlXG4gICAgLy8gaWRlbXBvdGVudCBwYXRoIHdvdWxkIHJld3JpdGUgdGhlIHJlZ2lzdHJ5IG9uIGV2ZXJ5IGJpbmQuXG4gICAgY29uc3QgZXhpc3RpbmcgPVxuICAgICAga2luZCA9PT0gXCJtaXNzaW5nXCIgJiYgdGhpcy5maWxlc3lzdGVtLnBhdGhLaW5kXG4gICAgICAgID8gbnVsbFxuICAgICAgICA6IGF3YWl0IHRoaXMuZmlsZXN5c3RlbS5yZWFkRmlsZUlmUHJlc2VudChwYXRoKTtcbiAgICBpZiAoZXhpc3RpbmcgPT09IG51bGwgfHwgIWNvbXBhcmVCeXRlcyhleGlzdGluZywgZXhwZWN0ZWQpKSB7XG4gICAgICBhd2FpdCB0aGlzLmZpbGVzeXN0ZW0ud3JpdGVQcml2YXRlRmlsZShwYXRoLCBleHBlY3RlZCk7XG4gICAgfVxuICAgIGlmICh0aGlzLmZpbGVzeXN0ZW0ucGF0aEtpbmQpIHtcbiAgICAgIGNvbnN0IGZpbmFsS2luZCA9IGF3YWl0IHRoaXMuZmlsZXN5c3RlbS5wYXRoS2luZChwYXRoKTtcbiAgICAgIGlmIChmaW5hbEtpbmQgIT09IFwiZmlsZVwiKSB7XG4gICAgICAgIHRocm93IG5ldyBXb3Jrc3BhY2VIb3N0QWdlbnRIb21lU3RhdGVFcnJvcihcbiAgICAgICAgICBcIndvcmtzcGFjZSBhZ2VudC1ob21lIE9NUCBtb2RlbHMgcmVnaXN0cnkgaXMgbm90IGEgcmVndWxhciBmaWxlIGFmdGVyIHdyaXRlXCIsXG4gICAgICAgICAgeyBmYW1pbHksIGdlbmVyYXRpb24gfSxcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIHBhdGg7XG4gIH1cblxuICBwcml2YXRlIGFzeW5jIHZlcmlmeUxvY2FsT21wTW9kZWxzQ29uZmlnKFxuICAgIGZhbWlseTogV29ya3NwYWNlSG9zdEFnZW50SG9tZUZhbWlseSxcbiAgICBnZW5lcmF0aW9uOiBudW1iZXIsXG4gICk6IFByb21pc2U8dm9pZD4ge1xuICAgIGNvbnN0IHBhdGggPSB3b3Jrc3BhY2VIb3N0QWdlbnRIb21lT21wTW9kZWxzUGF0aCh0aGlzLmFnZW50SG9tZSk7XG4gICAgaWYgKHRoaXMuZmlsZXN5c3RlbS5wYXRoS2luZCkge1xuICAgICAgY29uc3Qga2luZCA9IGF3YWl0IHRoaXMuZmlsZXN5c3RlbS5wYXRoS2luZChwYXRoKTtcbiAgICAgIGlmIChraW5kICE9PSBcImZpbGVcIikge1xuICAgICAgICB0aHJvdyBuZXcgV29ya3NwYWNlSG9zdEFnZW50SG9tZVN0YXRlRXJyb3IoXG4gICAgICAgICAgXCJ3b3Jrc3BhY2UgYWdlbnQtaG9tZSBPTVAgbW9kZWxzIHJlZ2lzdHJ5IGlzIGFic2VudCBvciBub3QgYSByZWd1bGFyIGZpbGVcIixcbiAgICAgICAgICB7IGZhbWlseSwgZ2VuZXJhdGlvbiB9LFxuICAgICAgICApO1xuICAgICAgfVxuICAgIH1cbiAgICBjb25zdCBleGlzdGluZyA9IGF3YWl0IHRoaXMuZmlsZXN5c3RlbS5yZWFkRmlsZUlmUHJlc2VudChwYXRoKTtcbiAgICBpZiAoXG4gICAgICBleGlzdGluZyA9PT0gbnVsbCB8fFxuICAgICAgIWNvbXBhcmVCeXRlcyhcbiAgICAgICAgZXhpc3RpbmcsXG4gICAgICAgIEJ1ZmZlci5mcm9tKFdPUktTUEFDRV9IT1NUX0FHRU5UX0hPTUVfT01QX0xPQ0FMX01PREVMU19ZTUwsIFwidXRmOFwiKSxcbiAgICAgIClcbiAgICApIHtcbiAgICAgIHRocm93IG5ldyBXb3Jrc3BhY2VIb3N0QWdlbnRIb21lU3RhdGVFcnJvcihcbiAgICAgICAgXCJ3b3Jrc3BhY2UgYWdlbnQtaG9tZSBPTVAgbW9kZWxzIHJlZ2lzdHJ5IGlzIGFic2VudCBvciBzdGFsZVwiLFxuICAgICAgICB7IGZhbWlseSwgZ2VuZXJhdGlvbiB9LFxuICAgICAgKTtcbiAgICB9XG4gIH1cblxuICBwcml2YXRlIGxvY2tQYXRoKGZhbWlseTogV29ya3NwYWNlSG9zdEFnZW50SG9tZUZhbWlseSk6IHN0cmluZyB7XG4gICAgLy8gQm90aCBhZ2VudCBmYW1pbGllcyBpbnN0YWxsIHRoZSBzYW1lIG5hdGl2ZSBmaWxlcyBhbmQgYWN0aXZlIG1hcmtlci4gVGhleSBtdXN0IHRoZXJlZm9yZVxuICAgIC8vIHNlcmlhbGl6ZSBhZ2FpbnN0IG9uZSBhbm90aGVyIGV2ZW4gdGhvdWdoIHRoZWlyIGRlbGl2ZXJlZC1tYXRlcmlhbCBkaXJlY3RvcmllcyBkaWZmZXIuXG4gICAgcmV0dXJuIHdvcmtzcGFjZUhvc3RBZ2VudEhvbWVMb2NrUGF0aCh0aGlzLm1hdGVyaWFsUm9vdCk7XG4gIH1cblxuICBwcml2YXRlIGFzeW5jIHdpdGhMb2NrPFQ+KFxuICAgIGZhbWlseTogV29ya3NwYWNlSG9zdEFnZW50SG9tZUZhbWlseSxcbiAgICB0YXNrOiAoKSA9PiBQcm9taXNlPFQ+LFxuICAgIGxvY2tIZWxkID0gZmFsc2UsXG4gICk6IFByb21pc2U8VD4ge1xuICAgIGlmIChsb2NrSGVsZCkgcmV0dXJuIGF3YWl0IHRhc2soKTtcbiAgICByZXR1cm4gYXdhaXQgd2l0aFdvcmtzcGFjZUhvc3RDcmVkZW50aWFsRmlsZXN5c3RlbUxvY2soXG4gICAgICB0aGlzLmZpbGVzeXN0ZW0sXG4gICAgICB0aGlzLmxvY2tQYXRoKGZhbWlseSksXG4gICAgICB0YXNrLFxuICAgICk7XG4gIH1cblxuICBwcml2YXRlIGFzeW5jIGluc3RhbGxVbmxvY2tlZChcbiAgICBmYW1pbHk6IFdvcmtzcGFjZUhvc3RBZ2VudEhvbWVGYW1pbHksXG4gICAgZ2VuZXJhdGlvbjogbnVtYmVyLFxuICAgIG1hdGVyaWFsOiBCdWZmZXIsXG4gICk6IFByb21pc2U8V29ya3NwYWNlSG9zdEFnZW50SG9tZUNvbnN1bWVyRXZpZGVuY2U+IHtcbiAgICBpZiAoIVdPUktTUEFDRV9IT1NUX0FHRU5UX0hPTUVfRkFNSUxJRVMuaW5jbHVkZXMoZmFtaWx5KSkge1xuICAgICAgdGhyb3cgbmV3IFdvcmtzcGFjZUhvc3RBZ2VudEhvbWVTdGF0ZUVycm9yKFxuICAgICAgICBgdW5zdXBwb3J0ZWQgYWdlbnQtaG9tZSBmYW1pbHkgJyR7ZmFtaWx5fSdgLFxuICAgICAgKTtcbiAgICB9XG4gICAgaWYgKCFOdW1iZXIuaXNTYWZlSW50ZWdlcihnZW5lcmF0aW9uKSB8fCBnZW5lcmF0aW9uIDwgMSkge1xuICAgICAgdGhyb3cgbmV3IFdvcmtzcGFjZUhvc3RBZ2VudEhvbWVTdGF0ZUVycm9yKFxuICAgICAgICBcImFnZW50LWhvbWUgZ2VuZXJhdGlvbiBtdXN0IGJlIGEgcG9zaXRpdmUgc2FmZSBpbnRlZ2VyXCIsXG4gICAgICApO1xuICAgIH1cbiAgICBjb25zdCBidW5kbGUgPSBwYXJzZVdvcmtzcGFjZUhvc3RBZ2VudEhvbWVCdW5kbGUobWF0ZXJpYWwpO1xuICAgIGNvbnN0IGN1cnJlbnQgPSBhd2FpdCB0aGlzLnJlYWRTdGF0ZSgpO1xuICAgIGlmIChjdXJyZW50ICYmIGN1cnJlbnQuZ2VuZXJhdGlvbiA+IGdlbmVyYXRpb24pIHtcbiAgICAgIHRocm93IG5ldyBXb3Jrc3BhY2VIb3N0QWdlbnRIb21lU3RhdGVFcnJvcihcbiAgICAgICAgYGFnZW50LWhvbWUgZ2VuZXJhdGlvbiAke2dlbmVyYXRpb259IGlzIG9sZGVyIHRoYW4gYWN0aXZlIGdlbmVyYXRpb24gJHtjdXJyZW50LmdlbmVyYXRpb259YCxcbiAgICAgICAgeyBmYW1pbHksIGdlbmVyYXRpb24gfSxcbiAgICAgICk7XG4gICAgfVxuICAgIGlmIChcbiAgICAgIGN1cnJlbnQgJiZcbiAgICAgIGN1cnJlbnQuZ2VuZXJhdGlvbiA9PT0gZ2VuZXJhdGlvbiAmJlxuICAgICAgY3VycmVudC5mYW1pbHkgIT09IGZhbWlseVxuICAgICkge1xuICAgICAgdGhyb3cgbmV3IFdvcmtzcGFjZUhvc3RBZ2VudEhvbWVTdGF0ZUVycm9yKFxuICAgICAgICBgYWdlbnQtaG9tZSBnZW5lcmF0aW9uICR7Z2VuZXJhdGlvbn0gaXMgYWxyZWFkeSBhY3RpdmUgZm9yIGFub3RoZXIgZmFtaWx5YCxcbiAgICAgICAgeyBmYW1pbHksIGdlbmVyYXRpb24gfSxcbiAgICAgICk7XG4gICAgfVxuXG4gICAgY29uc3Qgc2VjdXJlZERpcmVjdG9yaWVzID0gYXdhaXQgdGhpcy5zZWN1cmVIb21lTGF5b3V0KCk7XG4gICAgY29uc3QgaW5zdGFsbGVkRmlsZXM6IHN0cmluZ1tdID0gW107XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHBhdGhzID0gd29ya3NwYWNlSG9zdEFnZW50SG9tZVBhdGhzKHRoaXMuYWdlbnRIb21lKTtcbiAgICAgIGNvbnN0IG5hdGl2ZUZpbGVzID0gYXdhaXQgUHJvbWlzZS5hbGwoXG4gICAgICAgIChPYmplY3Qua2V5cyhwYXRocykgYXMgV29ya3NwYWNlSG9zdEFnZW50SG9tZUZpbGVbXSkubWFwKFxuICAgICAgICAgIGFzeW5jIChsYWJlbCkgPT4gKHtcbiAgICAgICAgICAgIGxhYmVsLFxuICAgICAgICAgICAgZXhpc3Rpbmc6IGF3YWl0IHRoaXMuZmlsZXN5c3RlbS5yZWFkRmlsZUlmUHJlc2VudChwYXRoc1tsYWJlbF0pLFxuICAgICAgICAgIH0pLFxuICAgICAgICApLFxuICAgICAgKTtcbiAgICAgIC8vIEEgbmF0aXZlIENMSSBtYXkgaGF2ZSByZWZyZXNoZWQgaXRzIGNyZWRlbnRpYWxzIHNpbmNlIHRoaXMgZ2VuZXJhdGlvbiB3YXMgaW5zdGFsbGVkLlxuICAgICAgLy8gUmViaW5kaW5nIHRoZSBpbW11dGFibGUgc2VlZCBtdXN0IG5vdCBkaXNjYXJkIHRob3NlIGJ5dGVzLiBDaGVjayBldmVyeSBjcmVkZW50aWFsXG4gICAgICAvLyBiZWZvcmUgYW55IHdyaXRlLCBhbmQgcmVxdWlyZSBhIG5ld2VyIGdlbmVyYXRpb24gaW5zdGVhZCBvZiBhY2NlcHRpbmcgY2hhbmdlZCBtYXRlcmlhbC5cbiAgICAgIC8vIEEgbWlncmF0aW9uIGlzIGV4ZW1wdDogdGhpcyBnZW5lcmF0aW9uIHdhcyBpbnN0YWxsZWQgaW50byB0aGUgTEVHQUNZIGhvbWUsIHNvIHdoYXRldmVyXG4gICAgICAvLyBzaXRzIGF0IHRoaXMgaG9tZSdzIHBhdGhzIHdhcyBuZXZlciBtYW5hZ2VkIChlLmcuIGZpbGVzIGFuIG9wZXJhdG9yIHBsYWNlZCBieSBoYW5kKSBhbmRcbiAgICAgIC8vIGlzIHJlcGxhY2VkIGJ5IHRoZSBkZWxpdmVyZWQgbWF0ZXJpYWwgcmF0aGVyIHRoYW4gcHJvdGVjdGVkIGFzIGEgQ0xJIHJlZnJlc2guXG4gICAgICBpZiAoY3VycmVudD8uZ2VuZXJhdGlvbiA9PT0gZ2VuZXJhdGlvbiAmJiAhY3VycmVudC5sZWdhY3kpIHtcbiAgICAgICAgZm9yIChjb25zdCB7IGxhYmVsLCBleGlzdGluZyB9IG9mIG5hdGl2ZUZpbGVzKSB7XG4gICAgICAgICAgY29uc3QgZXhwZWN0ZWQgPSBidW5kbGUuZmlsZXNbbGFiZWxdO1xuICAgICAgICAgIGlmIChcbiAgICAgICAgICAgIGV4aXN0aW5nICE9PSBudWxsICYmXG4gICAgICAgICAgICBleHBlY3RlZCAhPT0gbnVsbCAmJlxuICAgICAgICAgICAgIWNvbXBhcmVCeXRlcyhleGlzdGluZywgZXhwZWN0ZWQpXG4gICAgICAgICAgKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgV29ya3NwYWNlSG9zdEFnZW50SG9tZVN0YXRlRXJyb3IoXG4gICAgICAgICAgICAgIGBhZ2VudC1ob21lIGNyZWRlbnRpYWwgJyR7bGFiZWx9JyBjaGFuZ2VkIGFmdGVyIGdlbmVyYXRpb24gJHtnZW5lcmF0aW9ufSB3YXMgaW5zdGFsbGVkOyBgICtcbiAgICAgICAgICAgICAgICBcImEgbmV3ZXIgdmVyaWZpZWQgY3JlZGVudGlhbCBnZW5lcmF0aW9uIGlzIHJlcXVpcmVkXCIsXG4gICAgICAgICAgICAgIHsgZmFtaWx5LCBnZW5lcmF0aW9uIH0sXG4gICAgICAgICAgICApO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgZm9yIChjb25zdCB7IGxhYmVsLCBleGlzdGluZyB9IG9mIG5hdGl2ZUZpbGVzKSB7XG4gICAgICAgIGNvbnN0IGJ5dGVzID0gYnVuZGxlLmZpbGVzW2xhYmVsXTtcbiAgICAgICAgaWYgKGJ5dGVzID09PSBudWxsKSB7XG4gICAgICAgICAgaWYgKGV4aXN0aW5nICE9PSBudWxsKSB7XG4gICAgICAgICAgICBhd2FpdCB0aGlzLnJlbW92ZU5hdGl2ZUZpbGUocGF0aHNbbGFiZWxdLCBmYW1pbHksIGdlbmVyYXRpb24pO1xuICAgICAgICAgIH1cbiAgICAgICAgICBpZiAodGhpcy5maWxlc3lzdGVtLnBhdGhLaW5kKSB7XG4gICAgICAgICAgICBjb25zdCBraW5kID0gYXdhaXQgdGhpcy5maWxlc3lzdGVtLnBhdGhLaW5kKHBhdGhzW2xhYmVsXSk7XG4gICAgICAgICAgICBpZiAoa2luZCAhPT0gXCJtaXNzaW5nXCIpIHtcbiAgICAgICAgICAgICAgdGhyb3cgbmV3IFdvcmtzcGFjZUhvc3RBZ2VudEhvbWVTdGF0ZUVycm9yKFxuICAgICAgICAgICAgICAgIGB3b3Jrc3BhY2UgYWdlbnQtaG9tZSBmaWxlICcke2xhYmVsfScgbXVzdCBiZSBhYnNlbnQgZm9yIGNyZWRlbnRpYWwtZnJlZSB2ZXJpZmljYXRpb25gLFxuICAgICAgICAgICAgICAgIHsgZmFtaWx5LCBnZW5lcmF0aW9uIH0sXG4gICAgICAgICAgICAgICk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfVxuICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG4gICAgICAgIGlmIChleGlzdGluZyA9PT0gbnVsbCB8fCAhY29tcGFyZUJ5dGVzKGV4aXN0aW5nLCBieXRlcykpIHtcbiAgICAgICAgICBhd2FpdCB0aGlzLmZpbGVzeXN0ZW0ud3JpdGVQcml2YXRlRmlsZShwYXRoc1tsYWJlbF0sIGJ5dGVzKTtcbiAgICAgICAgfVxuICAgICAgICAvLyBDaGVjayB0aGUgZmluYWwgcGF0aCB3aXRob3V0IGZvbGxvd2luZyBhIHVzZXItY3JlYXRlZCBzeW1saW5rIGJlZm9yZSBjaGFuZ2luZyBvd25lcnNoaXAuXG4gICAgICAgIGlmICh0aGlzLmZpbGVzeXN0ZW0ucGF0aEtpbmQpIHtcbiAgICAgICAgICBjb25zdCBraW5kID0gYXdhaXQgdGhpcy5maWxlc3lzdGVtLnBhdGhLaW5kKHBhdGhzW2xhYmVsXSk7XG4gICAgICAgICAgaWYgKGtpbmQgIT09IFwiZmlsZVwiKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgV29ya3NwYWNlSG9zdEFnZW50SG9tZVN0YXRlRXJyb3IoXG4gICAgICAgICAgICAgIGB3b3Jrc3BhY2UgYWdlbnQtaG9tZSBmaWxlICcke2xhYmVsfScgaXMgbm90IGEgcmVndWxhciBmaWxlYCxcbiAgICAgICAgICAgICAgeyBmYW1pbHksIGdlbmVyYXRpb24gfSxcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIGluc3RhbGxlZEZpbGVzLnB1c2gocGF0aHNbbGFiZWxdKTtcbiAgICAgIH1cbiAgICAgIC8vIEEgY3JlZGVudGlhbC1mcmVlIE9NUCBidW5kbGUgbXVzdCBzdGlsbCBoYXZlIGEgbW9kZWwgcmVnaXN0cnkuICBXaXRob3V0IHRoaXMgZmlsZSBPTVBcbiAgICAgIC8vIGZhbGxzIGJhY2sgdG8gaXRzIGJ1aWx0LWluIHByb3ZpZGVycyBhbmQgcmVwb3J0cyB0aGUgbG9jYWwgbW9kZWwgYXMgXCJub3QgZm91bmRcIiBldmVuXG4gICAgICAvLyB0aG91Z2ggYm9vdHN0cmFwIHB1bGxlZCBpdCBpbnRvIHRoZSBob3N0J3MgbG9vcGJhY2sgT2xsYW1hIHNlcnZpY2UuXG4gICAgICBpZiAoYnVuZGxlLmZpbGVzLm9tcCA9PT0gbnVsbCkge1xuICAgICAgICBpbnN0YWxsZWRGaWxlcy5wdXNoKFxuICAgICAgICAgIGF3YWl0IHRoaXMuZW5zdXJlTG9jYWxPbXBNb2RlbHNDb25maWcoZmFtaWx5LCBnZW5lcmF0aW9uKSxcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIC8vIEQtNDIxOiBhIGNvcHkgaW4gYSBsZWdhY3kgaG9tZSBpcyB1bnJlYWNoYWJsZSBieSBhbnkgbGF0ZXIgcmV2b2tlIG9uY2UgdGhlIHJlY29yZCBiZWxvd1xuICAgICAgLy8gbmFtZXMgdGhpcyBob21lLCBzbyBpdCBnb2VzIGJlZm9yZSB0aGUgY29tbWl0LiBBIGNyYXNoIGJldHdlZW4gdGhlIHR3byBsZWF2ZXMgdGhlIGxlZ2FjeVxuICAgICAgLy8gcmVjb3JkIGluIHBsYWNlLCBhbmQgdGhlIG5leHQgaW5zdGFsbCBvciByZXZva2UgcmVwZWF0cyB0aGUgc3dlZXAuXG4gICAgICBhd2FpdCB0aGlzLnN3ZWVwTGVnYWN5SG9tZXMoZmFtaWx5LCBnZW5lcmF0aW9uKTtcbiAgICAgIC8vIFN0YXRlIGlzIHRoZSBjb21taXQgbWFya2VyIGFuZCBpcyBpbnRlbnRpb25hbGx5IHdyaXR0ZW4gYWZ0ZXIgZXZlcnkgbmF0aXZlIGZpbGUgc3VjY2VlZHMuXG4gICAgICBhd2FpdCB0aGlzLmZpbGVzeXN0ZW0uZW5zdXJlRGlyZWN0b3J5KGpvaW4odGhpcy5tYXRlcmlhbFJvb3QsIFwiYWN0aXZlXCIpKTtcbiAgICAgIGF3YWl0IHRoaXMuZmlsZXN5c3RlbS53cml0ZVByaXZhdGVGaWxlKFxuICAgICAgICB3b3Jrc3BhY2VIb3N0QWdlbnRIb21lU3RhdGVQYXRoKHRoaXMubWF0ZXJpYWxSb290KSxcbiAgICAgICAgZW5jb2RlV29ya3NwYWNlSG9zdEFnZW50SG9tZVN0YXRlKGZhbWlseSwgZ2VuZXJhdGlvbiwgdGhpcy5hZ2VudEhvbWUpLFxuICAgICAgKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgYXdhaXQgdGhpcy5yZXN0b3JlSG9tZUxheW91dChzZWN1cmVkRGlyZWN0b3JpZXMsIGluc3RhbGxlZEZpbGVzKTtcbiAgICB9XG4gICAgcmV0dXJuIHsgZmFtaWx5LCBnZW5lcmF0aW9uLCBwcmVzZW50OiB0cnVlLCBob21lOiB0aGlzLmFnZW50SG9tZSB9O1xuICB9XG5cbiAgcHJpdmF0ZSBhc3luYyByZW1vdmVOYXRpdmVGaWxlKFxuICAgIHBhdGg6IHN0cmluZyxcbiAgICBmYW1pbHk6IFdvcmtzcGFjZUhvc3RBZ2VudEhvbWVGYW1pbHksXG4gICAgZ2VuZXJhdGlvbjogbnVtYmVyLFxuICApOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBpZiAodGhpcy5maWxlc3lzdGVtLnBhdGhLaW5kKSB7XG4gICAgICBjb25zdCBraW5kID0gYXdhaXQgdGhpcy5maWxlc3lzdGVtLnBhdGhLaW5kKHBhdGgpO1xuICAgICAgaWYgKGtpbmQgIT09IFwibWlzc2luZ1wiICYmIGtpbmQgIT09IFwiZmlsZVwiKSB7XG4gICAgICAgIHRocm93IG5ldyBXb3Jrc3BhY2VIb3N0QWdlbnRIb21lU3RhdGVFcnJvcihcbiAgICAgICAgICBcInJlZnVzaW5nIHRvIHJlbW92ZSBhIG5vbi1yZWd1bGFyIGFnZW50LWhvbWUgcGF0aFwiLFxuICAgICAgICAgIHsgZmFtaWx5LCBnZW5lcmF0aW9uIH0sXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgfVxuICAgIGF3YWl0IHRoaXMuZmlsZXN5c3RlbS5yZW1vdmVQYXRoKHBhdGgpO1xuICB9XG5cbiAgYXN5bmMgaW5zdGFsbChcbiAgICBmYW1pbHk6IFdvcmtzcGFjZUhvc3RBZ2VudEhvbWVGYW1pbHksXG4gICAgZ2VuZXJhdGlvbjogbnVtYmVyLFxuICAgIG1hdGVyaWFsOiBCdWZmZXIsXG4gICAgb3B0aW9uczogeyByZWFkb25seSBsb2NrSGVsZD86IGJvb2xlYW4gfSA9IHt9LFxuICApOiBQcm9taXNlPFdvcmtzcGFjZUhvc3RBZ2VudEhvbWVDb25zdW1lckV2aWRlbmNlPiB7XG4gICAgcmV0dXJuIGF3YWl0IHRoaXMud2l0aExvY2soXG4gICAgICBmYW1pbHksXG4gICAgICAoKSA9PiB0aGlzLmluc3RhbGxVbmxvY2tlZChmYW1pbHksIGdlbmVyYXRpb24sIG1hdGVyaWFsKSxcbiAgICAgIG9wdGlvbnMubG9ja0hlbGQgPT09IHRydWUsXG4gICAgKTtcbiAgfVxuXG4gIGFzeW5jIHZlcmlmeShcbiAgICBmYW1pbHk6IFdvcmtzcGFjZUhvc3RBZ2VudEhvbWVGYW1pbHksXG4gICAgZ2VuZXJhdGlvbjogbnVtYmVyLFxuICAgIG1hdGVyaWFsOiBCdWZmZXIsXG4gICAgb3B0aW9uczogeyByZWFkb25seSBsb2NrSGVsZD86IGJvb2xlYW4gfSA9IHt9LFxuICApOiBQcm9taXNlPFdvcmtzcGFjZUhvc3RBZ2VudEhvbWVDb25zdW1lckV2aWRlbmNlPiB7XG4gICAgcmV0dXJuIGF3YWl0IHRoaXMud2l0aExvY2soXG4gICAgICBmYW1pbHksXG4gICAgICBhc3luYyAoKSA9PiB7XG4gICAgICAgIGNvbnN0IGJ1bmRsZSA9IHBhcnNlV29ya3NwYWNlSG9zdEFnZW50SG9tZUJ1bmRsZShtYXRlcmlhbCk7XG4gICAgICAgIGNvbnN0IGN1cnJlbnQgPSBhd2FpdCB0aGlzLnJlYWRTdGF0ZSgpO1xuICAgICAgICBpZiAoY3VycmVudD8ubGVnYWN5KSB7XG4gICAgICAgICAgLy8gVmVyaWZpZWQgYnl0ZXMgaW4gYSBob21lIG5vIGN1c3RvbWVyLWRyaXZlbiBhZ2VudCByZWFkcyB3b3VsZCBiZSBhIHBhc3MgdGhhdCBwcm92ZXNcbiAgICAgICAgICAvLyBub3RoaW5nIGFib3V0IHRoZSBwcm9kdWN0IHBhdGggKEQtNDIxKS4gTmFtZSB0aGUgcmVwYWlyIGluc3RlYWQgb2YgdGhlIHN5bXB0b20uXG4gICAgICAgICAgdGhyb3cgbmV3IFdvcmtzcGFjZUhvc3RBZ2VudEhvbWVTdGF0ZUVycm9yKFxuICAgICAgICAgICAgYGFnZW50LWhvbWUgZ2VuZXJhdGlvbiAke2N1cnJlbnQuZ2VuZXJhdGlvbn0gaXMgaW5zdGFsbGVkIGluIHRoZSBsZWdhY3kgaG9tZSAke2N1cnJlbnQuaG9tZX07IGAgK1xuICAgICAgICAgICAgICBcImJpbmQgYSBjcmVkZW50aWFsIGdlbmVyYXRpb24gYWdhaW4gdG8gbWlncmF0ZSBpdCBpbnRvIHRoZSBhZ2VudC1ydW5uaW5nIGlkZW50aXR5J3MgaG9tZVwiLFxuICAgICAgICAgICAgeyBmYW1pbHksIGdlbmVyYXRpb24gfSxcbiAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICAgIGlmIChcbiAgICAgICAgICAhY3VycmVudCB8fFxuICAgICAgICAgIGN1cnJlbnQuZmFtaWx5ICE9PSBmYW1pbHkgfHxcbiAgICAgICAgICBjdXJyZW50LmdlbmVyYXRpb24gIT09IGdlbmVyYXRpb24gfHxcbiAgICAgICAgICBjdXJyZW50LmhvbWUgIT09IHRoaXMuYWdlbnRIb21lXG4gICAgICAgICkge1xuICAgICAgICAgIHRocm93IG5ldyBXb3Jrc3BhY2VIb3N0QWdlbnRIb21lU3RhdGVFcnJvcihcbiAgICAgICAgICAgIGBhZ2VudC1ob21lIGdlbmVyYXRpb24gJHtnZW5lcmF0aW9ufSBpcyBub3QgdGhlIGFjdGl2ZSBpbnN0YWxsZWQgZ2VuZXJhdGlvbmAsXG4gICAgICAgICAgICB7IGZhbWlseSwgZ2VuZXJhdGlvbiB9LFxuICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgICAgY29uc3Qgc2VjdXJlZERpcmVjdG9yaWVzID0gYXdhaXQgdGhpcy5zZWN1cmVIb21lTGF5b3V0KCk7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgY29uc3QgcGF0aHMgPSB3b3Jrc3BhY2VIb3N0QWdlbnRIb21lUGF0aHModGhpcy5hZ2VudEhvbWUpO1xuICAgICAgICAgIGZvciAoY29uc3QgbGFiZWwgb2YgT2JqZWN0LmtleXMoXG4gICAgICAgICAgICBwYXRocyxcbiAgICAgICAgICApIGFzIFdvcmtzcGFjZUhvc3RBZ2VudEhvbWVGaWxlW10pIHtcbiAgICAgICAgICAgIGNvbnN0IGV4cGVjdGVkQnl0ZXMgPSBidW5kbGUuZmlsZXNbbGFiZWxdO1xuICAgICAgICAgICAgaWYgKHRoaXMuZmlsZXN5c3RlbS5wYXRoS2luZCkge1xuICAgICAgICAgICAgICBjb25zdCBraW5kID0gYXdhaXQgdGhpcy5maWxlc3lzdGVtLnBhdGhLaW5kKHBhdGhzW2xhYmVsXSk7XG4gICAgICAgICAgICAgIGlmIChcbiAgICAgICAgICAgICAgICBleHBlY3RlZEJ5dGVzID09PSBudWxsID8ga2luZCAhPT0gXCJtaXNzaW5nXCIgOiBraW5kICE9PSBcImZpbGVcIlxuICAgICAgICAgICAgICApIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgV29ya3NwYWNlSG9zdEFnZW50SG9tZVN0YXRlRXJyb3IoXG4gICAgICAgICAgICAgICAgICBgYWdlbnQtaG9tZSBmaWxlICcke2xhYmVsfScgaXMgYWJzZW50LCBzdGFsZSwgb3IgcG9pbnRzIG91dHNpZGUgdGhlIGV4cGxpY2l0IGhvbWVgLFxuICAgICAgICAgICAgICAgICAgeyBmYW1pbHksIGdlbmVyYXRpb24gfSxcbiAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBjb25zdCBieXRlcyA9IGF3YWl0IHRoaXMuZmlsZXN5c3RlbS5yZWFkRmlsZUlmUHJlc2VudChwYXRoc1tsYWJlbF0pO1xuICAgICAgICAgICAgaWYgKGV4cGVjdGVkQnl0ZXMgPT09IG51bGwpIHtcbiAgICAgICAgICAgICAgaWYgKGJ5dGVzICE9PSBudWxsKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IFdvcmtzcGFjZUhvc3RBZ2VudEhvbWVTdGF0ZUVycm9yKFxuICAgICAgICAgICAgICAgICAgYGFnZW50LWhvbWUgZmlsZSAnJHtsYWJlbH0nIG11c3QgYmUgYWJzZW50IGZvciBjcmVkZW50aWFsLWZyZWUgdmVyaWZpY2F0aW9uYCxcbiAgICAgICAgICAgICAgICAgIHsgZmFtaWx5LCBnZW5lcmF0aW9uIH0sXG4gICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmIChcbiAgICAgICAgICAgICAgYnl0ZXMgPT09IG51bGwgfHxcbiAgICAgICAgICAgICAgY3VycmVudC5maWxlc1tsYWJlbF0gIT09IHBhdGhzW2xhYmVsXSB8fFxuICAgICAgICAgICAgICAhY29tcGFyZUJ5dGVzKGJ5dGVzLCBleHBlY3RlZEJ5dGVzKVxuICAgICAgICAgICAgKSB7XG4gICAgICAgICAgICAgIHRocm93IG5ldyBXb3Jrc3BhY2VIb3N0QWdlbnRIb21lU3RhdGVFcnJvcihcbiAgICAgICAgICAgICAgICBgYWdlbnQtaG9tZSBmaWxlICcke2xhYmVsfScgaXMgYWJzZW50LCBzdGFsZSwgb3IgcG9pbnRzIG91dHNpZGUgdGhlIGV4cGxpY2l0IGhvbWVgLFxuICAgICAgICAgICAgICAgIHsgZmFtaWx5LCBnZW5lcmF0aW9uIH0sXG4gICAgICAgICAgICAgICk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfVxuICAgICAgICAgIGlmIChidW5kbGUuZmlsZXMub21wID09PSBudWxsKSB7XG4gICAgICAgICAgICBhd2FpdCB0aGlzLnZlcmlmeUxvY2FsT21wTW9kZWxzQ29uZmlnKGZhbWlseSwgZ2VuZXJhdGlvbik7XG4gICAgICAgICAgfVxuICAgICAgICB9IGZpbmFsbHkge1xuICAgICAgICAgIGF3YWl0IHRoaXMucmVzdG9yZUhvbWVMYXlvdXQoc2VjdXJlZERpcmVjdG9yaWVzKTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4geyBmYW1pbHksIGdlbmVyYXRpb24sIHByZXNlbnQ6IHRydWUsIGhvbWU6IHRoaXMuYWdlbnRIb21lIH07XG4gICAgICB9LFxuICAgICAgb3B0aW9ucy5sb2NrSGVsZCA9PT0gdHJ1ZSxcbiAgICApO1xuICB9XG5cbiAgYXN5bmMgcmV2b2tlKFxuICAgIGZhbWlseTogV29ya3NwYWNlSG9zdEFnZW50SG9tZUZhbWlseSxcbiAgICBnZW5lcmF0aW9uOiBudW1iZXIsXG4gICAgb3B0aW9uczogeyByZWFkb25seSBsb2NrSGVsZD86IGJvb2xlYW4gfSA9IHt9LFxuICApOiBQcm9taXNlPFdvcmtzcGFjZUhvc3RBZ2VudEhvbWVDb25zdW1lckV2aWRlbmNlPiB7XG4gICAgcmV0dXJuIGF3YWl0IHRoaXMud2l0aExvY2soXG4gICAgICBmYW1pbHksXG4gICAgICBhc3luYyAoKSA9PiB7XG4gICAgICAgIC8vIEEgbWFsZm9ybWVkL3RhbXBlcmVkIHN0YXRlIHRoYXQgbmFtZXMgYW5vdGhlciBjYW5vbmljYWwgaG9tZSBpcyBuZXZlciBhIHJlYXNvbiBmb3IgYVxuICAgICAgICAvLyByb290IGNvbnN1bWVyIHRvIHJlbW92ZSBmaWxlcyB0aGVyZTogcmVhZFN0YXRlKCkgZmFpbHMgY2xvc2VkIG9uIGFueSBob21lIHRoYXQgaXNcbiAgICAgICAgLy8gbmVpdGhlciB0aGlzIG9uZSBub3IgYSBjb25maWd1cmVkIGxlZ2FjeSBob21lLlxuICAgICAgICBjb25zdCBjdXJyZW50ID0gYXdhaXQgdGhpcy5yZWFkU3RhdGUoKTtcbiAgICAgICAgLy8gQSBzdGFsZSByZXZva2UgaXMgZGVsaWJlcmF0ZWx5IGEgbm8tb3A6IGEgbmV3ZXIgZ2VuZXJhdGlvbiBvd25zIHRoZXNlIHNhbWUgcGF0aHMgbm93LlxuICAgICAgICBpZiAoXG4gICAgICAgICAgIWN1cnJlbnQgfHxcbiAgICAgICAgICBjdXJyZW50LmZhbWlseSAhPT0gZmFtaWx5IHx8XG4gICAgICAgICAgY3VycmVudC5nZW5lcmF0aW9uICE9PSBnZW5lcmF0aW9uXG4gICAgICAgICkge1xuICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICBmYW1pbHksXG4gICAgICAgICAgICBnZW5lcmF0aW9uLFxuICAgICAgICAgICAgcHJlc2VudDogZmFsc2UsXG4gICAgICAgICAgICBob21lOiB0aGlzLmFnZW50SG9tZSxcbiAgICAgICAgICB9O1xuICAgICAgICB9XG4gICAgICAgIGlmIChjdXJyZW50LmxlZ2FjeSkge1xuICAgICAgICAgIC8vIFRoZSByZXZva2VkIGdlbmVyYXRpb24gbGl2ZXMgb25seSBpbiB0aGUgbGVnYWN5IGhvbWUuIExlYXZlIHRoaXMgaG9tZSBhbG9uZTogbm90aGluZ1xuICAgICAgICAgIC8vIGhlcmUgd2FzIGluc3RhbGxlZCBmb3IgaXQsIGFuZCBpdCBtYXkgaG9sZCBtYXRlcmlhbCB0aGUgY3VzdG9tZXIgcGxhY2VkIHRoZW1zZWx2ZXMuXG4gICAgICAgICAgYXdhaXQgdGhpcy5zd2VlcExlZ2FjeUhvbWVzKGZhbWlseSwgZ2VuZXJhdGlvbik7XG4gICAgICAgICAgYXdhaXQgdGhpcy5yZW1vdmVOYXRpdmVGaWxlKFxuICAgICAgICAgICAgd29ya3NwYWNlSG9zdEFnZW50SG9tZVN0YXRlUGF0aCh0aGlzLm1hdGVyaWFsUm9vdCksXG4gICAgICAgICAgICBmYW1pbHksXG4gICAgICAgICAgICBnZW5lcmF0aW9uLFxuICAgICAgICAgICk7XG4gICAgICAgICAgcmV0dXJuIHsgZmFtaWx5LCBnZW5lcmF0aW9uLCBwcmVzZW50OiBmYWxzZSwgaG9tZTogdGhpcy5hZ2VudEhvbWUgfTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCBzZWN1cmVkRGlyZWN0b3JpZXMgPSBhd2FpdCB0aGlzLnNlY3VyZUhvbWVMYXlvdXQoKTtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBjb25zdCBwYXRocyA9IHdvcmtzcGFjZUhvc3RBZ2VudEhvbWVQYXRocyh0aGlzLmFnZW50SG9tZSk7XG4gICAgICAgICAgZm9yIChjb25zdCBwYXRoIG9mIE9iamVjdC52YWx1ZXMocGF0aHMpKSB7XG4gICAgICAgICAgICBhd2FpdCB0aGlzLnJlbW92ZU5hdGl2ZUZpbGUocGF0aCwgZmFtaWx5LCBnZW5lcmF0aW9uKTtcbiAgICAgICAgICB9XG4gICAgICAgICAgLy8gQWxzbyBjb3ZlcnMgYSBsZWdhY3kgY29weSBhbiBpbnRlcnJ1cHRlZCBtaWdyYXRpb24gbGVmdCBiZWhpbmQgKHN3ZWVwTGVnYWN5SG9tZXMpLlxuICAgICAgICAgIGF3YWl0IHRoaXMuc3dlZXBMZWdhY3lIb21lcyhmYW1pbHksIGdlbmVyYXRpb24pO1xuICAgICAgICAgIGF3YWl0IHRoaXMucmVtb3ZlTmF0aXZlRmlsZShcbiAgICAgICAgICAgIHdvcmtzcGFjZUhvc3RBZ2VudEhvbWVTdGF0ZVBhdGgodGhpcy5tYXRlcmlhbFJvb3QpLFxuICAgICAgICAgICAgZmFtaWx5LFxuICAgICAgICAgICAgZ2VuZXJhdGlvbixcbiAgICAgICAgICApO1xuICAgICAgICB9IGZpbmFsbHkge1xuICAgICAgICAgIGF3YWl0IHRoaXMucmVzdG9yZUhvbWVMYXlvdXQoc2VjdXJlZERpcmVjdG9yaWVzKTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4geyBmYW1pbHksIGdlbmVyYXRpb24sIHByZXNlbnQ6IGZhbHNlLCBob21lOiB0aGlzLmFnZW50SG9tZSB9O1xuICAgICAgfSxcbiAgICAgIG9wdGlvbnMubG9ja0hlbGQgPT09IHRydWUsXG4gICAgKTtcbiAgfVxuXG4gIGFzeW5jIHZlcmlmeVJldm9rZWQoXG4gICAgZmFtaWx5OiBXb3Jrc3BhY2VIb3N0QWdlbnRIb21lRmFtaWx5LFxuICAgIGdlbmVyYXRpb246IG51bWJlcixcbiAgICBvcHRpb25zOiB7IHJlYWRvbmx5IGxvY2tIZWxkPzogYm9vbGVhbiB9ID0ge30sXG4gICk6IFByb21pc2U8V29ya3NwYWNlSG9zdEFnZW50SG9tZUNvbnN1bWVyRXZpZGVuY2U+IHtcbiAgICByZXR1cm4gYXdhaXQgdGhpcy53aXRoTG9jayhcbiAgICAgIGZhbWlseSxcbiAgICAgIGFzeW5jICgpID0+IHtcbiAgICAgICAgY29uc3QgY3VycmVudCA9IGF3YWl0IHRoaXMucmVhZFN0YXRlKCk7XG4gICAgICAgIGlmIChjdXJyZW50Py5mYW1pbHkgPT09IGZhbWlseSAmJiBjdXJyZW50LmdlbmVyYXRpb24gPT09IGdlbmVyYXRpb24pIHtcbiAgICAgICAgICB0aHJvdyBuZXcgV29ya3NwYWNlSG9zdEFnZW50SG9tZVN0YXRlRXJyb3IoXG4gICAgICAgICAgICBgYWdlbnQtaG9tZSBnZW5lcmF0aW9uICR7Z2VuZXJhdGlvbn0gaXMgc3RpbGwgYWN0aXZlIGFmdGVyIHJldm9jYXRpb25gLFxuICAgICAgICAgICAgeyBmYW1pbHksIGdlbmVyYXRpb24gfSxcbiAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiB7IGZhbWlseSwgZ2VuZXJhdGlvbiwgcHJlc2VudDogZmFsc2UsIGhvbWU6IHRoaXMuYWdlbnRIb21lIH07XG4gICAgICB9LFxuICAgICAgb3B0aW9ucy5sb2NrSGVsZCA9PT0gdHJ1ZSxcbiAgICApO1xuICB9XG59XG4iXSwiZmlsZSI6Ii9AZnMvaG9tZS9tYXJzaC1vZmZpY2UvcGFwZXJjdXBhaS13b3Jrc3BhY2UvcGFwZXJjdXNwL2xpYnMvZ2VuZXJpYy9kZXBsb3ltZW50LWRyaXZlci9zcmMvd29ya3NwYWNlLWhvc3QtYWdlbnQtaG9tZS50cyJ9

//# vitestCache=W3siZmlsZSI6IjEiLCJpZCI6IjEiLCJ1cmwiOiIyIiwiaW1wb3J0ZWRVcmxzIjoiMyIsIm1hcHBpbmdzIjpmYWxzZX0sIi9ob21lL21hcnNoLW9mZmljZS9wYXBlcmN1cGFpLXdvcmtzcGFjZS9wYXBlcmN1c3AvbGlicy9nZW5lcmljL2RlcGxveW1lbnQtZHJpdmVyL3NyYy93b3Jrc3BhY2UtaG9zdC1hZ2VudC1ob21lLnRzIiwiL0Bmcy9ob21lL21hcnNoLW9mZmljZS9wYXBlcmN1cGFpLXdvcmtzcGFjZS9wYXBlcmN1c3AvbGlicy9nZW5lcmljL2RlcGxveW1lbnQtZHJpdmVyL3NyYy93b3Jrc3BhY2UtaG9zdC1hZ2VudC1ob21lLnRzIixbXV0=