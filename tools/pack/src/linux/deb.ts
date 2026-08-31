import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { ToolPackConfig } from "../config/index.js";
import { commandExists, DEB_PACKAGE_NAME, findBuiltDeb, resolveLinuxPaths } from "../linux.js";

export type DebPrivilege = "direct" | "sudo";
export type DebPackageManager = "apt-get" | "dpkg";

export function resolveDebPrivilege(input: { isRoot: boolean; hasSudo: boolean }): DebPrivilege {
  if (input.isRoot) return "direct";
  if (input.hasSudo) return "sudo";
  throw new Error("deb smoke requires root or NOPASSWD sudo");
}

// Presence-based, picked once per flow: apt-get resolves dependencies for
// local .deb paths; dpkg is the offline fallback. Missing dpkg means the host
// cannot run deb smoke at all.
export function pickDebPackageManager(input: { hasAptGet: boolean; hasDpkg: boolean }): DebPackageManager {
  if (!input.hasDpkg) {
    throw new Error("deb smoke requires a Debian-family host");
  }
  return input.hasAptGet ? "apt-get" : "dpkg";
}

function composePrivileged(privilege: DebPrivilege, postPrefix: string[]): { command: string; args: string[] } {
  if (privilege === "sudo") {
    return { command: "sudo", args: ["-n", ...postPrefix] };
  }
  const [command, ...args] = postPrefix;
  if (command == null) throw new Error("empty deb command argv");
  return { command, args };
}

export function composeDebInstallCommand(input: {
  packageManager: DebPackageManager;
  privilege: DebPrivilege;
  artifactPath: string;
}): { command: string; args: string[] } {
  if (input.packageManager === "dpkg") {
    return composePrivileged(input.privilege, [
      "env",
      "DEBIAN_FRONTEND=noninteractive",
      "dpkg",
      "-i",
      input.artifactPath,
    ]);
  }
  return composePrivileged(input.privilege, [
    "env",
    "DEBIAN_FRONTEND=noninteractive",
    "apt-get",
    "install",
    "-y",
    input.artifactPath,
  ]);
}

export function composeDebUninstallCommand(input: {
  packageManager: DebPackageManager;
  privilege: DebPrivilege;
}): { command: string; args: string[] } {
  if (input.packageManager === "apt-get") {
    return composePrivileged(input.privilege, [
      "env",
      "DEBIAN_FRONTEND=noninteractive",
      "apt-get",
      "remove",
      "-y",
      DEB_PACKAGE_NAME,
    ]);
  }
  return composePrivileged(input.privilege, ["dpkg", "-r", DEB_PACKAGE_NAME]);
}

export type DpkgQueryStatus = { status: string; version: string };

export function parseDpkgQueryStatus(stdout: string): DpkgQueryStatus | null {
  const line = stdout.trim().split("\n")[0] ?? "";
  const separator = line.indexOf("|");
  if (separator < 0) return null;
  const status = line.slice(0, separator).trim();
  const version = line.slice(separator + 1).trim();
  if (status.length === 0 || version.length === 0) return null;
  return { status, version };
}

export function isDebInstalled(status: DpkgQueryStatus): boolean {
  return status.status === "install ok installed";
}

// electron-builder's deb target maps `-` to `~` (getSanitizedVersion) so
// prerelease versions sort before the base release in dpkg ordering. Used for
// JSON result reporting only; install verification always reads the Version
// straight from the built artifact.
export function sanitizeDebVersion(version: string): string {
  return version.replace(/-/g, "~");
}

const execFileAsync = promisify(execFile);

export type DebCommandRunner = (command: string, args: string[]) => Promise<{ stdout: string }>;

export type DebEnvironment = {
  isRoot: boolean;
  hasSudo: boolean;
  hasAptGet: boolean;
  hasDpkg: boolean;
};

export type DebOrchestratorOptions = {
  environment?: DebEnvironment;
  run?: DebCommandRunner;
};

async function detectDebEnvironment(): Promise<DebEnvironment> {
  return {
    isRoot: typeof process.getuid === "function" && process.getuid() === 0,
    hasSudo: await commandExists("sudo"),
    hasAptGet: await commandExists("apt-get"),
    hasDpkg: await commandExists("dpkg"),
  };
}

export type LinuxDebInstallResult = {
  artifactPath: string;
  packageManager: DebPackageManager;
  package: string;
  version: string;
  installedFiles: string[];
};

export async function installPackedLinuxDeb(
  config: ToolPackConfig,
  options: DebOrchestratorOptions = {},
): Promise<LinuxDebInstallResult> {
  const { environment = await detectDebEnvironment(), run = execFileAsync } = options;
  const privilege = resolveDebPrivilege({ isRoot: environment.isRoot, hasSudo: environment.hasSudo });
  const packageManager = pickDebPackageManager({
    hasAptGet: environment.hasAptGet,
    hasDpkg: environment.hasDpkg,
  });

  const artifactPath = await findBuiltDeb(resolveLinuxPaths(config));
  if (artifactPath == null) {
    throw new Error("no .deb found in builder output; run `tools-pack linux build --to deb` first");
  }

  const { command, args } = composeDebInstallCommand({ packageManager, privilege, artifactPath });
  await run(command, args);

  const artifactVersion = (await run("dpkg-deb", ["-f", artifactPath, "Version"])).stdout.trim();
  const query = parseDpkgQueryStatus(
    (await run("dpkg-query", ["-W", "-f=${Status}|${Version}", DEB_PACKAGE_NAME])).stdout,
  );
  if (query == null || !isDebInstalled(query) || query.version !== artifactVersion) {
    const observed = query == null ? "no dpkg-query output" : `${query.status} at ${query.version}`;
    throw new Error(
      `deb install verification failed: expected install ok installed at ${artifactVersion}, got ${observed}`,
    );
  }

  const installedFiles = (await run("dpkg-query", ["-L", DEB_PACKAGE_NAME])).stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  return {
    artifactPath,
    packageManager,
    package: DEB_PACKAGE_NAME,
    version: sanitizeDebVersion(artifactVersion),
    installedFiles,
  };
}

export type LinuxDebUninstallResult = {
  package: string;
  packageManager: DebPackageManager;
  status: string;
};

export async function uninstallPackedLinuxDeb(options: DebOrchestratorOptions = {}): Promise<LinuxDebUninstallResult> {
  const { environment = await detectDebEnvironment(), run = execFileAsync } = options;
  const privilege = resolveDebPrivilege({ isRoot: environment.isRoot, hasSudo: environment.hasSudo });
  const packageManager = pickDebPackageManager({
    hasAptGet: environment.hasAptGet,
    hasDpkg: environment.hasDpkg,
  });

  const { command, args } = composeDebUninstallCommand({ packageManager, privilege });
  await run(command, args);

  // dpkg-query exits non-zero once the package is fully unknown (purged);
  // `deinstall ok config-files` residue exits zero and is reported as-is.
  let status = "unknown";
  try {
    const query = parseDpkgQueryStatus(
      (await run("dpkg-query", ["-W", "-f=${Status}|${Version}", DEB_PACKAGE_NAME])).stdout,
    );
    if (query != null) status = query.status;
  } catch (error) {
    if (!(error instanceof Error && /no packages found matching/i.test(error.message))) {
      throw error;
    }
    status = "not-installed";
  }
  if (status === "install ok installed") {
    throw new Error(`deb uninstall verification failed: ${DEB_PACKAGE_NAME} is still installed`);
  }

  return { package: DEB_PACKAGE_NAME, packageManager, status };
}
