/**
 * Local psu connection front controller.
 *
 * This file owns only transport selection. Once a remote transport is ready it
 * forwards every non-transport argv cell to the remote `psu`; the remote
 * launcher remains authoritative for role, harness, plan, model, account,
 * resume, fork, and every future psu option.
 */
import {
  spawn as nodeSpawn,
  spawnSync as nodeSpawnSync,
} from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import {
  buildOpenSshControlMasterCommand,
  buildOpenSshPtySessionCommand,
  reserveLoopbackPort,
} from "../../../packages/operator-core/lib/workspace-host/local-connection-manager.ts";

export const PSU_CONNECTION_STORE_VERSION = "psu-connection-profiles-v1";
export const DEFAULT_REMOTE_OPERATOR_PORT = 3070;

const PROFILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const GCP_RESOURCE_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,126}[A-Za-z0-9]$/;
const GCP_ZONE_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const SSH_USER_RE = /^[A-Za-z_][A-Za-z0-9._-]{0,63}$/;
const VALUE_FLAGS = new Map([
  ["--connect", "selection"],
  ["--connect-add-gcp-iap", "addName"],
  ["--connect-remove", "removeName"],
  ["--connect-project", "projectId"],
  ["--connect-zone", "zone"],
  ["--connect-instance", "instanceName"],
  ["--connect-user", "sshUser"],
]);

function requiredValue(value, label, pattern) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`${label} has an invalid value`);
  }
  return value;
}

function takeRequiredValue(argv, index, flag) {
  const next = argv[index + 1];
  if (next == null || next.startsWith("--"))
    throw new Error(`${flag} requires a value`);
  return next;
}

/**
 * Strip only the connection-front-controller namespace. A literal `--` closes
 * the namespace; everything at and after it is forwarded byte-for-byte.
 */
export function parsePsuConnectionArgs(argv) {
  const forwardedArgv = [];
  const transport = {
    explicitConnect: false,
    selection: null,
    list: false,
    addName: null,
    removeName: null,
    projectId: null,
    zone: null,
    instanceName: null,
    sshUser: null,
  };
  let passthrough = false;

  for (let index = 0; index < argv.length; index += 1) {
    const cell = argv[index];
    if (passthrough) {
      forwardedArgv.push(cell);
      continue;
    }
    if (cell === "--") {
      passthrough = true;
      forwardedArgv.push(cell);
      continue;
    }
    if (cell === "--connect-list") {
      transport.list = true;
      continue;
    }

    const equals = cell.indexOf("=");
    const key = equals === -1 ? cell : cell.slice(0, equals);
    const field = VALUE_FLAGS.get(key);
    if (!field) {
      forwardedArgv.push(cell);
      continue;
    }

    if (key === "--connect") transport.explicitConnect = true;
    if (equals !== -1) {
      const value = cell.slice(equals + 1);
      if (!value) throw new Error(`${key} requires a value after '='`);
      transport[field] = value;
      continue;
    }
    if (
      key === "--connect" &&
      (argv[index + 1] == null || argv[index + 1].startsWith("--"))
    ) {
      continue;
    }
    transport[field] = takeRequiredValue(argv, index, key);
    index += 1;
  }

  const actions = [
    transport.list,
    Boolean(transport.addName),
    Boolean(transport.removeName),
  ].filter(Boolean).length;
  if (actions > 1)
    throw new Error(
      "Choose only one of --connect-list, --connect-add-gcp-iap, or --connect-remove",
    );
  if (actions && transport.explicitConnect)
    throw new Error("Profile maintenance commands cannot also use --connect");
  if (
    !transport.addName &&
    [
      transport.projectId,
      transport.zone,
      transport.instanceName,
      transport.sshUser,
    ].some(Boolean)
  ) {
    throw new Error(
      "--connect-project/zone/instance/user require --connect-add-gcp-iap",
    );
  }

  return { transport, forwardedArgv };
}

