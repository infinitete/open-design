import { DEB_PACKAGE_NAME } from "../linux.js";

export type DebPrivilege = "direct" | "sudo";
export type DebPackageManager = "apt-get" | "dpkg";

export function resolveDebPrivilege(input: { isRoot: boolean; hasSudo: boolean }): DebPrivilege {
  if (input.isRoot) return "direct";
  if (input.hasSudo) return "sudo";
  throw new Error("deb install smoke requires root or NOPASSWD sudo");
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
