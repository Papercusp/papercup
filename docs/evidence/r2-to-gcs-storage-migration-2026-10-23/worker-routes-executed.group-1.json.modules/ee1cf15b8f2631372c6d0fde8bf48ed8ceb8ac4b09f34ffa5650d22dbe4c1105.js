'use strict';async (__vite_ssr_exports__,__vite_ssr_import_meta__,__vite_ssr_import__,__vite_ssr_dynamic_import__,__vite_ssr_exportAll__,__vite_ssr_exportName__,__filename,__dirname,module,exports,require)=>{{__vite_ssr_exportName__("WORKSPACE_HOST_CREDENTIAL_DELIVERY_PROTOCOL_VERSION", () => { try { return WORKSPACE_HOST_CREDENTIAL_DELIVERY_PROTOCOL_VERSION } catch {} });
__vite_ssr_exportName__("WORKSPACE_HOST_CREDENTIAL_DELIVERY_ARGV", () => { try { return WORKSPACE_HOST_CREDENTIAL_DELIVERY_ARGV } catch {} });
__vite_ssr_exportName__("WORKSPACE_HOST_CREDENTIAL_MATERIAL_MAX_BYTES", () => { try { return WORKSPACE_HOST_CREDENTIAL_MATERIAL_MAX_BYTES } catch {} });
__vite_ssr_exportName__("workspaceHostCredentialGenerationDirectory", () => { try { return workspaceHostCredentialGenerationDirectory } catch {} });
__vite_ssr_exportName__("workspaceHostCredentialMaterialPath", () => { try { return workspaceHostCredentialMaterialPath } catch {} });
__vite_ssr_exportName__("workspaceHostCredentialRevocationLedgerPath", () => { try { return workspaceHostCredentialRevocationLedgerPath } catch {} });
__vite_ssr_exportName__("WorkspaceHostCredentialMaterial", () => { try { return WorkspaceHostCredentialMaterial } catch {} });
__vite_ssr_exportName__("WorkspaceHostCredentialDeliveryProtocolError", () => { try { return WorkspaceHostCredentialDeliveryProtocolError } catch {} });
__vite_ssr_exportName__("WorkspaceHostAmbientCredentialDeliveryError", () => { try { return WorkspaceHostAmbientCredentialDeliveryError } catch {} });
__vite_ssr_exportName__("WorkspaceHostRevokedCredentialGenerationError", () => { try { return WorkspaceHostRevokedCredentialGenerationError } catch {} });
__vite_ssr_exportName__("WorkspaceHostCredentialGenerationConflictError", () => { try { return WorkspaceHostCredentialGenerationConflictError } catch {} });
__vite_ssr_exportName__("parseWorkspaceHostCredentialDeliveryRequest", () => { try { return parseWorkspaceHostCredentialDeliveryRequest } catch {} });
__vite_ssr_exportName__("ensureSharedWorkspaceDirectory", () => { try { return ensureSharedWorkspaceDirectory } catch {} });
__vite_ssr_exportName__("withWorkspaceHostCredentialFilesystemLock", () => { try { return withWorkspaceHostCredentialFilesystemLock } catch {} });
__vite_ssr_exportName__("workspaceHostCredentialFamilyLockPath", () => { try { return workspaceHostCredentialFamilyLockPath } catch {} });
__vite_ssr_exportName__("NodeWorkspaceHostCredentialDeliveryFilesystem", () => { try { return NodeWorkspaceHostCredentialDeliveryFilesystem } catch {} });
__vite_ssr_exportName__("readWorkspaceHostCredentialRevokedThrough", () => { try { return readWorkspaceHostCredentialRevokedThrough } catch {} });
__vite_ssr_exportName__("recordWorkspaceHostCredentialRevocation", () => { try { return recordWorkspaceHostCredentialRevocation } catch {} });
__vite_ssr_exportName__("executeWorkspaceHostCredentialDelivery", () => { try { return executeWorkspaceHostCredentialDelivery } catch {} });
__vite_ssr_exportName__("handleWorkspaceHostCredentialDeliveryPayload", () => { try { return handleWorkspaceHostCredentialDeliveryPayload } catch {} });
__vite_ssr_exportName__("assertWorkspaceHostCredentialDeliveryArgv", () => { try { return assertWorkspaceHostCredentialDeliveryArgv } catch {} });
__vite_ssr_exportName__("encodeWorkspaceHostCredentialDeliveryRequest", () => { try { return encodeWorkspaceHostCredentialDeliveryRequest } catch {} });
const __vite_ssr_import_0__ = await __vite_ssr_import__("node:crypto", {"importedNames":["createHash","randomUUID","timingSafeEqual"]});
const __vite_ssr_import_1__ = await __vite_ssr_import__("node:os", {"importedNames":["hostname"]});
const __vite_ssr_import_2__ = await __vite_ssr_import__("node:fs/promises", {"importedNames":["chmod","lstat","mkdir","readFile","readlink","rename","rm","writeFile"]});
const __vite_ssr_import_3__ = await __vite_ssr_import__("node:path", {"importedNames":["basename","dirname","isAbsolute","join","normalize"]});
const __vite_ssr_import_4__ = await __vite_ssr_import__("/@fs/home/marsh-office/papercupai-workspace/papercusp/libs/generic/deployment-driver/src/workspace-host-credential-namespace.ts", {"importedNames":["WORKSPACE_HOST_CREDENTIAL_FAMILY_SPECS","parseWorkspaceHostCredentialReference"]});
const __vite_ssr_import_5__ = await __vite_ssr_import__("/@fs/home/marsh-office/papercupai-workspace/papercusp/libs/generic/deployment-driver/src/workspace-host-test-harness.ts", {"importedNames":["assertWorkspaceHostSecretIsolation"]});






const WORKSPACE_HOST_CREDENTIAL_DELIVERY_PROTOCOL_VERSION = "papercusp-workspace-host-credential-delivery-v1";
const WORKSPACE_HOST_CREDENTIAL_DELIVERY_ARGV = [
  "--protocol-version",
  WORKSPACE_HOST_CREDENTIAL_DELIVERY_PROTOCOL_VERSION,
  "--json-stdin"
];
const WORKSPACE_HOST_CREDENTIAL_MATERIAL_MAX_BYTES = 256 * 1024;
const MATERIAL_FILE = "material";
const REVOCATION_LEDGER_FILE = "revoked-through";
function workspaceHostCredentialGenerationDirectory(root, family, generation) {
  return (0,__vite_ssr_import_3__.join)(root, family, `${generation}`);
};
function workspaceHostCredentialMaterialPath(root, family, generation) {
  return (0,__vite_ssr_import_3__.join)(
    workspaceHostCredentialGenerationDirectory(root, family, generation),
    MATERIAL_FILE
  );
};
function workspaceHostCredentialRevocationLedgerPath(root, family) {
  return (0,__vite_ssr_import_3__.join)(root, family, REVOCATION_LEDGER_FILE);
};
class WorkspaceHostCredentialMaterial {
  #bytes;
  constructor(bytes) {
    this.#bytes = bytes;
  }
  /** The only way out. Deliberately explicit at every call site. */
  reveal() {
    return this.#bytes;
  }
  toJSON() {
    return "[redacted]";
  }
  toString() {
    return "[redacted]";
  }
  get [Symbol.toStringTag]() {
    return "WorkspaceHostCredentialMaterial";
  }
  [/* @__PURE__ */ Symbol.for("nodejs.util.inspect.custom")]() {
    return "WorkspaceHostCredentialMaterial [redacted]";
  }
};
class WorkspaceHostCredentialDeliveryProtocolError extends Error {
  constructor(message) {
    super(message);
    this.name = "WorkspaceHostCredentialDeliveryProtocolError";
  }
};
class WorkspaceHostAmbientCredentialDeliveryError extends Error {
  family;
  constructor(family) {
    super(
      `Credential family '${family}' is answered ambiently by the host environment and must not receive delivered material. Writing a file for it would make bind() pass against a path delivery created itself.`
    );
    this.name = "WorkspaceHostAmbientCredentialDeliveryError";
    this.family = family;
  }
};
class WorkspaceHostRevokedCredentialGenerationError extends Error {
  family;
  generation;
  revokedThrough;
  constructor(family, generation, revokedThrough) {
    super(
      `Generation ${generation} of family '${family}' cannot be delivered: generations through ${revokedThrough} have been revoked on this host. Rotation must issue a strictly increasing generation with a new revocation reference.`
    );
    this.name = "WorkspaceHostRevokedCredentialGenerationError";
    this.family = family;
    this.generation = generation;
    this.revokedThrough = revokedThrough;
  }
};
class WorkspaceHostCredentialGenerationConflictError extends Error {
  family;
  generation;
  constructor(family, generation) {
    super(
      `Generation ${generation} of family '${family}' is already present on this host with different material. Delivery is idempotent per (family, generation); replacing material requires a new generation.`
    );
    this.name = "WorkspaceHostCredentialGenerationConflictError";
    this.family = family;
    this.generation = generation;
  }
};
function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkspaceHostCredentialDeliveryProtocolError(
      `${label} must be an object`
    );
  };
  return value;
}
function requireString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new WorkspaceHostCredentialDeliveryProtocolError(
      `${label} must be a non-empty string`
    );
  };
  return value;
}
function decodeMaterial(value) {
  const encoded = requireString(value, "request.material");
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length === 0) {
    throw new WorkspaceHostCredentialDeliveryProtocolError(
      "request.material decoded to zero bytes; delivery must carry material"
    );
  };
  if (bytes.toString("base64") !== encoded.replace(/\s+/g, "")) {
    throw new WorkspaceHostCredentialDeliveryProtocolError(
      "request.material is not canonical base64"
    );
  };
  if (bytes.length > WORKSPACE_HOST_CREDENTIAL_MATERIAL_MAX_BYTES) {
    throw new WorkspaceHostCredentialDeliveryProtocolError(
      `request.material exceeds ${WORKSPACE_HOST_CREDENTIAL_MATERIAL_MAX_BYTES} bytes`
    );
  };
  return new WorkspaceHostCredentialMaterial(bytes);
}
function parseWorkspaceHostCredentialDeliveryRequest(raw) {
  const body = requireObject(raw, "request");
  if (body.protocolVersion !== WORKSPACE_HOST_CREDENTIAL_DELIVERY_PROTOCOL_VERSION) {
    throw new WorkspaceHostCredentialDeliveryProtocolError(
      `unsupported protocol version '${String(body.protocolVersion)}'; this delivery endpoint speaks '${WORKSPACE_HOST_CREDENTIAL_DELIVERY_PROTOCOL_VERSION}'`
    );
  };
  const channel = requireString(body.channel, "request.channel");
  const credentialRef = requireString(
    body.credentialRef,
    "request.credentialRef"
  );
  const parsed = (0,__vite_ssr_import_4__.parseWorkspaceHostCredentialReference)(
    credentialRef,
    channel
  );
  const generation = body.generation;
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new WorkspaceHostCredentialDeliveryProtocolError(
      "request.generation must be a positive safe integer"
    );
  };
  return {
    protocolVersion: WORKSPACE_HOST_CREDENTIAL_DELIVERY_PROTOCOL_VERSION,
    channel: parsed.channel,
    credentialRef,
    family: parsed.family,
    generation,
    material: decodeMaterial(body.material)
  };
};
const WORKSPACE_HOST_FILESYSTEM_LOCK_TIMEOUT_MS = 36e4;
const WORKSPACE_HOST_FILESYSTEM_LOCK_ORPHAN_MS = 6e4;
const WORKSPACE_HOST_FILESYSTEM_LOCK_RETRY_MS = 25;
function nodeErrorCode(error) {
  return error && typeof error === "object" && "code" in error ? String(error.code) : void 0;
}
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
async function ensureDirectoryWithoutFollowingSymlinks(path, mode, kind) {
  if (!(0,__vite_ssr_import_3__.isAbsolute)(path) || (0,__vite_ssr_import_3__.normalize)(path) !== path || /[\0\r\n]/.test(path)) {
    throw new Error(
      `${kind} must be an absolute canonical path: '${path}'`
    );
  };
  const components = path.split("/").filter(Boolean);
  let current = "/";
  for (const component of components) {
    current = (0,__vite_ssr_import_3__.join)(current, component);
    let info;
    let created = false;
    try {
      info = await (0,__vite_ssr_import_2__.lstat)(current);
    } catch (error) {
      if (nodeErrorCode(error) !== "ENOENT") throw error;
      try {
        await (0,__vite_ssr_import_2__.mkdir)(current, { mode });
        created = true;
      } catch (mkdirError) {
        if (nodeErrorCode(mkdirError) !== "EEXIST") throw mkdirError;
      };
      info = await (0,__vite_ssr_import_2__.lstat)(current);
    };
    if (!info.isDirectory() || info.isSymbolicLink()) {
      const systemTarget = current === "/srv" ? "/var/srv" : current === "/home" ? "/var/home" : void 0;
      if (systemTarget && info.isSymbolicLink() && info.uid === 0 && info.gid === 0) {
        const target = await (0,__vite_ssr_import_2__.readlink)(current);
        if (target === systemTarget || target === systemTarget.slice(1)) {
          for (const ancestor of ["/var", systemTarget]) {
            const trusted = await (0,__vite_ssr_import_2__.lstat)(ancestor);
            if (!trusted.isDirectory() || trusted.isSymbolicLink() || trusted.uid !== 0 || trusted.gid !== 0 || (trusted.mode & 18) !== 0) {
              throw new Error(`refusing untrusted system directory '${ancestor}'`);
            }
          };
          await ensureDirectoryWithoutFollowingSymlinks(systemTarget + path.slice(current.length), mode, kind);
          return;
        }
      };
      throw new Error(
        `refusing non-directory or symlink at ${kind} '${current}'`
      );
    };
    if (created || current === path) await (0,__vite_ssr_import_2__.chmod)(current, mode);
  }
}
async function ensurePrivateDirectory(path) {
  await ensureDirectoryWithoutFollowingSymlinks(path, 448, "private directory");
}
async function ensureSharedWorkspaceDirectory(path) {
  await ensureDirectoryWithoutFollowingSymlinks(path, 504, "workspace directory");
};
const fallbackFilesystemLocks = /* @__PURE__ */ new WeakMap();
async function withWorkspaceHostCredentialFilesystemLock(filesystem, path, task) {
  if (filesystem.withExclusiveLock) {
    return await filesystem.withExclusiveLock(path, task);
  };
  let locks = fallbackFilesystemLocks.get(filesystem);
  if (!locks) {
    locks = /* @__PURE__ */ new Map();
    fallbackFilesystemLocks.set(filesystem, locks);
  };
  const previous = locks.get(path) ?? Promise.resolve();
  let release;
  const own = new Promise((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => own);
  locks.set(path, tail);
  await previous;
  try {
    return await task();
  } finally {
    release();
    if (locks.get(path) === tail) locks.delete(path);
  }
};
function workspaceHostCredentialFamilyLockPath(root, family) {
  if (family === "agent-forwarded-reference" || family === "agent-encrypted-reference") {
    return (0,__vite_ssr_import_3__.join)(root, "active", ".agent-home.lifecycle.lock");
  };
  return (0,__vite_ssr_import_3__.join)(root, family, ".lifecycle.lock");
};
class NodeWorkspaceHostCredentialDeliveryFilesystem {
  async ensureDirectory(path) {
    await ensurePrivateDirectory(path);
  }
  async writePrivateFile(path, bytes) {
    await ensurePrivateDirectory((0,__vite_ssr_import_3__.dirname)(path));
    const temporary = (0,__vite_ssr_import_3__.join)(
      (0,__vite_ssr_import_3__.dirname)(path),
      `.${(0,__vite_ssr_import_3__.basename)(path)}.${process.pid}.${(0,__vite_ssr_import_0__.randomUUID)()}.tmp`
    );
    try {
      await (0,__vite_ssr_import_2__.writeFile)(temporary, bytes, { mode: 384, flag: "wx" });
      await (0,__vite_ssr_import_2__.chmod)(temporary, 384);
      await (0,__vite_ssr_import_2__.rename)(temporary, path);
    } finally {
      await (0,__vite_ssr_import_2__.rm)(temporary, { force: true }).catch(() => void 0);
    }
  }
  async readFileIfPresent(path) {
    try {
      const info = await (0,__vite_ssr_import_2__.lstat)(path);
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new Error(`refusing to read non-regular private file '${path}'`);
      };
      return await (0,__vite_ssr_import_2__.readFile)(path);
    } catch (error) {
      if (nodeErrorCode(error) === "ENOENT") return null;
      throw error;
    }
  }
  async pathKind(path) {
    try {
      const info = await (0,__vite_ssr_import_2__.lstat)(path);
      if (info.isSymbolicLink()) return "symlink";
      if (info.isDirectory()) return "directory";
      if (info.isFile()) return "file";
      return "other";
    } catch (error) {
      if (nodeErrorCode(error) === "ENOENT") return "missing";
      throw error;
    }
  }
  async withExclusiveLock(path, task) {
    await this.ensureDirectory((0,__vite_ssr_import_3__.dirname)(path));
    const token = (0,__vite_ssr_import_0__.randomUUID)();
    const ownerPath = (0,__vite_ssr_import_3__.join)(path, "owner.json");
    const startedAt = Date.now();
    let acquired = false;
    while (!acquired) {
      try {
        await (0,__vite_ssr_import_2__.mkdir)(path, { mode: 448 });
        await (0,__vite_ssr_import_2__.writeFile)(
          ownerPath,
          JSON.stringify({
            token,
            pid: process.pid,
            host: (0,__vite_ssr_import_1__.hostname)(),
            startedAt
          }),
          { mode: 384, flag: "wx" }
        );
        acquired = true;
      } catch (error) {
        if (nodeErrorCode(error) !== "EEXIST") throw error;
        let reclaim = false;
        try {
          const info = await (0,__vite_ssr_import_2__.lstat)(path);
          if (!info.isDirectory() || info.isSymbolicLink()) {
            throw new Error(`refusing unsafe credential lock path '${path}'`);
          };
          try {
            const owner = JSON.parse(await (0,__vite_ssr_import_2__.readFile)(ownerPath, "utf8"));
            if (owner.host === (0,__vite_ssr_import_1__.hostname)() && Number.isSafeInteger(owner.pid) && owner.pid > 0) {
              try {
                process.kill(owner.pid, 0);
              } catch (probeError) {
                reclaim = nodeErrorCode(probeError) === "ESRCH";
              }
            }
          } catch (ownerError) {
            if (nodeErrorCode(ownerError) !== "ENOENT") {
            };
            reclaim = Date.now() - info.mtimeMs > WORKSPACE_HOST_FILESYSTEM_LOCK_ORPHAN_MS;
          }
        } catch (inspectError) {
          if (nodeErrorCode(inspectError) === "ENOENT") continue;
          throw inspectError;
        };
        if (reclaim) {
          await (0,__vite_ssr_import_2__.rm)(path, { recursive: true, force: true });
          continue;
        };
        if (Date.now() - startedAt > WORKSPACE_HOST_FILESYSTEM_LOCK_TIMEOUT_MS) {
          throw new Error(
            `timed out waiting for credential filesystem lock '${path}'`
          );
        };
        await delay(WORKSPACE_HOST_FILESYSTEM_LOCK_RETRY_MS);
      }
    };
    try {
      return await task();
    } finally {
      try {
        const owner = JSON.parse(await (0,__vite_ssr_import_2__.readFile)(ownerPath, "utf8"));
        if (owner.token === token)
          await (0,__vite_ssr_import_2__.rm)(path, { recursive: true, force: true });
      } catch {
      }
    }
  }
};
async function readWorkspaceHostCredentialRevokedThrough(filesystem, root, family) {
  const raw = await filesystem.readFileIfPresent(
    workspaceHostCredentialRevocationLedgerPath(root, family)
  );
  if (raw === null) return 0;
  const text = raw.toString("utf8").trim();
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new WorkspaceHostCredentialDeliveryProtocolError(
      `revocation ledger for family '${family}' is malformed ('${text.slice(0, 32)}'); refusing to deliver rather than assume nothing was revoked`
    );
  };
  return value;
};
async function recordWorkspaceHostCredentialRevocation(filesystem, root, family, generation, options = {}) {
  const apply = async () => {
    const current = await readWorkspaceHostCredentialRevokedThrough(
      filesystem,
      root,
      family
    );
    if (generation <= current) return;
    await filesystem.ensureDirectory((0,__vite_ssr_import_3__.join)(root, family));
    await filesystem.writePrivateFile(
      workspaceHostCredentialRevocationLedgerPath(root, family),
      Buffer.from(`${generation}
`, "utf8")
    );
  };
  if (options.lockHeld) return await apply();
  await withWorkspaceHostCredentialFilesystemLock(
    filesystem,
    workspaceHostCredentialFamilyLockPath(root, family),
    apply
  );
};
function sameMaterial(a, b) {
  const left = (0,__vite_ssr_import_0__.createHash)("sha256").update(a).digest();
  const right = (0,__vite_ssr_import_0__.createHash)("sha256").update(b).digest();
  return (0,__vite_ssr_import_0__.timingSafeEqual)(left, right);
}
async function executeWorkspaceHostCredentialDelivery(request, deps) {
  const { family, generation } = request;
  const now = deps.now ?? (() => /* @__PURE__ */ new Date());
  if (!__vite_ssr_import_4__.WORKSPACE_HOST_CREDENTIAL_FAMILY_SPECS[family].requiresDeliveredMaterial) {
    throw new WorkspaceHostAmbientCredentialDeliveryError(family);
  };
  return await withWorkspaceHostCredentialFilesystemLock(
    deps.filesystem,
    workspaceHostCredentialFamilyLockPath(deps.materialRoot, family),
    async () => {
      const revokedThrough = await readWorkspaceHostCredentialRevokedThrough(
        deps.filesystem,
        deps.materialRoot,
        family
      );
      if (generation <= revokedThrough) {
        throw new WorkspaceHostRevokedCredentialGenerationError(
          family,
          generation,
          revokedThrough
        );
      };
      const path = workspaceHostCredentialMaterialPath(
        deps.materialRoot,
        family,
        generation
      );
      const existing = await deps.filesystem.readFileIfPresent(path);
      const bytes = request.material.reveal();
      if (existing !== null) {
        if (!sameMaterial(existing, bytes)) {
          throw new WorkspaceHostCredentialGenerationConflictError(
            family,
            generation
          );
        }
      } else {
        await deps.filesystem.ensureDirectory(
          workspaceHostCredentialGenerationDirectory(
            deps.materialRoot,
            family,
            generation
          )
        );
        await deps.filesystem.writePrivateFile(path, bytes);
      };
      const receipt = {
        protocolVersion: WORKSPACE_HOST_CREDENTIAL_DELIVERY_PROTOCOL_VERSION,
        family,
        generation,
        present: true,
        observedAt: now().toISOString()
      };
      (0,__vite_ssr_import_5__.assertWorkspaceHostSecretIsolation)(
        receipt,
        "workspaceHost.credentialDelivery.receipt"
      );
      return receipt;
    }
  );
};
async function handleWorkspaceHostCredentialDeliveryPayload(payload, deps) {
  let parsed;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new WorkspaceHostCredentialDeliveryProtocolError(
      "request body is not valid JSON"
    );
  };
  const request = parseWorkspaceHostCredentialDeliveryRequest(parsed);
  const receipt = await executeWorkspaceHostCredentialDelivery(request, deps);
  return `${JSON.stringify(receipt)}
`;
};
function assertWorkspaceHostCredentialDeliveryArgv(argv) {
  const expected = WORKSPACE_HOST_CREDENTIAL_DELIVERY_ARGV;
  const matches = argv.length === expected.length && expected.every((value, index) => argv[index] === value);
  if (!matches) {
    throw new WorkspaceHostCredentialDeliveryProtocolError(
      `credential delivery expects argv ${expected.join(" ")}, got ${argv.join(" ") || "(none)"}`
    );
  }
};
function encodeWorkspaceHostCredentialDeliveryRequest(input) {
  return {
    protocolVersion: WORKSPACE_HOST_CREDENTIAL_DELIVERY_PROTOCOL_VERSION,
    channel: input.channel,
    credentialRef: input.credentialRef,
    generation: input.generation,
    material: input.material.reveal().toString("base64")
  };
}
//# sourceMappingSource=vite-generated
//# sourceMappingURL=data:application/json;base64,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TztBQUFBLElBQ0wsaUJBQWlCO0FBQUEsSUFDakIsU0FBUyxNQUFNO0FBQUEsSUFDZixlQUFlLE1BQU07QUFBQSxJQUNyQixZQUFZLE1BQU07QUFBQSxJQUNsQixVQUFVLE1BQU0sU0FBUyxPQUFPLEVBQUUsU0FBUyxRQUFRO0FBQUEsRUFDckQ7QUFDRiIsIm5hbWVzIjpbXSwiaWdub3JlTGlzdCI6W10sInNvdXJjZXMiOlsid29ya3NwYWNlLWhvc3QtY3JlZGVudGlhbC1kZWxpdmVyeS50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIENyZWRlbnRpYWwgTUFURVJJQUwgREVMSVZFUlkg4oCUIHRoZSBvbmUgaG9zdCBvcGVyYXRpb24gdGhhdCBjYXJyaWVzIGF1dGhvcml6YXRpb24gYnl0ZXNcbiAqIChQLTA0NiAvIFdJLTQwNDc0LCBwbGFuIGRlY2lzaW9uIEQtMjE1IHBvaW50cyAxLTUpLlxuICpcbiAqIFdIQVQgV0FTIE1JU1NJTkcuIGBQcm9kdWN0aW9uV29ya3NwYWNlSG9zdENyZWRlbnRpYWxNYXRlcmlhbGl6ZXIuYmluZCgpYCB2ZXJpZmllcyB0aGF0XG4gKiBgPG1hdGVyaWFsUm9vdD4vPGZhbWlseT4vPGdlbmVyYXRpb24+L21hdGVyaWFsYCBleGlzdHMgYW5kIHRocm93cyB3aGVuIGl0IGRvZXMgbm90LiBOb3RoaW5nIGluXG4gKiB0aGUgdHJlZSBldmVyIHdyb3RlIHRoYXQgcGF0aCDigJQgYFdPUktTUEFDRV9IT1NUX0NSRURFTlRJQUxfTUFURVJJQUxfUk9PVGAgaGFkIGV4YWN0bHkgb25lXG4gKiByZWFkZXIgYW5kIG5vIHdyaXRlciDigJQgc28gb24gYSByZWFsIGhvc3QgdGhlIGBnaXRgIGFuZCBgYWdlbnRgIGNoYW5uZWxzIGFsd2F5cyB0aHJldyBhdCBiaW5kLFxuICogYW5kIHRoZSBsaXZlIGNhbmFyeSBjb3VsZCBub3QgcGFzcyBieSBjb25zdHJ1Y3Rpb24uIFRoaXMgbW9kdWxlIGlzIHRoZSB3cml0ZXIuXG4gKlxuICogV0hZIElUIElTIE5PVCBBIFNURVAgT04gVEhFIElOSVRJQUxJWkFUSU9OIFBST1RPQ09MIChELTIxNSBwb2ludCAxKS4gRXZlcnkgc3RlcCBhbmQgZXZlcnlcbiAqIHJlY2VpcHQgb24gdGhhdCBwcm90b2NvbCBjcm9zc2VzIGBhc3NlcnRXb3Jrc3BhY2VIb3N0U2VjcmV0SXNvbGF0aW9uYCwgYW5kIHRoZSBHQ1AgYWRhcHRlclxuICogcmVmdXNlcyBjcmVkZW50aWFsIGJ5dGVzIGJ5IG5hbWUuIFRob3NlIHR3byBmYWN0cyBhcmUgd2hhdCBtYWtlIHRoZSBpbml0aWFsaXphdGlvbiBjb250cmFjdFxuICogd29ydGggdHJ1c3Rpbmc6IHlvdSBjYW4gcmVhZCBhbnkgaW5pdGlhbGl6YXRpb24gcmVjZWlwdCwgZnJvbSBhbnkgcHJvdmlkZXIsIGFuZCBrbm93IGl0IGNhbm5vdFxuICogY29udGFpbiBtYXRlcmlhbC4gV2lkZW5pbmcgZWl0aGVyIHRvIGFkbWl0IGEgZGVsaXZlcnkgc3RlcCB3b3VsZCBkZWxldGUgdGhhdCBwcm9wZXJ0eSBmb3IgZXZlcnlcbiAqIE9USEVSIHN0ZXAgYXQgdGhlIHNhbWUgdGltZSDigJQgdGhlIGFzc2VydGlvbiB3b3VsZCBoYXZlIHRvIGxlYXJuIGFuIGV4Y2VwdGlvbiwgYW5kIGFuIGFzc2VydGlvblxuICogd2l0aCBhbiBleGNlcHRpb24gcHJvdmVzIG9ubHkgdGhhdCB0aGUgZXhjZXB0aW9uIHdhcyBub3QgdGFrZW4uIFNvIGRlbGl2ZXJ5IGdldHMgaXRzIG93blxuICogcHJvdG9jb2wgdmVyc2lvbiwgaXRzIG93biBlbnZlbG9wZSwgYW5kIGl0cyBvd24gZW50cnlwb2ludCwgYW5kIHRoZSBpbml0aWFsaXphdGlvbiBwcm90b2NvbFxuICoga2VlcHMgaXRzIHRvdGFsIGJhbi5cbiAqXG4gKiBUSEUgQVNZTU1FVFJZIElTIFRIRSBERVNJR04uIElzb2xhdGlvbiBpcyBhc3NlcnRlZCBvbiB0aGUgd2F5IE9VVCBhbmQgZGVsaWJlcmF0ZWx5IE5PVCBvbiB0aGVcbiAqIHdheSBJTi4gSW5ib3VuZCBpcyB0aGUgc2luZ2xlIGJvdW5kYXJ5IGluIHRoaXMgc3lzdGVtIHdoZXJlIG1hdGVyaWFsIGxlZ2l0aW1hdGVseSBleGlzdHMsIHNvXG4gKiBhc3NlcnRpbmcgdGhlcmUgd291bGQgcmVqZWN0IGV2ZXJ5IHJlYWwgcmVxdWVzdDsgb3V0Ym91bmQgaXMgYXNzZXJ0ZWQgYmVjYXVzZSB0aGUgcmVjZWlwdCBpc1xuICogd2hhdCBnZXRzIHBlcnNpc3RlZCwgcmVwbGljYXRlZCBhbmQgcmVhZCBieSBwZW9wbGUuIE9uZSBkaXJlY3Rpb24gaXMgdGhlIGV4Y2VwdGlvbiwgdGhlIG90aGVyXG4gKiBpcyB0aGUgcnVsZSwgYW5kIHRoZXkgYXJlIHN0YXRlZCBoZXJlIHRvZ2V0aGVyIHNvIG5laXRoZXIgY2FuIGJlIG1pc3Rha2VuIGZvciBhbiBvdmVyc2lnaHQuXG4gKlxuICogTk9USElORyBERVJJVkVEIEZST00gVEhFIEJZVEVTIEVWRVIgTEVBVkVTIChELTIxNSBwb2ludCAzKS4gTm90IHRoZSBtYXRlcmlhbCwgbm90IGEgbGVuZ3RoLCBhbmRcbiAqIG5vdCBhIGRpZ2VzdDogdGhlc2Ugc2VjcmV0cyBhcmUgbG93LWVudHJvcHkgZW5vdWdoIHRoYXQgYSBkaWdlc3QgaXMgYW4gb3JhY2xlIGFnYWluc3QgYSBndWVzc2luZ1xuICogYXR0YWNrZXIuIGB3b3Jrc3BhY2VIb3N0Q3JlZGVudGlhbFJlZmVyZW5jZURpZ2VzdGAgZGVsaWJlcmF0ZWx5IGRpZ2VzdHMgdGhlIFJFRkVSRU5DRSwgd2hpY2ggaXNcbiAqIHB1YmxpYywgYW5kIHRoaXMgbW9kdWxlIGtlZXBzIHRoYXQgbGluZSDigJQgdGhlIHJlY2VpcHQgaXMgYHsgZmFtaWx5LCBnZW5lcmF0aW9uLCBwcmVzZW50OiB0cnVlIH1gXG4gKiBwbHVzIGFuIG9ic2VydmF0aW9uIHRpbWVzdGFtcCwgYW5kIGEgdGVzdCBwaW5zIHRoYXQgaXQgbmV2ZXIgZ3Jvd3MgYSBzaXplIG9yIGRpZ2VzdCBmaWVsZC5cbiAqL1xuaW1wb3J0IHsgY3JlYXRlSGFzaCwgcmFuZG9tVVVJRCwgdGltaW5nU2FmZUVxdWFsIH0gZnJvbSBcIm5vZGU6Y3J5cHRvXCI7XG5pbXBvcnQgeyBob3N0bmFtZSB9IGZyb20gXCJub2RlOm9zXCI7XG5pbXBvcnQge1xuICBjaG1vZCxcbiAgbHN0YXQsXG4gIG1rZGlyLFxuICByZWFkRmlsZSxcbiAgcmVhZGxpbmssXG4gIHJlbmFtZSxcbiAgcm0sXG4gIHdyaXRlRmlsZSxcbn0gZnJvbSBcIm5vZGU6ZnMvcHJvbWlzZXNcIjtcbmltcG9ydCB7IGJhc2VuYW1lLCBkaXJuYW1lLCBpc0Fic29sdXRlLCBqb2luLCBub3JtYWxpemUgfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5cbmltcG9ydCB7XG4gIFdPUktTUEFDRV9IT1NUX0NSRURFTlRJQUxfRkFNSUxZX1NQRUNTLFxuICBwYXJzZVdvcmtzcGFjZUhvc3RDcmVkZW50aWFsUmVmZXJlbmNlLFxuICB0eXBlIFdvcmtzcGFjZUhvc3RDcmVkZW50aWFsRmFtaWx5LFxufSBmcm9tIFwiLi93b3Jrc3BhY2UtaG9zdC1jcmVkZW50aWFsLW5hbWVzcGFjZVwiO1xuaW1wb3J0IHR5cGUgeyBXb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbENoYW5uZWwgfSBmcm9tIFwiLi93b3Jrc3BhY2UtaG9zdC1pbml0aWFsaXphdGlvblwiO1xuaW1wb3J0IHsgYXNzZXJ0V29ya3NwYWNlSG9zdFNlY3JldElzb2xhdGlvbiB9IGZyb20gXCIuL3dvcmtzcGFjZS1ob3N0LXRlc3QtaGFybmVzc1wiO1xuXG4vKipcbiAqIFRoZSBkZWxpdmVyeSB3aXJlIHZlcnNpb24uIERpc3RpbmN0IGZyb20gdGhlIGluaXRpYWxpemF0aW9uIHByb3RvY29sJ3MgdmVyc2lvbiBvbiBwdXJwb3NlOiB0aGVcbiAqIHR3byBwcm90b2NvbHMgY2FycnkgZGlmZmVyZW50IHRoaW5ncyB1bmRlciBkaWZmZXJlbnQgcnVsZXMsIGFuZCBhIGhvc3QgdGhhdCBzcGVha3Mgb25lIGhhcyBzYWlkXG4gKiBub3RoaW5nIGFib3V0IHdoZXRoZXIgaXQgc3BlYWtzIHRoZSBvdGhlci5cbiAqL1xuZXhwb3J0IGNvbnN0IFdPUktTUEFDRV9IT1NUX0NSRURFTlRJQUxfREVMSVZFUllfUFJPVE9DT0xfVkVSU0lPTiA9XG4gIFwicGFwZXJjdXNwLXdvcmtzcGFjZS1ob3N0LWNyZWRlbnRpYWwtZGVsaXZlcnktdjFcIjtcblxuLyoqIEZpeGVkIGFyZ3YgdGhlIGNvbnRyb2xsZXIgcGFzc2VzOyB0aGUgQ0xJIHJlZnVzZXMgYW55dGhpbmcgZWxzZS4gKi9cbmV4cG9ydCBjb25zdCBXT1JLU1BBQ0VfSE9TVF9DUkVERU5USUFMX0RFTElWRVJZX0FSR1YgPSBbXG4gIFwiLS1wcm90b2NvbC12ZXJzaW9uXCIsXG4gIFdPUktTUEFDRV9IT1NUX0NSRURFTlRJQUxfREVMSVZFUllfUFJPVE9DT0xfVkVSU0lPTixcbiAgXCItLWpzb24tc3RkaW5cIixcbl0gYXMgY29uc3Q7XG5cbi8qKlxuICogVXBwZXIgYm91bmQgb24gb25lIGRlbGl2ZXJlZCBhcnRpZmFjdC5cbiAqXG4gKiBEZWxpdmVyeSBpcyByZWFjaGFibGUgYnkgYW55dGhpbmcgdGhhdCBjYW4gcnVuIHRoZSBob3N0IGVudHJ5cG9pbnQsIHNvIGFuIHVuYm91bmRlZCB3cml0ZSBpcyBhXG4gKiB3YXkgdG8gZmlsbCB0aGUgaG9zdCdzIGRpc2suIEV2ZXJ5IHJlYWwgYXJ0aWZhY3QgaW4gdGhlIGZvdXIgZmFtaWxpZXMgaXMgYSB0b2tlbiwgYSBzaG9ydC1saXZlZFxuICogZGVsZWdhdGlvbiBvciBhIHNlYWxlZCByZWZlcmVuY2Ug4oCUIGtpbG9ieXRlcyBhdCBtb3N0LlxuICovXG5leHBvcnQgY29uc3QgV09SS1NQQUNFX0hPU1RfQ1JFREVOVElBTF9NQVRFUklBTF9NQVhfQllURVMgPSAyNTYgKiAxMDI0O1xuXG4vKiogRmlsZSBuYW1lIHVuZGVyIHRoZSBnZW5lcmF0aW9uIGRpcmVjdG9yeS4gU2luZ2xlIGRlZmluaXRpb247IGV2ZXJ5IHBhdGggaGVscGVyIHVzZXMgaXQuICovXG5jb25zdCBNQVRFUklBTF9GSUxFID0gXCJtYXRlcmlhbFwiO1xuXG4vKipcbiAqIFBlci1mYW1pbHkgbGVkZ2VyIHJlY29yZGluZyB0aGUgaGlnaGVzdCBnZW5lcmF0aW9uIHRoYXQgYHJldm9rZSgpYCBoYXMgZGVzdHJveWVkLlxuICpcbiAqIFRoaXMgZXhpc3RzIGJlY2F1c2UgRC0yMTUgcG9pbnQgNSByZXF1aXJlcyBkZWxpdmVyeSBuZXZlciB0byByZXN1cnJlY3QgYSByZXZva2VkIGdlbmVyYXRpb24sXG4gKiBhbmQgcmV2b2NhdGlvbidzIG9ubHkgb3RoZXIgdHJhY2UgaXMgYW4gQUJTRU5DRSDigJQgdGhlIG1hdGVyaWFsIGZpbGUgaXMgdW5saW5rZWQuIEFic2VuY2UgY2Fubm90XG4gKiBjYXJyeSB0aGF0IG1lYW5pbmc6IGEgZ2VuZXJhdGlvbiB0aGF0IHdhcyByZXZva2VkIGFuZCBvbmUgdGhhdCB3YXMgbmV2ZXIgZGVsaXZlcmVkIGxvb2tcbiAqIGlkZW50aWNhbCBvbiBkaXNrLCBzbyBhIGRlbGl2ZXJ5IHRoYXQga2V5ZWQgb24gXCJ0aGUgZmlsZSBpcyBtaXNzaW5nXCIgd291bGQgaGFwcGlseSByZS1jcmVhdGVcbiAqIG1hdGVyaWFsIHRoZSBjb250cm9sbGVyIGhhZCBhbHJlYWR5IGRlc3Ryb3llZC4gQSBtb25vdG9uaWMgaGlnaC13YXRlciBtYXJrIHN0YXRlcyB0aGUgZmFjdFxuICogcG9zaXRpdmVseSBpbnN0ZWFkIG9mIGluZmVycmluZyBpdCBmcm9tIGEgc2lkZSBlZmZlY3QuXG4gKi9cbmNvbnN0IFJFVk9DQVRJT05fTEVER0VSX0ZJTEUgPSBcInJldm9rZWQtdGhyb3VnaFwiO1xuXG4vKiAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0gKi9cbi8qIE9uLWhvc3QgbGF5b3V0IOKAlCBvbmUgZGVmaW5pdGlvbiwgc2hhcmVkIGJ5IHRoZSB3cml0ZXIgYW5kIHRoZSBtYXRlcmlhbGl6ZXIgICAgICAgICAgICAgICAgICAgKi9cbi8qIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLSAqL1xuXG4vKiogVGhlIGRpcmVjdG9yeSBob2xkaW5nIG9uZSBnZW5lcmF0aW9uJ3MgYXJ0aWZhY3RzLiBDcmVhdGVkIGAwNzAwYC4gKi9cbmV4cG9ydCBmdW5jdGlvbiB3b3Jrc3BhY2VIb3N0Q3JlZGVudGlhbEdlbmVyYXRpb25EaXJlY3RvcnkoXG4gIHJvb3Q6IHN0cmluZyxcbiAgZmFtaWx5OiBXb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbEZhbWlseSxcbiAgZ2VuZXJhdGlvbjogbnVtYmVyLFxuKTogc3RyaW5nIHtcbiAgcmV0dXJuIGpvaW4ocm9vdCwgZmFtaWx5LCBgJHtnZW5lcmF0aW9ufWApO1xufVxuXG4vKipcbiAqIFRoZSBzaW5nbGUgcGF0aCBkZWxpdmVyeSB3cml0ZXMgYW5kIGBiaW5kKClgIGNoZWNrcyAoRC0yMTUgcG9pbnQgMikuXG4gKlxuICogRXhwb3J0ZWQgc28gYG1hdGVyaWFsUGF0aEZvcmAgaW4gdGhlIHJlbW90ZS1pbml0aWFsaXplciBob3N0IGRlcml2ZXMgaXRzIHBhdGggZnJvbSBIRVJFIHJhdGhlclxuICogdGhhbiBvcGVuLWNvZGluZyB0aGUgc2FtZSBgam9pbmAuIFR3byBjb3BpZXMgb2YgYSBwYXRoIGxheW91dCBpcyB0aGUgY2xhc3NpYyBzaWxlbnQgZGl2ZXJnZW5jZTpcbiAqIGJvdGggc2lkZXMga2VlcCB3b3JraW5nLCBhZ2FpbnN0IGRpZmZlcmVudCBmaWxlcy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHdvcmtzcGFjZUhvc3RDcmVkZW50aWFsTWF0ZXJpYWxQYXRoKFxuICByb290OiBzdHJpbmcsXG4gIGZhbWlseTogV29ya3NwYWNlSG9zdENyZWRlbnRpYWxGYW1pbHksXG4gIGdlbmVyYXRpb246IG51bWJlcixcbik6IHN0cmluZyB7XG4gIHJldHVybiBqb2luKFxuICAgIHdvcmtzcGFjZUhvc3RDcmVkZW50aWFsR2VuZXJhdGlvbkRpcmVjdG9yeShyb290LCBmYW1pbHksIGdlbmVyYXRpb24pLFxuICAgIE1BVEVSSUFMX0ZJTEUsXG4gICk7XG59XG5cbi8qKiBUaGUgcGVyLWZhbWlseSByZXZvY2F0aW9uIGhpZ2gtd2F0ZXIgbWFyay4gKi9cbmV4cG9ydCBmdW5jdGlvbiB3b3Jrc3BhY2VIb3N0Q3JlZGVudGlhbFJldm9jYXRpb25MZWRnZXJQYXRoKFxuICByb290OiBzdHJpbmcsXG4gIGZhbWlseTogV29ya3NwYWNlSG9zdENyZWRlbnRpYWxGYW1pbHksXG4pOiBzdHJpbmcge1xuICByZXR1cm4gam9pbihyb290LCBmYW1pbHksIFJFVk9DQVRJT05fTEVER0VSX0ZJTEUpO1xufVxuXG4vKiAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0gKi9cbi8qIFRoZSBtYXRlcmlhbCBib3ggICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICovXG4vKiAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0gKi9cblxuLyoqXG4gKiBBIGhvbGRlciBmb3IgYXV0aG9yaXphdGlvbiBieXRlcyB0aGF0IHJlZnVzZXMgdG8gc2VyaWFsaXplIGl0c2VsZi5cbiAqXG4gKiBUaGUgcmVhbGlzdGljIGxlYWsgaGVyZSBpcyBub3Qgc29tZW9uZSBkZWxpYmVyYXRlbHkgZW1pdHRpbmcgdGhlIG1hdGVyaWFsIOKAlCBpdCBpcyBhIGRpYWdub3N0aWM6XG4gKiBhIGBKU09OLnN0cmluZ2lmeShyZXF1ZXN0KWAgaW4gYW4gZXJyb3IgcGF0aCwgYSBgY29uc29sZS5lcnJvcih7IHJlcXVlc3QgfSlgLCBhIHN0cnVjdHVyZWQgbG9nXG4gKiB0aGF0IGNhcHR1cmVzIGl0cyB3aG9sZSBpbnB1dC4gRWFjaCBpcyBhIG9uZS1saW5lIGNoYW5nZSB0aGF0IGxvb2tzIGhhcm1sZXNzIGF0IHRoZSBjYWxsIHNpdGVcbiAqIGFuZCBpcyBpbnZpc2libGUgaW4gcmV2aWV3LiBPdmVycmlkaW5nIGB0b0pTT05gLCBgdG9TdHJpbmdgIGFuZCBub2RlJ3MgaW5zcGVjdCBzeW1ib2wgbWFrZXMgYWxsXG4gKiB0aHJlZSByZW5kZXIgYFtyZWRhY3RlZF1gLCBzbyB0aGUgYnl0ZXMgbGVhdmUgb25seSB0aHJvdWdoIGByZXZlYWwoKWAg4oCUIGEgbmFtZSB0aGF0IGNhbm5vdCBiZVxuICogdHlwZWQgYnkgYWNjaWRlbnQgYW5kIGlzIGdyZXBwYWJsZSB3aGVuIGF1ZGl0aW5nIHdobyB0b3VjaGVzIG1hdGVyaWFsLlxuICovXG5leHBvcnQgY2xhc3MgV29ya3NwYWNlSG9zdENyZWRlbnRpYWxNYXRlcmlhbCB7XG4gIHJlYWRvbmx5ICNieXRlczogQnVmZmVyO1xuXG4gIGNvbnN0cnVjdG9yKGJ5dGVzOiBCdWZmZXIpIHtcbiAgICB0aGlzLiNieXRlcyA9IGJ5dGVzO1xuICB9XG5cbiAgLyoqIFRoZSBvbmx5IHdheSBvdXQuIERlbGliZXJhdGVseSBleHBsaWNpdCBhdCBldmVyeSBjYWxsIHNpdGUuICovXG4gIHJldmVhbCgpOiBCdWZmZXIge1xuICAgIHJldHVybiB0aGlzLiNieXRlcztcbiAgfVxuXG4gIHRvSlNPTigpOiBzdHJpbmcge1xuICAgIHJldHVybiBcIltyZWRhY3RlZF1cIjtcbiAgfVxuXG4gIHRvU3RyaW5nKCk6IHN0cmluZyB7XG4gICAgcmV0dXJuIFwiW3JlZGFjdGVkXVwiO1xuICB9XG5cbiAgZ2V0IFtTeW1ib2wudG9TdHJpbmdUYWddKCk6IHN0cmluZyB7XG4gICAgcmV0dXJuIFwiV29ya3NwYWNlSG9zdENyZWRlbnRpYWxNYXRlcmlhbFwiO1xuICB9XG5cbiAgW1N5bWJvbC5mb3IoXCJub2RlanMudXRpbC5pbnNwZWN0LmN1c3RvbVwiKV0oKTogc3RyaW5nIHtcbiAgICByZXR1cm4gXCJXb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbE1hdGVyaWFsIFtyZWRhY3RlZF1cIjtcbiAgfVxufVxuXG4vKiAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0gKi9cbi8qIEVycm9ycyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICovXG4vKiAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0gKi9cblxuZXhwb3J0IGNsYXNzIFdvcmtzcGFjZUhvc3RDcmVkZW50aWFsRGVsaXZlcnlQcm90b2NvbEVycm9yIGV4dGVuZHMgRXJyb3Ige1xuICBjb25zdHJ1Y3RvcihtZXNzYWdlOiBzdHJpbmcpIHtcbiAgICBzdXBlcihtZXNzYWdlKTtcbiAgICB0aGlzLm5hbWUgPSBcIldvcmtzcGFjZUhvc3RDcmVkZW50aWFsRGVsaXZlcnlQcm90b2NvbEVycm9yXCI7XG4gIH1cbn1cblxuLyoqXG4gKiBUaGUgZmFtaWx5IGlzIGFuc3dlcmVkIGFtYmllbnRseSBhbmQgbXVzdCBuZXZlciBoYXZlIGEgZmlsZSAoRC0yMTUgcG9pbnQgNCkuXG4gKlxuICogVHlwZWQgc2VwYXJhdGVseSBiZWNhdXNlIGl0IGlzIG5vdCBhIG1hbGZvcm1lZCByZXF1ZXN0IOKAlCBpdCBpcyBhIGNvaGVyZW50IHJlcXVlc3QgZm9yIHNvbWV0aGluZ1xuICogdGhhdCBtdXN0IG5vdCBleGlzdC4gV3JpdGluZyBhIGZpbGUgZm9yIGBjbG91ZC13b3JrbG9hZC1pZGVudGl0eWAgd291bGQgbWFrZSBgYmluZCgpYCBzdWNjZWVkXG4gKiBhZ2FpbnN0IGEgcGF0aCB3ZSBjcmVhdGVkIG91cnNlbHZlcywgd2hpY2ggaXMgcHJlY2lzZWx5IHRoZSBzZWxmLWNvbmZpcm1pbmcgY2hlY2sgdGhhdFxuICogYG1hdGVyaWFsUGF0aEZvcmAncyBudWxsIGJyYW5jaCBleGlzdHMgdG8gcHJldmVudC5cbiAqL1xuZXhwb3J0IGNsYXNzIFdvcmtzcGFjZUhvc3RBbWJpZW50Q3JlZGVudGlhbERlbGl2ZXJ5RXJyb3IgZXh0ZW5kcyBFcnJvciB7XG4gIHJlYWRvbmx5IGZhbWlseTogV29ya3NwYWNlSG9zdENyZWRlbnRpYWxGYW1pbHk7XG5cbiAgY29uc3RydWN0b3IoZmFtaWx5OiBXb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbEZhbWlseSkge1xuICAgIHN1cGVyKFxuICAgICAgYENyZWRlbnRpYWwgZmFtaWx5ICcke2ZhbWlseX0nIGlzIGFuc3dlcmVkIGFtYmllbnRseSBieSB0aGUgaG9zdCBlbnZpcm9ubWVudCBhbmQgbXVzdCBub3QgYCArXG4gICAgICAgIGByZWNlaXZlIGRlbGl2ZXJlZCBtYXRlcmlhbC4gV3JpdGluZyBhIGZpbGUgZm9yIGl0IHdvdWxkIG1ha2UgYmluZCgpIHBhc3MgYWdhaW5zdCBhIHBhdGggYCArXG4gICAgICAgIGBkZWxpdmVyeSBjcmVhdGVkIGl0c2VsZi5gLFxuICAgICk7XG4gICAgdGhpcy5uYW1lID0gXCJXb3Jrc3BhY2VIb3N0QW1iaWVudENyZWRlbnRpYWxEZWxpdmVyeUVycm9yXCI7XG4gICAgdGhpcy5mYW1pbHkgPSBmYW1pbHk7XG4gIH1cbn1cblxuLyoqIEEgZ2VuZXJhdGlvbiBhdCBvciBiZWxvdyB0aGUgcmV2b2NhdGlvbiBoaWdoLXdhdGVyIG1hcmsgd2FzIG9mZmVyZWQgYWdhaW4gKEQtMjE1IHBvaW50IDUpLiAqL1xuZXhwb3J0IGNsYXNzIFdvcmtzcGFjZUhvc3RSZXZva2VkQ3JlZGVudGlhbEdlbmVyYXRpb25FcnJvciBleHRlbmRzIEVycm9yIHtcbiAgcmVhZG9ubHkgZmFtaWx5OiBXb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbEZhbWlseTtcbiAgcmVhZG9ubHkgZ2VuZXJhdGlvbjogbnVtYmVyO1xuICByZWFkb25seSByZXZva2VkVGhyb3VnaDogbnVtYmVyO1xuXG4gIGNvbnN0cnVjdG9yKFxuICAgIGZhbWlseTogV29ya3NwYWNlSG9zdENyZWRlbnRpYWxGYW1pbHksXG4gICAgZ2VuZXJhdGlvbjogbnVtYmVyLFxuICAgIHJldm9rZWRUaHJvdWdoOiBudW1iZXIsXG4gICkge1xuICAgIHN1cGVyKFxuICAgICAgYEdlbmVyYXRpb24gJHtnZW5lcmF0aW9ufSBvZiBmYW1pbHkgJyR7ZmFtaWx5fScgY2Fubm90IGJlIGRlbGl2ZXJlZDogZ2VuZXJhdGlvbnMgdGhyb3VnaCBgICtcbiAgICAgICAgYCR7cmV2b2tlZFRocm91Z2h9IGhhdmUgYmVlbiByZXZva2VkIG9uIHRoaXMgaG9zdC4gUm90YXRpb24gbXVzdCBpc3N1ZSBhIHN0cmljdGx5IGAgK1xuICAgICAgICBgaW5jcmVhc2luZyBnZW5lcmF0aW9uIHdpdGggYSBuZXcgcmV2b2NhdGlvbiByZWZlcmVuY2UuYCxcbiAgICApO1xuICAgIHRoaXMubmFtZSA9IFwiV29ya3NwYWNlSG9zdFJldm9rZWRDcmVkZW50aWFsR2VuZXJhdGlvbkVycm9yXCI7XG4gICAgdGhpcy5mYW1pbHkgPSBmYW1pbHk7XG4gICAgdGhpcy5nZW5lcmF0aW9uID0gZ2VuZXJhdGlvbjtcbiAgICB0aGlzLnJldm9rZWRUaHJvdWdoID0gcmV2b2tlZFRocm91Z2g7XG4gIH1cbn1cblxuLyoqXG4gKiBUaGUgc2FtZSBnZW5lcmF0aW9uIHdhcyBvZmZlcmVkIHdpdGggZGlmZmVyZW50IGJ5dGVzLlxuICpcbiAqIFNpbGVudGx5IGtlZXBpbmcgdGhlIGZpcnN0IGRlbGl2ZXJ5IHdvdWxkIGxlYXZlIHRoZSBob3N0IGF1dGhlbnRpY2F0aW5nIHdpdGggbWF0ZXJpYWwgdGhlXG4gKiBjb250cm9sbGVyIGJlbGlldmVzIGl0IHJlcGxhY2VkIOKAlCBhIGRpdmVyZ2VuY2UgdGhhdCBzdXJmYWNlcyBtdWNoIGxhdGVyIGFzIGFuIHVuZXhwbGFpbmVkXG4gKiBhdXRob3JpemF0aW9uIGZhaWx1cmUuIEEgZ2VuZXJhdGlvbiBuYW1lcyBpdHMgbWF0ZXJpYWw7IGNoYW5naW5nIHRoZSBtYXRlcmlhbCBtZWFucyByb3RhdGluZy5cbiAqL1xuZXhwb3J0IGNsYXNzIFdvcmtzcGFjZUhvc3RDcmVkZW50aWFsR2VuZXJhdGlvbkNvbmZsaWN0RXJyb3IgZXh0ZW5kcyBFcnJvciB7XG4gIHJlYWRvbmx5IGZhbWlseTogV29ya3NwYWNlSG9zdENyZWRlbnRpYWxGYW1pbHk7XG4gIHJlYWRvbmx5IGdlbmVyYXRpb246IG51bWJlcjtcblxuICBjb25zdHJ1Y3RvcihmYW1pbHk6IFdvcmtzcGFjZUhvc3RDcmVkZW50aWFsRmFtaWx5LCBnZW5lcmF0aW9uOiBudW1iZXIpIHtcbiAgICBzdXBlcihcbiAgICAgIGBHZW5lcmF0aW9uICR7Z2VuZXJhdGlvbn0gb2YgZmFtaWx5ICcke2ZhbWlseX0nIGlzIGFscmVhZHkgcHJlc2VudCBvbiB0aGlzIGhvc3Qgd2l0aCBgICtcbiAgICAgICAgYGRpZmZlcmVudCBtYXRlcmlhbC4gRGVsaXZlcnkgaXMgaWRlbXBvdGVudCBwZXIgKGZhbWlseSwgZ2VuZXJhdGlvbik7IHJlcGxhY2luZyBtYXRlcmlhbCBgICtcbiAgICAgICAgYHJlcXVpcmVzIGEgbmV3IGdlbmVyYXRpb24uYCxcbiAgICApO1xuICAgIHRoaXMubmFtZSA9IFwiV29ya3NwYWNlSG9zdENyZWRlbnRpYWxHZW5lcmF0aW9uQ29uZmxpY3RFcnJvclwiO1xuICAgIHRoaXMuZmFtaWx5ID0gZmFtaWx5O1xuICAgIHRoaXMuZ2VuZXJhdGlvbiA9IGdlbmVyYXRpb247XG4gIH1cbn1cblxuLyogLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tICovXG4vKiBSZXF1ZXN0IC8gcmVjZWlwdCAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAqL1xuLyogLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tICovXG5cbi8qKlxuICogT25lIGRlbGl2ZXJ5LlxuICpcbiAqIFRoZSBGQU1JTFkgaXMgbm90IGEgZmllbGQuIEl0IGlzIGRlcml2ZWQgZnJvbSBgY3JlZGVudGlhbFJlZmAgdGhyb3VnaCB0aGUgbmFtZXNwYWNlIHBhcnNlciwgc29cbiAqIGEgcmVxdWVzdCBjYW5ub3QgbmFtZSBvbmUgZmFtaWx5IHdoaWxlIGNhcnJ5aW5nIGFub3RoZXIgZmFtaWx5J3MgcmVmZXJlbmNlIOKAlCBhIGRpc2FncmVlbWVudFxuICogdGhhdCB3b3VsZCBvdGhlcndpc2UgYmUgcmVzb2x2ZWQgc2lsZW50bHksIGluIGZhdm91ciBvZiB3aGljaGV2ZXIgZmllbGQgdGhlIHJlYWRlciBoYXBwZW5lZCB0b1xuICogY29uc3VsdC5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBXb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbERlbGl2ZXJ5UmVxdWVzdCB7XG4gIHJlYWRvbmx5IHByb3RvY29sVmVyc2lvbjogdHlwZW9mIFdPUktTUEFDRV9IT1NUX0NSRURFTlRJQUxfREVMSVZFUllfUFJPVE9DT0xfVkVSU0lPTjtcbiAgcmVhZG9ubHkgY2hhbm5lbDogV29ya3NwYWNlSG9zdENyZWRlbnRpYWxDaGFubmVsO1xuICByZWFkb25seSBjcmVkZW50aWFsUmVmOiBzdHJpbmc7XG4gIHJlYWRvbmx5IGZhbWlseTogV29ya3NwYWNlSG9zdENyZWRlbnRpYWxGYW1pbHk7XG4gIHJlYWRvbmx5IGdlbmVyYXRpb246IG51bWJlcjtcbiAgcmVhZG9ubHkgbWF0ZXJpYWw6IFdvcmtzcGFjZUhvc3RDcmVkZW50aWFsTWF0ZXJpYWw7XG59XG5cbi8qKlxuICogV2hhdCB0aGUgY29udHJvbGxlciBwZXJzaXN0cyAoRC0yMTUgcG9pbnQgMykuXG4gKlxuICogYGZhbWlseWAsIGBnZW5lcmF0aW9uYCBhbmQgYHByZXNlbnRgIGFyZSB0aGUgZGVjaXNpb24ncyBleGFjdCB0aHJlZSBmaWVsZHMuIGBwcm90b2NvbFZlcnNpb25gXG4gKiBhbmQgYG9ic2VydmVkQXRgIGFyZSBwcm9wZXJ0aWVzIG9mIHRoZSBFWENIQU5HRSwgbm90IG9mIHRoZSBieXRlcyDigJQgdGhlIHNhbWUgdHdvIHRoZVxuICogaW5pdGlhbGl6YXRpb24gcHJvdG9jb2wncyByZWNlaXB0cyBjYXJyeSwgYW5kIG5laXRoZXIgbmFycm93cyB0aGUgbWF0ZXJpYWwncyB2YWx1ZS4gVGhlcmUgaXMgbm9cbiAqIHNpemUgYW5kIG5vIGRpZ2VzdCBoZXJlLCBhbmQgYHdvcmtzcGFjZS1ob3N0LWNyZWRlbnRpYWwtZGVsaXZlcnkudGVzdC50c2AgYXNzZXJ0cyB0aGUgcmVjZWlwdCdzXG4gKiBrZXkgc2V0IGV4YWN0bHkgc28gdGhhdCBhZGRpbmcgb25lIGlzIGEgdGVzdCBmYWlsdXJlIHJhdGhlciB0aGFuIGEgY29kZSByZXZpZXcgc29tZW9uZSBoYXMgdG9cbiAqIGNhdGNoLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIFdvcmtzcGFjZUhvc3RDcmVkZW50aWFsRGVsaXZlcnlSZWNlaXB0IHtcbiAgcmVhZG9ubHkgcHJvdG9jb2xWZXJzaW9uOiB0eXBlb2YgV09SS1NQQUNFX0hPU1RfQ1JFREVOVElBTF9ERUxJVkVSWV9QUk9UT0NPTF9WRVJTSU9OO1xuICByZWFkb25seSBmYW1pbHk6IFdvcmtzcGFjZUhvc3RDcmVkZW50aWFsRmFtaWx5O1xuICByZWFkb25seSBnZW5lcmF0aW9uOiBudW1iZXI7XG4gIHJlYWRvbmx5IHByZXNlbnQ6IHRydWU7XG4gIHJlYWRvbmx5IG9ic2VydmVkQXQ6IHN0cmluZztcbn1cblxuZnVuY3Rpb24gcmVxdWlyZU9iamVjdChcbiAgdmFsdWU6IHVua25vd24sXG4gIGxhYmVsOiBzdHJpbmcsXG4pOiBSZWFkb25seTxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4ge1xuICBpZiAoIXZhbHVlIHx8IHR5cGVvZiB2YWx1ZSAhPT0gXCJvYmplY3RcIiB8fCBBcnJheS5pc0FycmF5KHZhbHVlKSkge1xuICAgIHRocm93IG5ldyBXb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbERlbGl2ZXJ5UHJvdG9jb2xFcnJvcihcbiAgICAgIGAke2xhYmVsfSBtdXN0IGJlIGFuIG9iamVjdGAsXG4gICAgKTtcbiAgfVxuICByZXR1cm4gdmFsdWUgYXMgUmVhZG9ubHk8UmVjb3JkPHN0cmluZywgdW5rbm93bj4+O1xufVxuXG5mdW5jdGlvbiByZXF1aXJlU3RyaW5nKHZhbHVlOiB1bmtub3duLCBsYWJlbDogc3RyaW5nKTogc3RyaW5nIHtcbiAgaWYgKHR5cGVvZiB2YWx1ZSAhPT0gXCJzdHJpbmdcIiB8fCB2YWx1ZS5sZW5ndGggPT09IDApIHtcbiAgICB0aHJvdyBuZXcgV29ya3NwYWNlSG9zdENyZWRlbnRpYWxEZWxpdmVyeVByb3RvY29sRXJyb3IoXG4gICAgICBgJHtsYWJlbH0gbXVzdCBiZSBhIG5vbi1lbXB0eSBzdHJpbmdgLFxuICAgICk7XG4gIH1cbiAgcmV0dXJuIHZhbHVlO1xufVxuXG4vKipcbiAqIERlY29kZSB0aGUgYmFzZTY0IG1hdGVyaWFsLlxuICpcbiAqIFRoZSByb3VuZC10cmlwIGNoZWNrIG1hdHRlcnM6IGBCdWZmZXIuZnJvbWAgaXMgbGVuaWVudCBhbmQgc2lsZW50bHkgZHJvcHMgY2hhcmFjdGVycyBpdCBkb2VzIG5vdFxuICogcmVjb2duaXNlLCBzbyBhIGNvcnJ1cHRlZCBwYXlsb2FkIHdvdWxkIGRlY29kZSB0byBwbGF1c2libGUtbG9va2luZyBnYXJiYWdlIGFuZCBiZSB3cml0dGVuIGFzXG4gKiB0aGUgY3JlZGVudGlhbC4gVGhlIGZhaWx1cmUgd291bGQgdGhlbiBhcHBlYXIgYXMgYW4gYXV0aGVudGljYXRpb24gZXJyb3Igb24gdGhlIGhvc3QsIGRheXMgZnJvbVxuICogaGVyZSwgd2l0aCBub3RoaW5nIHBvaW50aW5nIGJhY2sgYXQgdGhlIHRyYW5zcG9ydC4gUmUtZW5jb2RpbmcgYW5kIGNvbXBhcmluZyB0dXJucyB0aGF0IGludG8gYVxuICogcmVmdXNhbCBhdCB0aGUgYm91bmRhcnkuXG4gKi9cbmZ1bmN0aW9uIGRlY29kZU1hdGVyaWFsKHZhbHVlOiB1bmtub3duKTogV29ya3NwYWNlSG9zdENyZWRlbnRpYWxNYXRlcmlhbCB7XG4gIGNvbnN0IGVuY29kZWQgPSByZXF1aXJlU3RyaW5nKHZhbHVlLCBcInJlcXVlc3QubWF0ZXJpYWxcIik7XG4gIGNvbnN0IGJ5dGVzID0gQnVmZmVyLmZyb20oZW5jb2RlZCwgXCJiYXNlNjRcIik7XG4gIGlmIChieXRlcy5sZW5ndGggPT09IDApIHtcbiAgICB0aHJvdyBuZXcgV29ya3NwYWNlSG9zdENyZWRlbnRpYWxEZWxpdmVyeVByb3RvY29sRXJyb3IoXG4gICAgICBcInJlcXVlc3QubWF0ZXJpYWwgZGVjb2RlZCB0byB6ZXJvIGJ5dGVzOyBkZWxpdmVyeSBtdXN0IGNhcnJ5IG1hdGVyaWFsXCIsXG4gICAgKTtcbiAgfVxuICBpZiAoYnl0ZXMudG9TdHJpbmcoXCJiYXNlNjRcIikgIT09IGVuY29kZWQucmVwbGFjZSgvXFxzKy9nLCBcIlwiKSkge1xuICAgIHRocm93IG5ldyBXb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbERlbGl2ZXJ5UHJvdG9jb2xFcnJvcihcbiAgICAgIFwicmVxdWVzdC5tYXRlcmlhbCBpcyBub3QgY2Fub25pY2FsIGJhc2U2NFwiLFxuICAgICk7XG4gIH1cbiAgaWYgKGJ5dGVzLmxlbmd0aCA+IFdPUktTUEFDRV9IT1NUX0NSRURFTlRJQUxfTUFURVJJQUxfTUFYX0JZVEVTKSB7XG4gICAgdGhyb3cgbmV3IFdvcmtzcGFjZUhvc3RDcmVkZW50aWFsRGVsaXZlcnlQcm90b2NvbEVycm9yKFxuICAgICAgYHJlcXVlc3QubWF0ZXJpYWwgZXhjZWVkcyAke1dPUktTUEFDRV9IT1NUX0NSRURFTlRJQUxfTUFURVJJQUxfTUFYX0JZVEVTfSBieXRlc2AsXG4gICAgKTtcbiAgfVxuICByZXR1cm4gbmV3IFdvcmtzcGFjZUhvc3RDcmVkZW50aWFsTWF0ZXJpYWwoYnl0ZXMpO1xufVxuXG4vKipcbiAqIFZhbGlkYXRlIGFuIGluYm91bmQgZGVsaXZlcnkgZW52ZWxvcGUuXG4gKlxuICogTm90ZSB3aGF0IGlzIGFic2VudDogYGFzc2VydFdvcmtzcGFjZUhvc3RTZWNyZXRJc29sYXRpb25gIGlzIE5PVCBydW4gb3ZlciB0aGUgcmVxdWVzdC4gVGhhdCBpc1xuICogdGhlIGRlbGliZXJhdGUgYXN5bW1ldHJ5IGRlc2NyaWJlZCBhdCB0aGUgdG9wIG9mIHRoaXMgZmlsZSDigJQgdGhpcyBpcyB0aGUgb25lIGVudmVsb3BlIGluIHRoZVxuICogc3lzdGVtIHRoYXQgaXMgU1VQUE9TRUQgdG8gY29udGFpbiBtYXRlcmlhbCwgYW5kIGFzc2VydGluZyBoZXJlIHdvdWxkIHJlamVjdCBldmVyeSByZWFsXG4gKiBkZWxpdmVyeS4gVGhlIHJlY2VpcHQgaXMgYXNzZXJ0ZWQgaW5zdGVhZC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlV29ya3NwYWNlSG9zdENyZWRlbnRpYWxEZWxpdmVyeVJlcXVlc3QoXG4gIHJhdzogdW5rbm93bixcbik6IFdvcmtzcGFjZUhvc3RDcmVkZW50aWFsRGVsaXZlcnlSZXF1ZXN0IHtcbiAgY29uc3QgYm9keSA9IHJlcXVpcmVPYmplY3QocmF3LCBcInJlcXVlc3RcIik7XG4gIGlmIChcbiAgICBib2R5LnByb3RvY29sVmVyc2lvbiAhPT0gV09SS1NQQUNFX0hPU1RfQ1JFREVOVElBTF9ERUxJVkVSWV9QUk9UT0NPTF9WRVJTSU9OXG4gICkge1xuICAgIHRocm93IG5ldyBXb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbERlbGl2ZXJ5UHJvdG9jb2xFcnJvcihcbiAgICAgIGB1bnN1cHBvcnRlZCBwcm90b2NvbCB2ZXJzaW9uICcke1N0cmluZyhib2R5LnByb3RvY29sVmVyc2lvbil9JzsgdGhpcyBkZWxpdmVyeSBlbmRwb2ludCBgICtcbiAgICAgICAgYHNwZWFrcyAnJHtXT1JLU1BBQ0VfSE9TVF9DUkVERU5USUFMX0RFTElWRVJZX1BST1RPQ09MX1ZFUlNJT059J2AsXG4gICAgKTtcbiAgfVxuXG4gIGNvbnN0IGNoYW5uZWwgPSByZXF1aXJlU3RyaW5nKGJvZHkuY2hhbm5lbCwgXCJyZXF1ZXN0LmNoYW5uZWxcIik7XG4gIGNvbnN0IGNyZWRlbnRpYWxSZWYgPSByZXF1aXJlU3RyaW5nKFxuICAgIGJvZHkuY3JlZGVudGlhbFJlZixcbiAgICBcInJlcXVlc3QuY3JlZGVudGlhbFJlZlwiLFxuICApO1xuICAvLyBUaGUgbmFtZXNwYWNlIHBhcnNlciBpcyB0aGUgYXV0aG9yaXR5IG9uIHdoaWNoIGZhbWlseSBhIHJlZmVyZW5jZSBiZWxvbmdzIHRvLCBhbmQgaXQgYWxzb1xuICAvLyBlbmZvcmNlcyB0aGF0IHRoZSByZWZlcmVuY2UgbWF0Y2hlcyB0aGUgZGVjbGFyZWQgY2hhbm5lbC4gRGVyaXZpbmcgcmF0aGVyIHRoYW4gdHJ1c3RpbmcgaXNcbiAgLy8gd2hhdCBtYWtlcyBhIGZhbWlseS9yZWZlcmVuY2UgZGlzYWdyZWVtZW50IGltcG9zc2libGUgaW5zdGVhZCBvZiBtZXJlbHkgdW5saWtlbHkuXG4gIGNvbnN0IHBhcnNlZCA9IHBhcnNlV29ya3NwYWNlSG9zdENyZWRlbnRpYWxSZWZlcmVuY2UoXG4gICAgY3JlZGVudGlhbFJlZixcbiAgICBjaGFubmVsIGFzIFdvcmtzcGFjZUhvc3RDcmVkZW50aWFsQ2hhbm5lbCxcbiAgKTtcblxuICBjb25zdCBnZW5lcmF0aW9uID0gYm9keS5nZW5lcmF0aW9uO1xuICBpZiAoIU51bWJlci5pc1NhZmVJbnRlZ2VyKGdlbmVyYXRpb24pIHx8IChnZW5lcmF0aW9uIGFzIG51bWJlcikgPCAxKSB7XG4gICAgdGhyb3cgbmV3IFdvcmtzcGFjZUhvc3RDcmVkZW50aWFsRGVsaXZlcnlQcm90b2NvbEVycm9yKFxuICAgICAgXCJyZXF1ZXN0LmdlbmVyYXRpb24gbXVzdCBiZSBhIHBvc2l0aXZlIHNhZmUgaW50ZWdlclwiLFxuICAgICk7XG4gIH1cblxuICByZXR1cm4ge1xuICAgIHByb3RvY29sVmVyc2lvbjogV09SS1NQQUNFX0hPU1RfQ1JFREVOVElBTF9ERUxJVkVSWV9QUk9UT0NPTF9WRVJTSU9OLFxuICAgIGNoYW5uZWw6IHBhcnNlZC5jaGFubmVsLFxuICAgIGNyZWRlbnRpYWxSZWYsXG4gICAgZmFtaWx5OiBwYXJzZWQuZmFtaWx5LFxuICAgIGdlbmVyYXRpb246IGdlbmVyYXRpb24gYXMgbnVtYmVyLFxuICAgIG1hdGVyaWFsOiBkZWNvZGVNYXRlcmlhbChib2R5Lm1hdGVyaWFsKSxcbiAgfTtcbn1cblxuLyogLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tICovXG4vKiBUaGUgZmlsZXN5c3RlbSBzZWFtICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAqL1xuLyogLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tICovXG5cbi8qKlxuICogVGhlIGlycmVkdWNpYmxlIEkvTywga2VwdCBiZWhpbmQgYSBzZWFtIGZvciB0aGUgc2FtZSByZWFzb24gYFdvcmtzcGFjZUhvc3RTeXN0ZW1gIGlzOiBldmVyeXRoaW5nXG4gKiBhYm92ZSBpdCDigJQgdGhlIGV4ZW1wdGlvbiwgdGhlIG1vbm90b25pY2l0eSBydWxlLCB0aGUgaWRlbXBvdGVuY3kgY29tcGFyaXNvbiDigJQgaXMgZGVjaXNpb24gbG9naWNcbiAqIGEgdW5pdCB0ZXN0IG11c3QgYmUgYWJsZSB0byBkcml2ZSB3aXRob3V0IGEgVk0gYW5kIHdpdGhvdXQgd3JpdGluZyByZWFsIGNyZWRlbnRpYWxzIHRvIGEgcmVhbFxuICogZGlzay5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBXb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbERlbGl2ZXJ5RmlsZXN5c3RlbSB7XG4gIC8qKiBDcmVhdGUgYSBkaXJlY3RvcnkgYW5kIGV2ZXJ5IG1pc3NpbmcgcGFyZW50IHdpdGggbW9kZSBgMDcwMGAuICovXG4gIGVuc3VyZURpcmVjdG9yeShwYXRoOiBzdHJpbmcpOiBQcm9taXNlPHZvaWQ+O1xuICAvKiogV3JpdGUgYGJ5dGVzYCBhdCBgcGF0aGAgd2l0aCBtb2RlIGAwNjAwYCwgcmVwbGFjaW5nIGFueSBleGlzdGluZyBmaWxlIGF0b21pY2FsbHkuICovXG4gIHdyaXRlUHJpdmF0ZUZpbGUocGF0aDogc3RyaW5nLCBieXRlczogQnVmZmVyKTogUHJvbWlzZTx2b2lkPjtcbiAgLyoqIFJlYWQgYSBmaWxlLCBvciBgbnVsbGAgd2hlbiBpdCBkb2VzIG5vdCBleGlzdC4gKi9cbiAgcmVhZEZpbGVJZlByZXNlbnQocGF0aDogc3RyaW5nKTogUHJvbWlzZTxCdWZmZXIgfCBudWxsPjtcbiAgLyoqIFJldHVybiB0aGUgbHN0YXQga2luZCB3aXRob3V0IGZvbGxvd2luZyBzeW1saW5rcyB3aGVuIHRoZSBpbXBsZW1lbnRhdGlvbiBjYW4gcHJvdmlkZSBpdC4gKi9cbiAgcGF0aEtpbmQ/KFxuICAgIHBhdGg6IHN0cmluZyxcbiAgKTogUHJvbWlzZTxcIm1pc3NpbmdcIiB8IFwiZGlyZWN0b3J5XCIgfCBcImZpbGVcIiB8IFwic3ltbGlua1wiIHwgXCJvdGhlclwiPjtcbiAgLyoqIE9wdGlvbmFsIGNyb3NzLXByb2Nlc3MgY3JpdGljYWwgc2VjdGlvbi4gUHJvZHVjdGlvbiBwcm92aWRlcyBpdDsgaGVybWV0aWMgZG91YmxlcyBtYXkgbm90LiAqL1xuICB3aXRoRXhjbHVzaXZlTG9jaz88VD4ocGF0aDogc3RyaW5nLCB0YXNrOiAoKSA9PiBQcm9taXNlPFQ+KTogUHJvbWlzZTxUPjtcbn1cblxuY29uc3QgV09SS1NQQUNFX0hPU1RfRklMRVNZU1RFTV9MT0NLX1RJTUVPVVRfTVMgPSAzNjBfMDAwO1xuY29uc3QgV09SS1NQQUNFX0hPU1RfRklMRVNZU1RFTV9MT0NLX09SUEhBTl9NUyA9IDYwXzAwMDtcbmNvbnN0IFdPUktTUEFDRV9IT1NUX0ZJTEVTWVNURU1fTE9DS19SRVRSWV9NUyA9IDI1O1xuXG5mdW5jdGlvbiBub2RlRXJyb3JDb2RlKGVycm9yOiB1bmtub3duKTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcbiAgcmV0dXJuIGVycm9yICYmIHR5cGVvZiBlcnJvciA9PT0gXCJvYmplY3RcIiAmJiBcImNvZGVcIiBpbiBlcnJvclxuICAgID8gU3RyaW5nKChlcnJvciBhcyB7IGNvZGU/OiB1bmtub3duIH0pLmNvZGUpXG4gICAgOiB1bmRlZmluZWQ7XG59XG5cbmZ1bmN0aW9uIGRlbGF5KG1zOiBudW1iZXIpOiBQcm9taXNlPHZvaWQ+IHtcbiAgcmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlKSA9PiBzZXRUaW1lb3V0KHJlc29sdmUsIG1zKSk7XG59XG5cbi8qKlxuICogQ3JlYXRlIGEgZGlyZWN0b3J5IG9uZSBjb21wb25lbnQgYXQgYSB0aW1lIGFuZCByZWplY3Qgc3ltbGlua3MgYXQgZXZlcnkgY29tcG9uZW50LlxuICogYG1rZGlyKC4uLiwgeyByZWN1cnNpdmU6dHJ1ZSB9KWAgZm9sbG93cyBhbiBleGlzdGluZyBzeW1saW5rLCB3aGljaCBpcyB1bnNhZmUgd2hlbiBhIHJvb3Qtb3duZWRcbiAqIGNvbnN1bWVyIGlzIHdyaXRpbmcgaW50byBhIHVzZXItc2VsZWN0ZWQgaG9tZSwgY3JlZGVudGlhbCByb290IG9yIGN1c3RvbWVyLXdyaXRhYmxlIHdvcmtzcGFjZVxuICogcm9vdC4gYGtpbmRgIG5hbWVzIHRoZSBkaXJlY3RvcnkgaW4gZXJyb3JzOyBgbW9kZWAgaXMgYXBwbGllZCB0byBldmVyeSBjcmVhdGVkIGNvbXBvbmVudCBhbmRcbiAqIHRvIHRoZSBsZWFmLlxuICovXG5hc3luYyBmdW5jdGlvbiBlbnN1cmVEaXJlY3RvcnlXaXRob3V0Rm9sbG93aW5nU3ltbGlua3MoXG4gIHBhdGg6IHN0cmluZyxcbiAgbW9kZTogbnVtYmVyLFxuICBraW5kOiBzdHJpbmcsXG4pOiBQcm9taXNlPHZvaWQ+IHtcbiAgaWYgKCFpc0Fic29sdXRlKHBhdGgpIHx8IG5vcm1hbGl6ZShwYXRoKSAhPT0gcGF0aCB8fCAvW1xcMFxcclxcbl0vLnRlc3QocGF0aCkpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgJHtraW5kfSBtdXN0IGJlIGFuIGFic29sdXRlIGNhbm9uaWNhbCBwYXRoOiAnJHtwYXRofSdgLFxuICAgICk7XG4gIH1cbiAgY29uc3QgY29tcG9uZW50cyA9IHBhdGguc3BsaXQoXCIvXCIpLmZpbHRlcihCb29sZWFuKTtcbiAgbGV0IGN1cnJlbnQgPSBcIi9cIjtcbiAgZm9yIChjb25zdCBjb21wb25lbnQgb2YgY29tcG9uZW50cykge1xuICAgIGN1cnJlbnQgPSBqb2luKGN1cnJlbnQsIGNvbXBvbmVudCk7XG4gICAgbGV0IGluZm87XG4gICAgbGV0IGNyZWF0ZWQgPSBmYWxzZTtcbiAgICB0cnkge1xuICAgICAgaW5mbyA9IGF3YWl0IGxzdGF0KGN1cnJlbnQpO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICBpZiAobm9kZUVycm9yQ29kZShlcnJvcikgIT09IFwiRU5PRU5UXCIpIHRocm93IGVycm9yO1xuICAgICAgdHJ5IHtcbiAgICAgICAgYXdhaXQgbWtkaXIoY3VycmVudCwgeyBtb2RlIH0pO1xuICAgICAgICBjcmVhdGVkID0gdHJ1ZTtcbiAgICAgIH0gY2F0Y2ggKG1rZGlyRXJyb3IpIHtcbiAgICAgICAgaWYgKG5vZGVFcnJvckNvZGUobWtkaXJFcnJvcikgIT09IFwiRUVYSVNUXCIpIHRocm93IG1rZGlyRXJyb3I7XG4gICAgICB9XG4gICAgICBpbmZvID0gYXdhaXQgbHN0YXQoY3VycmVudCk7XG4gICAgfVxuICAgIGlmICghaW5mby5pc0RpcmVjdG9yeSgpIHx8IGluZm8uaXNTeW1ib2xpY0xpbmsoKSkge1xuICAgICAgLy8gYm9vdGMgb3ducyB0aGVzZSB0d28gZml4ZWQgYWxpYXNlcyBpbiBpdHMgaW1tdXRhYmxlIHJvb3QuIFJlc29sdmUgb25seVxuICAgICAgLy8gdGhlaXIgZXhhY3QgT1MgdGFyZ2V0czsgY3VzdG9tZXItY29udHJvbGxlZCBsaW5rcyByZW1haW4gZm9yYmlkZGVuLlxuICAgICAgY29uc3Qgc3lzdGVtVGFyZ2V0ID0gY3VycmVudCA9PT0gXCIvc3J2XCIgPyBcIi92YXIvc3J2XCIgOiBjdXJyZW50ID09PSBcIi9ob21lXCIgPyBcIi92YXIvaG9tZVwiIDogdW5kZWZpbmVkO1xuICAgICAgaWYgKHN5c3RlbVRhcmdldCAmJiBpbmZvLmlzU3ltYm9saWNMaW5rKCkgJiYgaW5mby51aWQgPT09IDAgJiYgaW5mby5naWQgPT09IDApIHtcbiAgICAgICAgY29uc3QgdGFyZ2V0ID0gYXdhaXQgcmVhZGxpbmsoY3VycmVudCk7XG4gICAgICAgIGlmICh0YXJnZXQgPT09IHN5c3RlbVRhcmdldCB8fCB0YXJnZXQgPT09IHN5c3RlbVRhcmdldC5zbGljZSgxKSkge1xuICAgICAgICAgIGZvciAoY29uc3QgYW5jZXN0b3Igb2YgW1wiL3ZhclwiLCBzeXN0ZW1UYXJnZXRdKSB7XG4gICAgICAgICAgICBjb25zdCB0cnVzdGVkID0gYXdhaXQgbHN0YXQoYW5jZXN0b3IpO1xuICAgICAgICAgICAgaWYgKCF0cnVzdGVkLmlzRGlyZWN0b3J5KCkgfHwgdHJ1c3RlZC5pc1N5bWJvbGljTGluaygpIHx8IHRydXN0ZWQudWlkICE9PSAwIHx8IHRydXN0ZWQuZ2lkICE9PSAwIHx8ICh0cnVzdGVkLm1vZGUgJiAwbzAyMikgIT09IDApIHtcbiAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGByZWZ1c2luZyB1bnRydXN0ZWQgc3lzdGVtIGRpcmVjdG9yeSAnJHthbmNlc3Rvcn0nYCk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfVxuICAgICAgICAgIGF3YWl0IGVuc3VyZURpcmVjdG9yeVdpdGhvdXRGb2xsb3dpbmdTeW1saW5rcyhzeXN0ZW1UYXJnZXQgKyBwYXRoLnNsaWNlKGN1cnJlbnQubGVuZ3RoKSwgbW9kZSwga2luZCk7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIGByZWZ1c2luZyBub24tZGlyZWN0b3J5IG9yIHN5bWxpbmsgYXQgJHtraW5kfSAnJHtjdXJyZW50fSdgLFxuICAgICAgKTtcbiAgICB9XG4gICAgLy8gRXhpc3RpbmcgYW5jZXN0b3JzIG1heSBiZSBzaGFyZWQgc3lzdGVtIGRpcmVjdG9yaWVzICgvdmFyLCAvdmFyL2xpYiwg4oCmKTsgb25seSB0aGUgbmV3bHlcbiAgICAvLyBjcmVhdGVkIGNvbXBvbmVudHMgYW5kIHRoZSByZXF1ZXN0ZWQgbGVhZiByZWNlaXZlIHRoZSBtb2RlLlxuICAgIGlmIChjcmVhdGVkIHx8IGN1cnJlbnQgPT09IHBhdGgpIGF3YWl0IGNobW9kKGN1cnJlbnQsIG1vZGUpO1xuICB9XG59XG5cbi8qKiBBIGNyZWRlbnRpYWwvaG9tZSBkaXJlY3Rvcnk6IG1vZGUgYDA3MDBgLCByZWFkYWJsZSBieSBpdHMgb3duZXIgYWxvbmUuICovXG5hc3luYyBmdW5jdGlvbiBlbnN1cmVQcml2YXRlRGlyZWN0b3J5KHBhdGg6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xuICBhd2FpdCBlbnN1cmVEaXJlY3RvcnlXaXRob3V0Rm9sbG93aW5nU3ltbGlua3MocGF0aCwgMG83MDAsIFwicHJpdmF0ZSBkaXJlY3RvcnlcIik7XG59XG5cbi8qKlxuICogQSB3b3Jrc3BhY2UgZGlyZWN0b3J5IHVuZGVyIHRoZSBBQ0wnZCB3b3Jrc3BhY2Ugcm9vdCAoYC9zcnYvcGFwZXJjdXNwL3dvcmtzcGFjZXNgKSwgbW9kZSBgMDc3MGAuXG4gKlxuICogTk9UIGAwNzAwYC4gVGhlIGJvb3RzdHJhcCBnaXZlcyB0aGF0IHJvb3QgYSBkZWZhdWx0IEFDTCBuYW1pbmcgdGhlIHNlcnZpY2UsIFNTSCBhbmQgYWdlbnRcbiAqIGFjY291bnRzLCBhbmQgb24gYSBmaWxlIHdpdGggYW4gQUNMIHRoZSBtb2RlJ3MgR1JPVVAgYml0cyBhcmUgdGhlIEFDTCBNQVNLLiBBIGAwNzAwYFxuICogbWtkaXIvY2htb2QgdGhlcmVmb3JlIHNldHMgYG1hc2s6Oi0tLWAsIHdoaWNoIHNpbGVudGx5IHZvaWRzIGV2ZXJ5IG5hbWVkLXVzZXIgZW50cnk6IHRoZVxuICogb3BlcmF0b3Igc2VydmljZSBhY2NvdW50IGNvdWxkIG5vdCB0cmF2ZXJzZSB0aGUgY3VzdG9tZXIncyB3b3Jrc3BhY2Ugcm9vdCwgc28gdGhlIHBvcnRhbCdzXG4gKiBcImFkZCBhIHBvdFwiIGFuc3dlcmVkIFwicGF0aCBkb2VzIG5vdCBleGlzdFwiIChXSS0xMDAwNDU5NCkuIGAwNzcwYCBrZWVwcyB0aGUgbWFzayBhdCBgcnd4YCBhbmRcbiAqIGxlYXZlcyBcIm90aGVyXCIgY2xvc2VkLiBSZS1ydW5uaW5nIG9uIGFuIGV4aXN0aW5nIGRpcmVjdG9yeSByZXBhaXJzIGl0cyBtYXNrLCBiZWNhdXNlIHRoZSBsZWFmXG4gKiBpcyBhbHdheXMgcmUtY2htb2RkZWQuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBlbnN1cmVTaGFyZWRXb3Jrc3BhY2VEaXJlY3RvcnkocGF0aDogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XG4gIGF3YWl0IGVuc3VyZURpcmVjdG9yeVdpdGhvdXRGb2xsb3dpbmdTeW1saW5rcyhwYXRoLCAwbzc3MCwgXCJ3b3Jrc3BhY2UgZGlyZWN0b3J5XCIpO1xufVxuXG5jb25zdCBmYWxsYmFja0ZpbGVzeXN0ZW1Mb2NrcyA9IG5ldyBXZWFrTWFwPFxuICBXb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbERlbGl2ZXJ5RmlsZXN5c3RlbSxcbiAgTWFwPHN0cmluZywgUHJvbWlzZTx2b2lkPj5cbj4oKTtcblxuLyoqXG4gKiBTZXJpYWxpemUgYSBob3N0IGNyZWRlbnRpYWwgbXV0YXRpb24uXG4gKlxuICogTm9kZSBwcm9kdWN0aW9uIHVzZXMgYW4gYXRvbWljIG9uLWRpc2sgbXV0ZXggYmVsb3csIHNvIGluZGVwZW5kZW50IGluaXRpYWxpemVyL2RlbGl2ZXJ5XG4gKiBwcm9jZXNzZXMgYWdyZWUuIEEgV2Vha01hcCBxdWV1ZSBpcyB0aGUgZGV0ZXJtaW5pc3RpYyBmYWxsYmFjayBmb3IgaGVybWV0aWMgZmlsZXN5c3RlbSBkb3VibGVzO1xuICogZnJlc2ggZGVwZW5kZW5jeSBncmFwaHMgc2hhcmluZyB0aGUgc2FtZSBkb3VibGUgc3RpbGwgZXhlcmNpc2UgdGhlIG9yZGVyaW5nIGNvbnRyYWN0LlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gd2l0aFdvcmtzcGFjZUhvc3RDcmVkZW50aWFsRmlsZXN5c3RlbUxvY2s8VD4oXG4gIGZpbGVzeXN0ZW06IFdvcmtzcGFjZUhvc3RDcmVkZW50aWFsRGVsaXZlcnlGaWxlc3lzdGVtLFxuICBwYXRoOiBzdHJpbmcsXG4gIHRhc2s6ICgpID0+IFByb21pc2U8VD4sXG4pOiBQcm9taXNlPFQ+IHtcbiAgaWYgKGZpbGVzeXN0ZW0ud2l0aEV4Y2x1c2l2ZUxvY2spIHtcbiAgICByZXR1cm4gYXdhaXQgZmlsZXN5c3RlbS53aXRoRXhjbHVzaXZlTG9jayhwYXRoLCB0YXNrKTtcbiAgfVxuICBsZXQgbG9ja3MgPSBmYWxsYmFja0ZpbGVzeXN0ZW1Mb2Nrcy5nZXQoZmlsZXN5c3RlbSk7XG4gIGlmICghbG9ja3MpIHtcbiAgICBsb2NrcyA9IG5ldyBNYXAoKTtcbiAgICBmYWxsYmFja0ZpbGVzeXN0ZW1Mb2Nrcy5zZXQoZmlsZXN5c3RlbSwgbG9ja3MpO1xuICB9XG4gIGNvbnN0IHByZXZpb3VzID0gbG9ja3MuZ2V0KHBhdGgpID8/IFByb21pc2UucmVzb2x2ZSgpO1xuICBsZXQgcmVsZWFzZSE6ICgpID0+IHZvaWQ7XG4gIGNvbnN0IG93biA9IG5ldyBQcm9taXNlPHZvaWQ+KChyZXNvbHZlKSA9PiB7XG4gICAgcmVsZWFzZSA9IHJlc29sdmU7XG4gIH0pO1xuICBjb25zdCB0YWlsID0gcHJldmlvdXMudGhlbigoKSA9PiBvd24pO1xuICBsb2Nrcy5zZXQocGF0aCwgdGFpbCk7XG4gIGF3YWl0IHByZXZpb3VzO1xuICB0cnkge1xuICAgIHJldHVybiBhd2FpdCB0YXNrKCk7XG4gIH0gZmluYWxseSB7XG4gICAgcmVsZWFzZSgpO1xuICAgIGlmIChsb2Nrcy5nZXQocGF0aCkgPT09IHRhaWwpIGxvY2tzLmRlbGV0ZShwYXRoKTtcbiAgfVxufVxuXG5leHBvcnQgZnVuY3Rpb24gd29ya3NwYWNlSG9zdENyZWRlbnRpYWxGYW1pbHlMb2NrUGF0aChcbiAgcm9vdDogc3RyaW5nLFxuICBmYW1pbHk6IFdvcmtzcGFjZUhvc3RDcmVkZW50aWFsRmFtaWx5LFxuKTogc3RyaW5nIHtcbiAgLy8gQm90aCBhZ2VudCBmYW1pbGllcyBpbnN0YWxsIHRoZSBzYW1lIHRocmVlIG5hdGl2ZSBmaWxlcyBhbmQgYWN0aXZlIG1hcmtlci4gQSBzaGFyZWQgbG9jayBrZWVwc1xuICAvLyBhIGZvcndhcmRlZC9zZWFsZWQgcm90YXRpb24gZnJvbSBpbnRlcmxlYXZpbmcgZXZlbiB0aG91Z2ggdGhlaXIgZGVsaXZlcmVkIGFydGlmYWN0cyBhcmUgc3RvcmVkXG4gIC8vIHVuZGVyIGRpZmZlcmVudCBmYW1pbHkgZGlyZWN0b3JpZXMuXG4gIGlmIChcbiAgICBmYW1pbHkgPT09IFwiYWdlbnQtZm9yd2FyZGVkLXJlZmVyZW5jZVwiIHx8XG4gICAgZmFtaWx5ID09PSBcImFnZW50LWVuY3J5cHRlZC1yZWZlcmVuY2VcIlxuICApIHtcbiAgICByZXR1cm4gam9pbihyb290LCBcImFjdGl2ZVwiLCBcIi5hZ2VudC1ob21lLmxpZmVjeWNsZS5sb2NrXCIpO1xuICB9XG4gIHJldHVybiBqb2luKHJvb3QsIGZhbWlseSwgXCIubGlmZWN5Y2xlLmxvY2tcIik7XG59XG5cbi8qKlxuICogVGhlIHJlYWwgaW1wbGVtZW50YXRpb24sIHVzZWQgYnkgdGhlIHBhY2thZ2VkIGhvc3QgZW50cnlwb2ludC5cbiAqXG4gKiBgV29ya3NwYWNlSG9zdFN5c3RlbWAgaW4gdGhlIHJlbW90ZS1pbml0aWFsaXplciBob3N0IEVYVEVORFMgdGhlIGludGVyZmFjZSBhYm92ZSByYXRoZXIgdGhhblxuICogZGVjbGFyaW5nIGEgcGFyYWxsZWwgb25lLCBzbyBhIGNhbGxlciB0aGF0IHN0dWJzIHRoZSBob3N0IHNlYW0gc3R1YnMgdGhpcyB0b28uIFRoYXQgaXMgbm90XG4gKiB0aWRpbmVzczogYHJldm9rZSgpYCB3cml0ZXMgdGhlIHJldm9jYXRpb24gbGVkZ2VyIHRocm91Z2ggdGhpcyBzZWFtLCBhbmQgd2hlbiBpdCB3YXMgYSBTRUNPTkRcbiAqIHNlYW0gZGVmYXVsdGluZyB0byB0aGUgcmVhbCBmaWxlc3lzdGVtLCBhIHRlc3QgdGhhdCBoYWQgY2FyZWZ1bGx5IGZha2VkIGV2ZXJ5IGhvc3Qgb3BlcmF0aW9uXG4gKiBzdGlsbCB0cmllZCB0byBgbWtkaXIgL2NyZWRlbnRpYWxzYCBvbiB0aGUgbWFjaGluZSBydW5uaW5nIGl0LlxuICovXG5leHBvcnQgY2xhc3MgTm9kZVdvcmtzcGFjZUhvc3RDcmVkZW50aWFsRGVsaXZlcnlGaWxlc3lzdGVtIGltcGxlbWVudHMgV29ya3NwYWNlSG9zdENyZWRlbnRpYWxEZWxpdmVyeUZpbGVzeXN0ZW0ge1xuICBhc3luYyBlbnN1cmVEaXJlY3RvcnkocGF0aDogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgYXdhaXQgZW5zdXJlUHJpdmF0ZURpcmVjdG9yeShwYXRoKTtcbiAgfVxuXG4gIGFzeW5jIHdyaXRlUHJpdmF0ZUZpbGUocGF0aDogc3RyaW5nLCBieXRlczogQnVmZmVyKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgLy8gV3JpdHRlbiB0byBhIHNpYmxpbmcgdGVtcCBwYXRoIGFuZCByZW5hbWVkIHNvIGEgcmVhZGVyIG5ldmVyIG9ic2VydmVzIGEgcGFydGlhbCBjcmVkZW50aWFsOlxuICAgIC8vIGBiaW5kKClgIGNoZWNrcyBwcmVzZW5jZSwgYW5kIGEgaGFsZi13cml0dGVuIGZpbGUgaXMgcHJlc2VudC4gVGhlIHRlbXAgZmlsZSBpcyBjcmVhdGVkIDA2MDBcbiAgICAvLyBmcm9tIHRoZSBzdGFydCwgc28gdGhlIG1hdGVyaWFsIGlzIG5ldmVyIGJyaWVmbHkgd29ybGQtcmVhZGFibGUuXG4gICAgYXdhaXQgZW5zdXJlUHJpdmF0ZURpcmVjdG9yeShkaXJuYW1lKHBhdGgpKTtcbiAgICBjb25zdCB0ZW1wb3JhcnkgPSBqb2luKFxuICAgICAgZGlybmFtZShwYXRoKSxcbiAgICAgIGAuJHtiYXNlbmFtZShwYXRoKX0uJHtwcm9jZXNzLnBpZH0uJHtyYW5kb21VVUlEKCl9LnRtcGAsXG4gICAgKTtcbiAgICB0cnkge1xuICAgICAgYXdhaXQgd3JpdGVGaWxlKHRlbXBvcmFyeSwgYnl0ZXMsIHsgbW9kZTogMG82MDAsIGZsYWc6IFwid3hcIiB9KTtcbiAgICAgIGF3YWl0IGNobW9kKHRlbXBvcmFyeSwgMG82MDApO1xuICAgICAgYXdhaXQgcmVuYW1lKHRlbXBvcmFyeSwgcGF0aCk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGF3YWl0IHJtKHRlbXBvcmFyeSwgeyBmb3JjZTogdHJ1ZSB9KS5jYXRjaCgoKSA9PiB1bmRlZmluZWQpO1xuICAgIH1cbiAgfVxuXG4gIGFzeW5jIHJlYWRGaWxlSWZQcmVzZW50KHBhdGg6IHN0cmluZyk6IFByb21pc2U8QnVmZmVyIHwgbnVsbD4ge1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBpbmZvID0gYXdhaXQgbHN0YXQocGF0aCk7XG4gICAgICBpZiAoIWluZm8uaXNGaWxlKCkgfHwgaW5mby5pc1N5bWJvbGljTGluaygpKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgcmVmdXNpbmcgdG8gcmVhZCBub24tcmVndWxhciBwcml2YXRlIGZpbGUgJyR7cGF0aH0nYCk7XG4gICAgICB9XG4gICAgICByZXR1cm4gYXdhaXQgcmVhZEZpbGUocGF0aCk7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIGlmIChub2RlRXJyb3JDb2RlKGVycm9yKSA9PT0gXCJFTk9FTlRcIikgcmV0dXJuIG51bGw7XG4gICAgICB0aHJvdyBlcnJvcjtcbiAgICB9XG4gIH1cblxuICBhc3luYyBwYXRoS2luZChcbiAgICBwYXRoOiBzdHJpbmcsXG4gICk6IFByb21pc2U8XCJtaXNzaW5nXCIgfCBcImRpcmVjdG9yeVwiIHwgXCJmaWxlXCIgfCBcInN5bWxpbmtcIiB8IFwib3RoZXJcIj4ge1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBpbmZvID0gYXdhaXQgbHN0YXQocGF0aCk7XG4gICAgICBpZiAoaW5mby5pc1N5bWJvbGljTGluaygpKSByZXR1cm4gXCJzeW1saW5rXCI7XG4gICAgICBpZiAoaW5mby5pc0RpcmVjdG9yeSgpKSByZXR1cm4gXCJkaXJlY3RvcnlcIjtcbiAgICAgIGlmIChpbmZvLmlzRmlsZSgpKSByZXR1cm4gXCJmaWxlXCI7XG4gICAgICByZXR1cm4gXCJvdGhlclwiO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICBpZiAobm9kZUVycm9yQ29kZShlcnJvcikgPT09IFwiRU5PRU5UXCIpIHJldHVybiBcIm1pc3NpbmdcIjtcbiAgICAgIHRocm93IGVycm9yO1xuICAgIH1cbiAgfVxuXG4gIGFzeW5jIHdpdGhFeGNsdXNpdmVMb2NrPFQ+KHBhdGg6IHN0cmluZywgdGFzazogKCkgPT4gUHJvbWlzZTxUPik6IFByb21pc2U8VD4ge1xuICAgIGF3YWl0IHRoaXMuZW5zdXJlRGlyZWN0b3J5KGRpcm5hbWUocGF0aCkpO1xuICAgIGNvbnN0IHRva2VuID0gcmFuZG9tVVVJRCgpO1xuICAgIGNvbnN0IG93bmVyUGF0aCA9IGpvaW4ocGF0aCwgXCJvd25lci5qc29uXCIpO1xuICAgIGNvbnN0IHN0YXJ0ZWRBdCA9IERhdGUubm93KCk7XG4gICAgbGV0IGFjcXVpcmVkID0gZmFsc2U7XG4gICAgd2hpbGUgKCFhY3F1aXJlZCkge1xuICAgICAgdHJ5IHtcbiAgICAgICAgYXdhaXQgbWtkaXIocGF0aCwgeyBtb2RlOiAwbzcwMCB9KTtcbiAgICAgICAgYXdhaXQgd3JpdGVGaWxlKFxuICAgICAgICAgIG93bmVyUGF0aCxcbiAgICAgICAgICBKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgICAgICB0b2tlbixcbiAgICAgICAgICAgIHBpZDogcHJvY2Vzcy5waWQsXG4gICAgICAgICAgICBob3N0OiBob3N0bmFtZSgpLFxuICAgICAgICAgICAgc3RhcnRlZEF0LFxuICAgICAgICAgIH0pLFxuICAgICAgICAgIHsgbW9kZTogMG82MDAsIGZsYWc6IFwid3hcIiB9LFxuICAgICAgICApO1xuICAgICAgICBhY3F1aXJlZCA9IHRydWU7XG4gICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICBpZiAobm9kZUVycm9yQ29kZShlcnJvcikgIT09IFwiRUVYSVNUXCIpIHRocm93IGVycm9yO1xuICAgICAgICBsZXQgcmVjbGFpbSA9IGZhbHNlO1xuICAgICAgICB0cnkge1xuICAgICAgICAgIGNvbnN0IGluZm8gPSBhd2FpdCBsc3RhdChwYXRoKTtcbiAgICAgICAgICBpZiAoIWluZm8uaXNEaXJlY3RvcnkoKSB8fCBpbmZvLmlzU3ltYm9saWNMaW5rKCkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgcmVmdXNpbmcgdW5zYWZlIGNyZWRlbnRpYWwgbG9jayBwYXRoICcke3BhdGh9J2ApO1xuICAgICAgICAgIH1cbiAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgY29uc3Qgb3duZXIgPSBKU09OLnBhcnNlKGF3YWl0IHJlYWRGaWxlKG93bmVyUGF0aCwgXCJ1dGY4XCIpKSBhcyB7XG4gICAgICAgICAgICAgIHBpZD86IHVua25vd247XG4gICAgICAgICAgICAgIGhvc3Q/OiB1bmtub3duO1xuICAgICAgICAgICAgfTtcbiAgICAgICAgICAgIGlmIChcbiAgICAgICAgICAgICAgb3duZXIuaG9zdCA9PT0gaG9zdG5hbWUoKSAmJlxuICAgICAgICAgICAgICBOdW1iZXIuaXNTYWZlSW50ZWdlcihvd25lci5waWQpICYmXG4gICAgICAgICAgICAgIChvd25lci5waWQgYXMgbnVtYmVyKSA+IDBcbiAgICAgICAgICAgICkge1xuICAgICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgIHByb2Nlc3Mua2lsbChvd25lci5waWQgYXMgbnVtYmVyLCAwKTtcbiAgICAgICAgICAgICAgfSBjYXRjaCAocHJvYmVFcnJvcikge1xuICAgICAgICAgICAgICAgIHJlY2xhaW0gPSBub2RlRXJyb3JDb2RlKHByb2JlRXJyb3IpID09PSBcIkVTUkNIXCI7XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9IGNhdGNoIChvd25lckVycm9yKSB7XG4gICAgICAgICAgICBpZiAobm9kZUVycm9yQ29kZShvd25lckVycm9yKSAhPT0gXCJFTk9FTlRcIikge1xuICAgICAgICAgICAgICAvLyBBIG1hbGZvcm1lZCBvd25lciByZWNvcmQgaXMgbmV2ZXIgcHJvb2YgdGhlIGhvbGRlciBpcyBkZWFkOyBhZ2UgaXMgdGhlIGZhbGxiYWNrLlxuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmVjbGFpbSA9XG4gICAgICAgICAgICAgIERhdGUubm93KCkgLSBpbmZvLm10aW1lTXMgPlxuICAgICAgICAgICAgICBXT1JLU1BBQ0VfSE9TVF9GSUxFU1lTVEVNX0xPQ0tfT1JQSEFOX01TO1xuICAgICAgICAgIH1cbiAgICAgICAgfSBjYXRjaCAoaW5zcGVjdEVycm9yKSB7XG4gICAgICAgICAgaWYgKG5vZGVFcnJvckNvZGUoaW5zcGVjdEVycm9yKSA9PT0gXCJFTk9FTlRcIikgY29udGludWU7XG4gICAgICAgICAgdGhyb3cgaW5zcGVjdEVycm9yO1xuICAgICAgICB9XG4gICAgICAgIGlmIChyZWNsYWltKSB7XG4gICAgICAgICAgYXdhaXQgcm0ocGF0aCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG4gICAgICAgIGlmIChcbiAgICAgICAgICBEYXRlLm5vdygpIC0gc3RhcnRlZEF0ID5cbiAgICAgICAgICBXT1JLU1BBQ0VfSE9TVF9GSUxFU1lTVEVNX0xPQ0tfVElNRU9VVF9NU1xuICAgICAgICApIHtcbiAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgICBgdGltZWQgb3V0IHdhaXRpbmcgZm9yIGNyZWRlbnRpYWwgZmlsZXN5c3RlbSBsb2NrICcke3BhdGh9J2AsXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgICBhd2FpdCBkZWxheShXT1JLU1BBQ0VfSE9TVF9GSUxFU1lTVEVNX0xPQ0tfUkVUUllfTVMpO1xuICAgICAgfVxuICAgIH1cbiAgICB0cnkge1xuICAgICAgcmV0dXJuIGF3YWl0IHRhc2soKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc3Qgb3duZXIgPSBKU09OLnBhcnNlKGF3YWl0IHJlYWRGaWxlKG93bmVyUGF0aCwgXCJ1dGY4XCIpKSBhcyB7XG4gICAgICAgICAgdG9rZW4/OiB1bmtub3duO1xuICAgICAgICB9O1xuICAgICAgICBpZiAob3duZXIudG9rZW4gPT09IHRva2VuKVxuICAgICAgICAgIGF3YWl0IHJtKHBhdGgsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICAvLyBOZXZlciByZW1vdmUgYSBsb2NrIHdob3NlIHRva2VuIGNhbm5vdCBiZSBwcm92ZW4gdG8gYmUgb3Vycy5cbiAgICAgIH1cbiAgICB9XG4gIH1cbn1cblxuZXhwb3J0IGludGVyZmFjZSBXb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbERlbGl2ZXJ5RGVwcyB7XG4gIHJlYWRvbmx5IGZpbGVzeXN0ZW06IFdvcmtzcGFjZUhvc3RDcmVkZW50aWFsRGVsaXZlcnlGaWxlc3lzdGVtO1xuICByZWFkb25seSBtYXRlcmlhbFJvb3Q6IHN0cmluZztcbiAgcmVhZG9ubHkgbm93PzogKCkgPT4gRGF0ZTtcbn1cblxuLyogLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tICovXG4vKiBSZXZvY2F0aW9uIGxlZGdlciAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAqL1xuLyogLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tICovXG5cbi8qKlxuICogUmVhZCB0aGUgaGlnaGVzdCByZXZva2VkIGdlbmVyYXRpb24gZm9yIGEgZmFtaWx5OyBgMGAgd2hlbiBub3RoaW5nIGhhcyBiZWVuIHJldm9rZWQuXG4gKlxuICogQW4gdW5yZWFkYWJsZSBvciBtYWxmb3JtZWQgbGVkZ2VyIGlzIHRyZWF0ZWQgYXMgYSBSRUZVU0FMIHRvIGFuc3dlciwgbm90IGFzIHplcm8uIFplcm8gbWVhbnNcbiAqIFwibm90aGluZyByZXZva2VkXCIsIHdoaWNoIHdvdWxkIHJlLW9wZW4gZXZlcnkgZ2VuZXJhdGlvbiB0aGUgbGVkZ2VyIHdhcyB3cml0dGVuIHRvIGNsb3NlIOKAlCB0aGVcbiAqIGZhaWx1cmUgbW9kZSB3aGVyZSBjb3JydXB0aW5nIG9uZSBzbWFsbCBmaWxlIHNpbGVudGx5IGRpc2FibGVzIHRoZSBwcm90ZWN0aW9uLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcmVhZFdvcmtzcGFjZUhvc3RDcmVkZW50aWFsUmV2b2tlZFRocm91Z2goXG4gIGZpbGVzeXN0ZW06IFdvcmtzcGFjZUhvc3RDcmVkZW50aWFsRGVsaXZlcnlGaWxlc3lzdGVtLFxuICByb290OiBzdHJpbmcsXG4gIGZhbWlseTogV29ya3NwYWNlSG9zdENyZWRlbnRpYWxGYW1pbHksXG4pOiBQcm9taXNlPG51bWJlcj4ge1xuICBjb25zdCByYXcgPSBhd2FpdCBmaWxlc3lzdGVtLnJlYWRGaWxlSWZQcmVzZW50KFxuICAgIHdvcmtzcGFjZUhvc3RDcmVkZW50aWFsUmV2b2NhdGlvbkxlZGdlclBhdGgocm9vdCwgZmFtaWx5KSxcbiAgKTtcbiAgaWYgKHJhdyA9PT0gbnVsbCkgcmV0dXJuIDA7XG4gIGNvbnN0IHRleHQgPSByYXcudG9TdHJpbmcoXCJ1dGY4XCIpLnRyaW0oKTtcbiAgY29uc3QgdmFsdWUgPSBOdW1iZXIodGV4dCk7XG4gIGlmICghTnVtYmVyLmlzU2FmZUludGVnZXIodmFsdWUpIHx8IHZhbHVlIDwgMCkge1xuICAgIHRocm93IG5ldyBXb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbERlbGl2ZXJ5UHJvdG9jb2xFcnJvcihcbiAgICAgIGByZXZvY2F0aW9uIGxlZGdlciBmb3IgZmFtaWx5ICcke2ZhbWlseX0nIGlzIG1hbGZvcm1lZCAoJyR7dGV4dC5zbGljZSgwLCAzMil9Jyk7IHJlZnVzaW5nIGAgK1xuICAgICAgICBgdG8gZGVsaXZlciByYXRoZXIgdGhhbiBhc3N1bWUgbm90aGluZyB3YXMgcmV2b2tlZGAsXG4gICAgKTtcbiAgfVxuICByZXR1cm4gdmFsdWU7XG59XG5cbi8qKlxuICogUmFpc2UgdGhlIGZhbWlseSdzIHJldm9jYXRpb24gaGlnaC13YXRlciBtYXJrIHRvIGF0IGxlYXN0IGBnZW5lcmF0aW9uYC5cbiAqXG4gKiBNb25vdG9uaWMgYnkgY29uc3RydWN0aW9uOiByZXZva2luZyBhbiBPTEQgZ2VuZXJhdGlvbiBhZnRlciBhIG5ld2VyIG9uZSBoYXMgYWxyZWFkeSBiZWVuXG4gKiByZXZva2VkIG11c3Qgbm90IGxvd2VyIHRoZSBtYXJrIGFuZCByZS1vcGVuIHRoZSBuZXdlciBvbmUuIENhbGxlZCBieSB0aGUgbWF0ZXJpYWxpemVyJ3NcbiAqIGByZXZva2UoKWAsIHdoaWNoIGlzIHRoZSBvbmx5IHRoaW5nIHRoYXQgZGVzdHJveXMgbWF0ZXJpYWwuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiByZWNvcmRXb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbFJldm9jYXRpb24oXG4gIGZpbGVzeXN0ZW06IFdvcmtzcGFjZUhvc3RDcmVkZW50aWFsRGVsaXZlcnlGaWxlc3lzdGVtLFxuICByb290OiBzdHJpbmcsXG4gIGZhbWlseTogV29ya3NwYWNlSG9zdENyZWRlbnRpYWxGYW1pbHksXG4gIGdlbmVyYXRpb246IG51bWJlcixcbiAgb3B0aW9uczogeyByZWFkb25seSBsb2NrSGVsZD86IGJvb2xlYW4gfSA9IHt9LFxuKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IGFwcGx5ID0gYXN5bmMgKCk6IFByb21pc2U8dm9pZD4gPT4ge1xuICAgIGNvbnN0IGN1cnJlbnQgPSBhd2FpdCByZWFkV29ya3NwYWNlSG9zdENyZWRlbnRpYWxSZXZva2VkVGhyb3VnaChcbiAgICAgIGZpbGVzeXN0ZW0sXG4gICAgICByb290LFxuICAgICAgZmFtaWx5LFxuICAgICk7XG4gICAgaWYgKGdlbmVyYXRpb24gPD0gY3VycmVudCkgcmV0dXJuO1xuICAgIGF3YWl0IGZpbGVzeXN0ZW0uZW5zdXJlRGlyZWN0b3J5KGpvaW4ocm9vdCwgZmFtaWx5KSk7XG4gICAgYXdhaXQgZmlsZXN5c3RlbS53cml0ZVByaXZhdGVGaWxlKFxuICAgICAgd29ya3NwYWNlSG9zdENyZWRlbnRpYWxSZXZvY2F0aW9uTGVkZ2VyUGF0aChyb290LCBmYW1pbHkpLFxuICAgICAgQnVmZmVyLmZyb20oYCR7Z2VuZXJhdGlvbn1cXG5gLCBcInV0ZjhcIiksXG4gICAgKTtcbiAgfTtcbiAgaWYgKG9wdGlvbnMubG9ja0hlbGQpIHJldHVybiBhd2FpdCBhcHBseSgpO1xuICBhd2FpdCB3aXRoV29ya3NwYWNlSG9zdENyZWRlbnRpYWxGaWxlc3lzdGVtTG9jayhcbiAgICBmaWxlc3lzdGVtLFxuICAgIHdvcmtzcGFjZUhvc3RDcmVkZW50aWFsRmFtaWx5TG9ja1BhdGgocm9vdCwgZmFtaWx5KSxcbiAgICBhcHBseSxcbiAgKTtcbn1cblxuLyogLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tICovXG4vKiBUaGUgb3BlcmF0aW9uICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAqL1xuLyogLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tICovXG5cbi8qKiBDb25zdGFudC10aW1lIGVxdWFsaXR5IHRoYXQgdG9sZXJhdGVzIGRpZmZlcmVudCBsZW5ndGhzIHdpdGhvdXQgbGVha2luZyB2aWEgYW4gZWFybHkgcmV0dXJuLiAqL1xuZnVuY3Rpb24gc2FtZU1hdGVyaWFsKGE6IEJ1ZmZlciwgYjogQnVmZmVyKTogYm9vbGVhbiB7XG4gIC8vIGB0aW1pbmdTYWZlRXF1YWxgIHRocm93cyBvbiBhIGxlbmd0aCBtaXNtYXRjaCwgc28gbGVuZ3RocyBhcmUgY29tcGFyZWQgdGhyb3VnaCBmaXhlZC1zaXplXG4gIC8vIGRpZ2VzdHMgaW5zdGVhZC4gSGFzaGluZyBoZXJlIGlzIHNhZmUgaW4gYSB3YXkgdGhhdCBoYXNoaW5nIGludG8gdGhlIFJFQ0VJUFQgd291bGQgbm90IGJlOlxuICAvLyB0aGUgZGlnZXN0IG5ldmVyIGxlYXZlcyB0aGlzIHByb2Nlc3MuXG4gIGNvbnN0IGxlZnQgPSBjcmVhdGVIYXNoKFwic2hhMjU2XCIpLnVwZGF0ZShhKS5kaWdlc3QoKTtcbiAgY29uc3QgcmlnaHQgPSBjcmVhdGVIYXNoKFwic2hhMjU2XCIpLnVwZGF0ZShiKS5kaWdlc3QoKTtcbiAgcmV0dXJuIHRpbWluZ1NhZmVFcXVhbChsZWZ0LCByaWdodCk7XG59XG5cbi8qKlxuICogRXhlY3V0ZSBvbmUgZGVsaXZlcnkuXG4gKlxuICogVGhlIG9yZGVyIG9mIGNoZWNrcyBpcyB0aGUgY29udHJhY3QncyBvcmRlciBvZiBzZXZlcml0eSwgYW5kIGl0IG1hdHRlcnMuIFRoZSBhbWJpZW50IGV4ZW1wdGlvblxuICogaXMgZmlyc3QgYmVjYXVzZSB0aGF0IHJlcXVlc3QgbXVzdCBuZXZlciB0b3VjaCB0aGUgZmlsZXN5c3RlbSBhdCBhbGwuIFRoZSByZXZvY2F0aW9uIGxlZGdlciBpc1xuICogc2Vjb25kIGJlY2F1c2UgYSByZXZva2VkIGdlbmVyYXRpb24gbXVzdCBiZSByZWZ1c2VkIHdoZXRoZXIgb3Igbm90IG1hdGVyaWFsIGhhcHBlbnMgdG8gYmUgb25cbiAqIGRpc2suIE9ubHkgdGhlbiBkb2VzIHByZXNlbmNlIGRlY2lkZSBiZXR3ZWVuIGEgbm8tb3AgYW5kIGEgd3JpdGUuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBleGVjdXRlV29ya3NwYWNlSG9zdENyZWRlbnRpYWxEZWxpdmVyeShcbiAgcmVxdWVzdDogV29ya3NwYWNlSG9zdENyZWRlbnRpYWxEZWxpdmVyeVJlcXVlc3QsXG4gIGRlcHM6IFdvcmtzcGFjZUhvc3RDcmVkZW50aWFsRGVsaXZlcnlEZXBzLFxuKTogUHJvbWlzZTxXb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbERlbGl2ZXJ5UmVjZWlwdD4ge1xuICBjb25zdCB7IGZhbWlseSwgZ2VuZXJhdGlvbiB9ID0gcmVxdWVzdDtcbiAgY29uc3Qgbm93ID0gZGVwcy5ub3cgPz8gKCgpID0+IG5ldyBEYXRlKCkpO1xuXG4gIC8vIEQtMjE1IHBvaW50IDQg4oCUIGRlcml2ZWQgZnJvbSB0aGUgZmFtaWx5IHNwZWMsIG5ldmVyIGZyb20gYSBoYXJkLWNvZGVkIGZhbWlseSBuYW1lLCBzbyBhIGZpZnRoXG4gIC8vIGZhbWlseSBoYXMgdG8gZGVjbGFyZSB3aGljaCBzaWRlIGl0IGlzIG9uIGluc3RlYWQgb2YgaW5oZXJpdGluZyBhIGJyYW5jaC5cbiAgaWYgKFxuICAgICFXT1JLU1BBQ0VfSE9TVF9DUkVERU5USUFMX0ZBTUlMWV9TUEVDU1tmYW1pbHldLnJlcXVpcmVzRGVsaXZlcmVkTWF0ZXJpYWxcbiAgKSB7XG4gICAgdGhyb3cgbmV3IFdvcmtzcGFjZUhvc3RBbWJpZW50Q3JlZGVudGlhbERlbGl2ZXJ5RXJyb3IoZmFtaWx5KTtcbiAgfVxuXG4gIHJldHVybiBhd2FpdCB3aXRoV29ya3NwYWNlSG9zdENyZWRlbnRpYWxGaWxlc3lzdGVtTG9jayhcbiAgICBkZXBzLmZpbGVzeXN0ZW0sXG4gICAgd29ya3NwYWNlSG9zdENyZWRlbnRpYWxGYW1pbHlMb2NrUGF0aChkZXBzLm1hdGVyaWFsUm9vdCwgZmFtaWx5KSxcbiAgICBhc3luYyAoKSA9PiB7XG4gICAgICAvLyBELTIxNSBwb2ludCA1IOKAlCBuZXZlciByZXN1cnJlY3QgYSBnZW5lcmF0aW9uIHJldm9rZSgpIGRlc3Ryb3llZC5cbiAgICAgIGNvbnN0IHJldm9rZWRUaHJvdWdoID0gYXdhaXQgcmVhZFdvcmtzcGFjZUhvc3RDcmVkZW50aWFsUmV2b2tlZFRocm91Z2goXG4gICAgICAgIGRlcHMuZmlsZXN5c3RlbSxcbiAgICAgICAgZGVwcy5tYXRlcmlhbFJvb3QsXG4gICAgICAgIGZhbWlseSxcbiAgICAgICk7XG4gICAgICBpZiAoZ2VuZXJhdGlvbiA8PSByZXZva2VkVGhyb3VnaCkge1xuICAgICAgICB0aHJvdyBuZXcgV29ya3NwYWNlSG9zdFJldm9rZWRDcmVkZW50aWFsR2VuZXJhdGlvbkVycm9yKFxuICAgICAgICAgIGZhbWlseSxcbiAgICAgICAgICBnZW5lcmF0aW9uLFxuICAgICAgICAgIHJldm9rZWRUaHJvdWdoLFxuICAgICAgICApO1xuICAgICAgfVxuXG4gICAgICBjb25zdCBwYXRoID0gd29ya3NwYWNlSG9zdENyZWRlbnRpYWxNYXRlcmlhbFBhdGgoXG4gICAgICAgIGRlcHMubWF0ZXJpYWxSb290LFxuICAgICAgICBmYW1pbHksXG4gICAgICAgIGdlbmVyYXRpb24sXG4gICAgICApO1xuICAgICAgY29uc3QgZXhpc3RpbmcgPSBhd2FpdCBkZXBzLmZpbGVzeXN0ZW0ucmVhZEZpbGVJZlByZXNlbnQocGF0aCk7XG4gICAgICBjb25zdCBieXRlcyA9IHJlcXVlc3QubWF0ZXJpYWwucmV2ZWFsKCk7XG5cbiAgICAgIGlmIChleGlzdGluZyAhPT0gbnVsbCkge1xuICAgICAgICAvLyBJZGVtcG90ZW50IHBlciAoZmFtaWx5LCBnZW5lcmF0aW9uKTogdGhlIHNhbWUgbWF0ZXJpYWwgaXMgYSBuby1vcCwgZGlmZmVyZW50IG1hdGVyaWFsIGlzXG4gICAgICAgIC8vIGEgY29uZmxpY3QgcmF0aGVyIHRoYW4gYSBzaWxlbnQgb3ZlcndyaXRlLlxuICAgICAgICBpZiAoIXNhbWVNYXRlcmlhbChleGlzdGluZywgYnl0ZXMpKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IFdvcmtzcGFjZUhvc3RDcmVkZW50aWFsR2VuZXJhdGlvbkNvbmZsaWN0RXJyb3IoXG4gICAgICAgICAgICBmYW1pbHksXG4gICAgICAgICAgICBnZW5lcmF0aW9uLFxuICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGF3YWl0IGRlcHMuZmlsZXN5c3RlbS5lbnN1cmVEaXJlY3RvcnkoXG4gICAgICAgICAgd29ya3NwYWNlSG9zdENyZWRlbnRpYWxHZW5lcmF0aW9uRGlyZWN0b3J5KFxuICAgICAgICAgICAgZGVwcy5tYXRlcmlhbFJvb3QsXG4gICAgICAgICAgICBmYW1pbHksXG4gICAgICAgICAgICBnZW5lcmF0aW9uLFxuICAgICAgICAgICksXG4gICAgICAgICk7XG4gICAgICAgIGF3YWl0IGRlcHMuZmlsZXN5c3RlbS53cml0ZVByaXZhdGVGaWxlKHBhdGgsIGJ5dGVzKTtcbiAgICAgIH1cblxuICAgICAgY29uc3QgcmVjZWlwdDogV29ya3NwYWNlSG9zdENyZWRlbnRpYWxEZWxpdmVyeVJlY2VpcHQgPSB7XG4gICAgICAgIHByb3RvY29sVmVyc2lvbjogV09SS1NQQUNFX0hPU1RfQ1JFREVOVElBTF9ERUxJVkVSWV9QUk9UT0NPTF9WRVJTSU9OLFxuICAgICAgICBmYW1pbHksXG4gICAgICAgIGdlbmVyYXRpb24sXG4gICAgICAgIHByZXNlbnQ6IHRydWUsXG4gICAgICAgIG9ic2VydmVkQXQ6IG5vdygpLnRvSVNPU3RyaW5nKCksXG4gICAgICB9O1xuICAgICAgYXNzZXJ0V29ya3NwYWNlSG9zdFNlY3JldElzb2xhdGlvbihcbiAgICAgICAgcmVjZWlwdCxcbiAgICAgICAgXCJ3b3Jrc3BhY2VIb3N0LmNyZWRlbnRpYWxEZWxpdmVyeS5yZWNlaXB0XCIsXG4gICAgICApO1xuICAgICAgcmV0dXJuIHJlY2VpcHQ7XG4gICAgfSxcbiAgKTtcbn1cblxuLyoqXG4gKiBIYW5kbGUgb25lIHJhdyBzdGRpbiBwYXlsb2FkIGFuZCByZXR1cm4gdGhlIGV4YWN0IGJ5dGVzIHRvIHdyaXRlIHRvIHN0ZG91dC5cbiAqXG4gKiBNaXJyb3JzIGBoYW5kbGVXb3Jrc3BhY2VIb3N0UmVtb3RlSW5pdGlhbGl6ZXJQYXlsb2FkYCBzbyB0aGUgdHdvIGVudHJ5cG9pbnRzIGJlaGF2ZSBpZGVudGljYWxseVxuICogd2hlcmUgdGhleSBjYW46IG9uZSBKU09OIG9iamVjdCBpbiwgb25lIEpTT04gb2JqZWN0IG91dCwgZmFpbHVyZSBieSBub24temVybyBleGl0LlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gaGFuZGxlV29ya3NwYWNlSG9zdENyZWRlbnRpYWxEZWxpdmVyeVBheWxvYWQoXG4gIHBheWxvYWQ6IHN0cmluZyxcbiAgZGVwczogV29ya3NwYWNlSG9zdENyZWRlbnRpYWxEZWxpdmVyeURlcHMsXG4pOiBQcm9taXNlPHN0cmluZz4ge1xuICBsZXQgcGFyc2VkOiB1bmtub3duO1xuICB0cnkge1xuICAgIHBhcnNlZCA9IEpTT04ucGFyc2UocGF5bG9hZCk7XG4gIH0gY2F0Y2gge1xuICAgIHRocm93IG5ldyBXb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbERlbGl2ZXJ5UHJvdG9jb2xFcnJvcihcbiAgICAgIFwicmVxdWVzdCBib2R5IGlzIG5vdCB2YWxpZCBKU09OXCIsXG4gICAgKTtcbiAgfVxuICBjb25zdCByZXF1ZXN0ID0gcGFyc2VXb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbERlbGl2ZXJ5UmVxdWVzdChwYXJzZWQpO1xuICBjb25zdCByZWNlaXB0ID0gYXdhaXQgZXhlY3V0ZVdvcmtzcGFjZUhvc3RDcmVkZW50aWFsRGVsaXZlcnkocmVxdWVzdCwgZGVwcyk7XG4gIHJldHVybiBgJHtKU09OLnN0cmluZ2lmeShyZWNlaXB0KX1cXG5gO1xufVxuXG4vKiogUmVqZWN0IGFyZ3YgdGhhdCBpcyBub3QgZXhhY3RseSB3aGF0IHRoZSBjb250cm9sbGVyJ3MgY29tbWFuZCBidWlsZGVyIGVtaXRzLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGFzc2VydFdvcmtzcGFjZUhvc3RDcmVkZW50aWFsRGVsaXZlcnlBcmd2KFxuICBhcmd2OiByZWFkb25seSBzdHJpbmdbXSxcbik6IHZvaWQge1xuICBjb25zdCBleHBlY3RlZCA9IFdPUktTUEFDRV9IT1NUX0NSRURFTlRJQUxfREVMSVZFUllfQVJHVjtcbiAgY29uc3QgbWF0Y2hlcyA9XG4gICAgYXJndi5sZW5ndGggPT09IGV4cGVjdGVkLmxlbmd0aCAmJlxuICAgIGV4cGVjdGVkLmV2ZXJ5KCh2YWx1ZSwgaW5kZXgpID0+IGFyZ3ZbaW5kZXhdID09PSB2YWx1ZSk7XG4gIGlmICghbWF0Y2hlcykge1xuICAgIHRocm93IG5ldyBXb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbERlbGl2ZXJ5UHJvdG9jb2xFcnJvcihcbiAgICAgIGBjcmVkZW50aWFsIGRlbGl2ZXJ5IGV4cGVjdHMgYXJndiAke2V4cGVjdGVkLmpvaW4oXCIgXCIpfSwgZ290ICR7YXJndi5qb2luKFwiIFwiKSB8fCBcIihub25lKVwifWAsXG4gICAgKTtcbiAgfVxufVxuXG4vKipcbiAqIEVuY29kZSBhIGRlbGl2ZXJ5IHJlcXVlc3QgZm9yIHRoZSB3aXJlLlxuICpcbiAqIExpdmVzIGJlc2lkZSB0aGUgcGFyc2VyIHRoYXQgcmVhZHMgaXQgYmFjaywgZm9yIHRoZSByZWFzb25cbiAqIGBlbmNvZGVXb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbExpZmVjeWNsZVN0ZXBgIGdpdmVzOiB0aGUgZW5jb2RpbmcgaXMgYSBwcm9wZXJ0eSBvZiB0aGUgcHJvdG9jb2wsXG4gKiBhbmQgYSBjb250cm9sbGVyIHRoYXQgb3Blbi1jb2RlZCBpdCB3b3VsZCBiZSBhIHNlY29uZCBkZWZpbml0aW9uIG9mIHRoZSB3aXJlIGZvcm1hdCBzaXR0aW5nXG4gKiB3aGVyZSBub2JvZHkgd291bGQgbG9vayB3aGVuIHRoZSBmb3JtYXQgY2hhbmdlZC5cbiAqXG4gKiBSZXR1cm5zIGEgcGxhaW4gb2JqZWN0IGJlY2F1c2UgaXQgaXMgYWJvdXQgdG8gYmUgYEpTT04uc3RyaW5naWZ5YC1lZCBvbnRvIGEgcGlwZS4gVGhhdCBpcyB0aGVcbiAqIG9uZSBwbGFjZSB0aGUgbWF0ZXJpYWwgaXMgZGVsaWJlcmF0ZWx5IHVuYm94ZWQsIHNvIGl0IGlzIHRoZSBvbmUgZnVuY3Rpb24gd2hvc2UgY2FsbGVycyBtdXN0IGJlXG4gKiBhdWRpdGVkIOKAlCB3aGljaCBpcyB3aHkgaXQgaXMgYSBuYW1lZCBleHBvcnQgcmF0aGVyIHRoYW4gYW4gaW5saW5lIGxpdGVyYWwgYXQgdGhlIGNhbGwgc2l0ZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGVuY29kZVdvcmtzcGFjZUhvc3RDcmVkZW50aWFsRGVsaXZlcnlSZXF1ZXN0KGlucHV0OiB7XG4gIHJlYWRvbmx5IGNoYW5uZWw6IFdvcmtzcGFjZUhvc3RDcmVkZW50aWFsQ2hhbm5lbDtcbiAgcmVhZG9ubHkgY3JlZGVudGlhbFJlZjogc3RyaW5nO1xuICByZWFkb25seSBnZW5lcmF0aW9uOiBudW1iZXI7XG4gIHJlYWRvbmx5IG1hdGVyaWFsOiBXb3Jrc3BhY2VIb3N0Q3JlZGVudGlhbE1hdGVyaWFsO1xufSk6IFJlYWRvbmx5PFJlY29yZDxzdHJpbmcsIHVua25vd24+PiB7XG4gIHJldHVybiB7XG4gICAgcHJvdG9jb2xWZXJzaW9uOiBXT1JLU1BBQ0VfSE9TVF9DUkVERU5USUFMX0RFTElWRVJZX1BST1RPQ09MX1ZFUlNJT04sXG4gICAgY2hhbm5lbDogaW5wdXQuY2hhbm5lbCxcbiAgICBjcmVkZW50aWFsUmVmOiBpbnB1dC5jcmVkZW50aWFsUmVmLFxuICAgIGdlbmVyYXRpb246IGlucHV0LmdlbmVyYXRpb24sXG4gICAgbWF0ZXJpYWw6IGlucHV0Lm1hdGVyaWFsLnJldmVhbCgpLnRvU3RyaW5nKFwiYmFzZTY0XCIpLFxuICB9O1xufVxuIl0sImZpbGUiOiIvQGZzL2hvbWUvbWFyc2gtb2ZmaWNlL3BhcGVyY3VwYWktd29ya3NwYWNlL3BhcGVyY3VzcC9saWJzL2dlbmVyaWMvZGVwbG95bWVudC1kcml2ZXIvc3JjL3dvcmtzcGFjZS1ob3N0LWNyZWRlbnRpYWwtZGVsaXZlcnkudHMifQ==

//# vitestCache=W3siZmlsZSI6IjEiLCJpZCI6IjEiLCJ1cmwiOiIyIiwiaW1wb3J0ZWRVcmxzIjoiMyIsIm1hcHBpbmdzIjpmYWxzZX0sIi9ob21lL21hcnNoLW9mZmljZS9wYXBlcmN1cGFpLXdvcmtzcGFjZS9wYXBlcmN1c3AvbGlicy9nZW5lcmljL2RlcGxveW1lbnQtZHJpdmVyL3NyYy93b3Jrc3BhY2UtaG9zdC1jcmVkZW50aWFsLWRlbGl2ZXJ5LnRzIiwiL0Bmcy9ob21lL21hcnNoLW9mZmljZS9wYXBlcmN1cGFpLXdvcmtzcGFjZS9wYXBlcmN1c3AvbGlicy9nZW5lcmljL2RlcGxveW1lbnQtZHJpdmVyL3NyYy93b3Jrc3BhY2UtaG9zdC1jcmVkZW50aWFsLWRlbGl2ZXJ5LnRzIixbXV0=
}}