/** Normalize the first supported remote profile. GCP deliberately defaults to IAP. */
export function normalizeGcpIapProfile(input) {
  const name = requiredValue(
    input.name,
    "Connection profile name",
    PROFILE_NAME_RE,
  );
  const projectId = requiredValue(
    input.projectId,
    "GCP project id",
    GCP_RESOURCE_RE,
  );
  const zone = requiredValue(input.zone, "GCP zone", GCP_ZONE_RE);
  const instanceName = requiredValue(
    input.instanceName,
    "GCP instance name",
    GCP_RESOURCE_RE,
  );
  const sshUser = requiredValue(
    input.sshUser,
    "OS Login SSH user",
    SSH_USER_RE,
  );
  const query = new URLSearchParams({
    project: projectId,
    zone,
    instance: instanceName,
  });

  return {
    name,
    kind: "gcp-iap-ssh",
    projectId,
    zone,
    instanceName,
    sshUser,
    endpoint: `gcp-iap-ssh://${instanceName}?${query.toString()}`,
    target: `${sshUser}@${instanceName}`,
    remoteOperatorPort: DEFAULT_REMOTE_OPERATOR_PORT,
    supportedClientPlatforms: ["linux", "macos", "windows"],
    features: {
      command: true,
      pty: true,
      tcpForward: true,
      fileTransfer: true,
    },
    prerequisites: [
      "OpenSSH client",
      "Google Cloud CLI",
      "IAP TCP forwarding permission",
      "OS Login permission",
    ],
    constraints: [
      "No public IP",
      "Interactive control transport; bulk transfer requires an explicit alternate path",
      "SSH host keys are verified by the local OpenSSH configuration",
    ],
    reconnect: "recreate",
    audited: true,
  };
}

function validateStoredProfile(value) {
  if (!value || value.kind !== "gcp-iap-ssh") {
    throw new Error(
      `Unsupported saved psu connection kind '${value?.kind ?? "missing"}'`,
    );
  }
  return normalizeGcpIapProfile(value);
}

export function defaultPsuConnectionStorePath(home = homedir()) {
  return join(home, ".papercusp", "psu-connections.json");
}

export function loadPsuConnectionStore(path = defaultPsuConnectionStorePath()) {
  if (!existsSync(path))
    return { version: PSU_CONNECTION_STORE_VERSION, profiles: [] };
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile())
    throw new Error(`psu connection store must be a regular file: ${path}`);
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw new Error(`psu connection store permissions must be 0600: ${path}`);
  }
  if (stat.size > 1024 * 1024)
    throw new Error("psu connection store exceeds the 1 MiB safety limit");
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `Cannot parse psu connection store ${path}: ${error?.message ?? error}`,
    );
  }
  if (
    parsed?.version !== PSU_CONNECTION_STORE_VERSION ||
    !Array.isArray(parsed.profiles)
  ) {
    throw new Error(`Unsupported psu connection store version in ${path}`);
  }
  const profiles = parsed.profiles.map(validateStoredProfile);
  if (
    new Set(profiles.map((profile) => profile.name)).size !== profiles.length
  ) {
    throw new Error(`Duplicate profile names in psu connection store ${path}`);
  }
  return { version: PSU_CONNECTION_STORE_VERSION, profiles };
}

export function savePsuConnectionStore(
  store,
  path = defaultPsuConnectionStorePath(),
) {
  const profiles = store.profiles.map(validateStoredProfile);
  if (
    new Set(profiles.map((profile) => profile.name)).size !== profiles.length
  ) {
    throw new Error("Cannot save duplicate psu connection profile names");
  }
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(directory, 0o700);
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(
      temp,
      `${JSON.stringify({ version: PSU_CONNECTION_STORE_VERSION, profiles }, null, 2)}\n`,
      {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      },
    );
    renameSync(temp, path);
    if (process.platform !== "win32") chmodSync(path, 0o600);
  } finally {
    rmSync(temp, { force: true });
  }
}

function platformName(platform) {
  if (platform === "darwin") return "macos";
  if (platform === "win32") return "windows";
  return platform;
}

function gcpIapExtraArgs(profile) {
  return [
    "-o",
    `ProxyCommand=gcloud compute start-iap-tunnel ${profile.instanceName} 22 --listen-on-stdin --project=${profile.projectId} --zone=${profile.zone}`,
  ];
}

export function describePsuConnectionProfile(profile) {
  return `${profile.name} — GCP IAP ${profile.projectId}/${profile.zone}/${profile.instanceName} as ${profile.sshUser}`;
}

function defaultCommandAvailable(command) {
  const probe = nodeSpawnSync(command, ["--version"], {
    stdio: "ignore",
    shell: false,
  });
  return !probe.error && probe.status === 0;
}

function defaultRunCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = nodeSpawn(command, args, {
      stdio: options.stdio ?? "inherit",
      shell: false,
      env: options.env ?? process.env,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

function defaultRunInteractive(command, args) {
  return new Promise((resolve, reject) => {
    const child = nodeSpawn(command, args, {
      stdio: "inherit",
      shell: false,
      env: process.env,
    });
    const handlers = new Map();
    for (const signal of ["SIGWINCH", "SIGINT", "SIGTERM", "SIGHUP"]) {
      const handler = () => {
        if (!child.killed) child.kill(signal);
      };
      handlers.set(signal, handler);
      process.on(signal, handler);
    }
    const cleanup = () => {
      for (const [signal, handler] of handlers) process.off(signal, handler);
    };
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("exit", (code, signal) => {
      cleanup();
      resolve({ code, signal });
    });
  });
}

async function defaultPickConnection(profiles) {
  const { select } = await import("@inquirer/prompts");
  return select({
    message: "Where should psu run?",
    choices: [
      { name: "Local — this computer", value: "local" },
      ...profiles.map((profile) => ({
        name: describePsuConnectionProfile(profile),
        value: profile.name,
      })),
    ],
  });
}

async function defaultProbeOperator(origin, attempts = 8) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(`${origin}/api/health`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    if (attempt + 1 < attempts)
      await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `Remote Papercusp operator health probe failed through ${origin}: ${lastError?.message ?? lastError}`,
  );
}

function connectionControlPath(profile, home) {
  const digest = createHash("sha256")
    .update(`${profile.kind}\0${profile.name}\0${profile.endpoint}`)
    .digest("hex")
    .slice(0, 24);
  return join(home, ".papercusp", "ssh", `cm-${digest}`);
}

function tmuxSessionName(profile, argv) {
  const digest = createHash("sha256")
    .update(profile.name)
    .update("\0")
    .update(argv.join("\0"))
    .digest("hex")
    .slice(0, 16);
  return `papercusp-psu-${digest}`;
}

function assertProfileUsable(profile, deps) {
  const clientPlatform = platformName(deps.platform);
  if (!profile.supportedClientPlatforms.includes(clientPlatform)) {
    throw new Error(
      `Connection '${profile.name}' does not support this ${clientPlatform} client`,
    );
  }
  for (const command of ["ssh", "gcloud"]) {
    if (!deps.commandAvailable(command)) {
      throw new Error(
        `Connection '${profile.name}' requires '${command}' on the local PATH`,
      );
    }
  }
  if (
    !profile.features.command ||
    !profile.features.pty ||
    !profile.features.tcpForward
  ) {
    throw new Error(
      `Connection '${profile.name}' does not expose the command, PTY, and TCP-forward capabilities psu requires`,
    );
  }
}

async function establishForward(profile, deps) {
  const controlPath = connectionControlPath(profile, deps.home);
  mkdirSync(dirname(controlPath), { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(dirname(controlPath), 0o700);
  const lease = await deps.reservePort();
  const localPort = lease.port;
  await lease.release();
  const forward = `127.0.0.1:${localPort}:127.0.0.1:${profile.remoteOperatorPort}`;

  const check = await deps.runCommand(
    "ssh",
    ["-S", controlPath, "-O", "check", "--", profile.target],
    { stdio: "ignore" },
  );
  let reused = check.code === 0;
  if (reused) {
    const added = await deps.runCommand(
      "ssh",
      ["-S", controlPath, "-O", "forward", "-L", forward, "--", profile.target],
      { stdio: "inherit" },
    );
    if (added.code !== 0) {
      throw new Error(
        `Could not add the operator forward to the live ControlMaster for '${profile.name}'`,
      );
    }
  }
  if (!reused) {
    rmSync(controlPath, { force: true });
    const master = buildOpenSshControlMasterCommand({
      target: profile.target,
      controlPath,
      localPort,
      remoteOperatorPort: profile.remoteOperatorPort,
      controlPersistSeconds: 60,
      extraArgs: gcpIapExtraArgs(profile),
    });
    const result = await deps.runCommand(
      master.command,
      ["-f", ...master.args],
      { stdio: "inherit" },
    );
    if (result.code !== 0) {
      throw new Error(
        `Could not establish '${profile.name}'. OpenSSH host-key and authentication policy is authoritative; inspect the error above and verify known_hosts, OS Login, and IAP permission.`,
      );
    }
  }

  const cancel = async () => {
    await deps.runCommand(
      "ssh",
      ["-S", controlPath, "-O", "cancel", "-L", forward, "--", profile.target],
      {
        stdio: "ignore",
      },
    );
  };
  return { controlPath, localPort, cancel };
}

function connectionDeps(overrides) {
  const home = overrides.home ?? homedir();
  return {
    home,
    storePath: overrides.storePath ?? defaultPsuConnectionStorePath(home),
    platform: overrides.platform ?? process.platform,
    interactive:
      overrides.interactive ??
      Boolean(process.stdin.isTTY && process.stdout.isTTY),
    pickConnection: overrides.pickConnection ?? defaultPickConnection,
    commandAvailable: overrides.commandAvailable ?? defaultCommandAvailable,
    runCommand: overrides.runCommand ?? defaultRunCommand,
    runInteractive: overrides.runInteractive ?? defaultRunInteractive,
    reservePort: overrides.reservePort ?? reserveLoopbackPort,
    probeOperator: overrides.probeOperator ?? defaultProbeOperator,
    output: overrides.output ?? ((line) => console.log(line)),
    notice: overrides.notice ?? ((line) => console.error(line)),
    transportForwarded:
      overrides.transportForwarded ??
      process.env.PAPERCUSP_PSU_CONNECTION_FORWARDED === "1",
  };
}

/**
 * @returns {Promise<{ handled: boolean, argv: string[], exitCode?: number }>}
 */
export async function runPsuConnectionFrontController(argv, overrides = {}) {
  const deps = connectionDeps(overrides);
  // Set only by the local controller for its remote psu child: prevent a
  // recursive transport picker while preserving every remote launch picker.
  if (deps.transportForwarded) return { handled: false, argv: [...argv] };
  const { transport, forwardedArgv } = parsePsuConnectionArgs(argv);
  const store = loadPsuConnectionStore(deps.storePath);

  if (transport.list) {
    deps.output("local — this computer");
    for (const profile of store.profiles)
      deps.output(describePsuConnectionProfile(profile));
    return { handled: true, argv: forwardedArgv, exitCode: 0 };
  }
  if (transport.addName) {
    const profile = normalizeGcpIapProfile({
      name: transport.addName,
      projectId: transport.projectId,
      zone: transport.zone,
      instanceName: transport.instanceName,
      sshUser: transport.sshUser,
    });
    if (store.profiles.some((saved) => saved.name === profile.name)) {
      throw new Error(
        `Connection profile '${profile.name}' already exists; remove it before replacing it`,
      );
    }
    savePsuConnectionStore(
      { ...store, profiles: [...store.profiles, profile] },
      deps.storePath,
    );
    deps.output(`Saved ${describePsuConnectionProfile(profile)}`);
    return { handled: true, argv: forwardedArgv, exitCode: 0 };
  }
  if (transport.removeName) {
    const profiles = store.profiles.filter(
      (profile) => profile.name !== transport.removeName,
    );
    if (profiles.length === store.profiles.length)
      throw new Error(`Unknown connection profile '${transport.removeName}'`);
    savePsuConnectionStore({ ...store, profiles }, deps.storePath);
    deps.output(`Removed psu connection profile '${transport.removeName}'`);
    return { handled: true, argv: forwardedArgv, exitCode: 0 };
  }

  const passthroughBoundary = forwardedArgv.indexOf("--");
  const launcherArgv =
    passthroughBoundary === -1
      ? forwardedArgv
      : forwardedArgv.slice(0, passthroughBoundary);
  const requestsLocalHelp = launcherArgv.some(
    (cell) => cell === "--help" || cell === "-h",
  );
  const pickerAllowed =
    deps.interactive &&
    !requestsLocalHelp &&
    !forwardedArgv.includes("--no-picker") &&
    !forwardedArgv.includes("--headless");
  let selection = transport.selection;
  if (transport.explicitConnect && selection == null && !pickerAllowed) {
    throw new Error(
      "--connect needs a saved profile name when psu is non-interactive",
    );
  }
  if (selection == null && pickerAllowed)
    selection = await deps.pickConnection(store.profiles);
  if (selection == null || selection === "local")
    return { handled: false, argv: forwardedArgv };

  const profile = store.profiles.find(
    (candidate) => candidate.name === selection,
  );
  if (!profile)
    throw new Error(
      `Unknown psu connection profile '${selection}'. Run psu --connect-list to inspect saved profiles.`,
    );
  assertProfileUsable(profile, deps);
  deps.notice(
    `psu: connecting through ${describePsuConnectionProfile(profile)}`,
  );
  for (const constraint of profile.constraints)
    deps.notice(`psu: transport constraint — ${constraint}`);

  const forward = await establishForward(profile, deps);
  try {
    await deps.probeOperator(`http://127.0.0.1:${forward.localPort}`);
    const remoteArgv = [
      "tmux",
      "new-session",
      "-A",
      "-s",
      tmuxSessionName(profile, forwardedArgv),
      "--",
      "env",
      "PAPERCUSP_PSU_CONNECTION_FORWARDED=1",
      "psu",
      ...forwardedArgv,
    ];
    const session = buildOpenSshPtySessionCommand({
      target: profile.target,
      controlPath: forward.controlPath,
      remoteArgv,
    });
    const result = await deps.runInteractive(session.command, session.args);
    if (result.signal)
      throw new Error(`Remote psu transport ended on ${result.signal}`);
    if (result.code === 255) {
      throw new Error(
        `Remote psu transport failed. The tmux session remains reattachable; retry psu --connect=${profile.name} after correcting the OpenSSH/IAP error above.`,
      );
    }
    return { handled: true, argv: forwardedArgv, exitCode: result.code ?? 1 };
  } finally {
    await forward.cancel();
  }
}
