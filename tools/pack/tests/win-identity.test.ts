import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import winCustomInstallerSource from "@/win/custom-installer.ts?raw";
import { createNsisQuotedCommandLiteral } from "@/win/custom-installer.js";
import { resolveWinInstallIdentity } from "@/win/identity.js";

const execFileAsync = promisify(execFile);

describe("resolveWinInstallIdentity", () => {
  it("keeps the default namespace on the canonical Windows display name", () => {
    expect(resolveWinInstallIdentity({ namespace: "default" })).toMatchObject({
      displayName: "Open Design",
      shortcutName: "Open Design.lnk",
      uninstallerName: "Uninstall Open Design.exe",
    });
  });

  it("uses the canonical Windows display name for stable release namespaces", () => {
    expect(resolveWinInstallIdentity({ namespace: "release-stable-win" })).toMatchObject({
      appPathsKey: "Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Open Design.exe",
      displayName: "Open Design",
      registryKey: "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Open Design-release-stable-win",
      shortcutName: "Open Design.lnk",
      uninstallerName: "Uninstall Open Design.exe",
    });
  });

  it("uses first-class beta display identity for beta release namespaces", () => {
    expect(resolveWinInstallIdentity({ namespace: "release-beta-win" })).toMatchObject({
      appPathsKey: "Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Open Design Beta.exe",
      displayName: "Open Design Beta",
      registryKey: "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Open Design-release-beta-win",
      shortcutName: "Open Design Beta.lnk",
      uninstallerName: "Uninstall Open Design Beta.exe",
    });
  });

  it("keeps non-release beta-like namespaces isolated from the real beta channel identity", () => {
    expect(resolveWinInstallIdentity({ namespace: "beta-local-flow" })).toMatchObject({
      appPathsKey: "Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Open Design beta-local-flow.exe",
      displayName: "Open Design beta-local-flow",
      registryKey: "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Open Design-beta-local-flow",
      shortcutName: "Open Design beta-local-flow.lnk",
      uninstallerName: "Uninstall Open Design beta-local-flow.exe",
    });
  });

  it("uses first-class preview display identity for preview release namespaces", () => {
    expect(resolveWinInstallIdentity({ namespace: "release-preview-win" })).toMatchObject({
      appPathsKey: "Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Open Design Preview.exe",
      displayName: "Open Design Preview",
      registryKey: "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Open Design-release-preview-win",
      shortcutName: "Open Design Preview.lnk",
      uninstallerName: "Uninstall Open Design Preview.exe",
    });
  });

  it("uses first-class prerelease display identity for prerelease release versions and namespaces", () => {
    expect(resolveWinInstallIdentity({
      appVersion: "0.8.0-prerelease.2",
      namespace: "release-stable-win",
    })).toMatchObject({
      appPathsKey: "Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Open Design Prerelease.exe",
      displayName: "Open Design Prerelease",
      registryKey: "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Open Design-release-stable-win",
      shortcutName: "Open Design Prerelease.lnk",
      uninstallerName: "Uninstall Open Design Prerelease.exe",
    });
    expect(resolveWinInstallIdentity({ namespace: "release-prerelease-win" })).toMatchObject({
      displayName: "Open Design Prerelease",
      shortcutName: "Open Design Prerelease.lnk",
    });
  });

  it("keeps the registry DisplayName free of the package version", () => {
    const source = winCustomInstallerSource;
    expect(source).toContain('WriteRegStr HKCU "${registryKey}" "DisplayName" "${productName}"');
    expect(source).not.toContain('"DisplayName" "${productName} \\${APP_VERSION}"');
  });

  it("emits a valid NSIS command literal for executable paths containing spaces", () => {
    expect(createNsisQuotedCommandLiteral(["$INSTDIR\\Open Design.exe", "%1"])).toBe(
      `'"$INSTDIR\\Open Design.exe" "%1"'`,
    );
    expect(createNsisQuotedCommandLiteral(["$INSTDIR\\Open Design.exe"])).toBe(
      `'"$INSTDIR\\Open Design.exe"'`,
    );
  });

  it("removes an Electron-refreshed invite protocol while this install still owns it", () => {
    const source = winCustomInstallerSource;
    expect(source).toContain('const inviteProtocolKey = "Software\\\\Classes\\\\opendesign"');
    expect(source).toContain('WriteRegStr HKCU "${inviteProtocolKey}" "URL Protocol" ""');
    expect(source).toContain(
      'WriteRegStr HKCU "${inviteProtocolKey}\\\\shell\\\\open\\\\command" "" ${inviteProtocolCommand}',
    );
    expect(source).toContain('$INSTDIR\\\\${exeName}');
    expect(source).toContain(
      'ReadRegStr $0 HKCU "${inviteProtocolKey}\\\\shell\\\\open\\\\command" ""',
    );
    expect(source).toContain(
      "const inviteProtocolExecutablePrefix = createNsisQuotedCommandLiteral([`$INSTDIR\\\\${exeName}`])",
    );
    expect(source).toContain("StrCpy $1 ${inviteProtocolExecutablePrefix}");
    expect(source).toContain("StrLen $2 $1");
    expect(source).toContain("StrCpy $3 $0 $2");
    expect(source).toContain("StrCmp $3 $1 0 preserve_invite_protocol");
    expect(source).not.toContain(
      "StrCmp $0 ${inviteProtocolCommand} 0 preserve_invite_protocol",
    );
    expect(source).toContain('DeleteRegKey HKCU "${inviteProtocolKey}"');
    expect(source).toContain("preserve_invite_protocol:");
    expect(source.indexOf("StrCmp $3 $1")).toBeLessThan(
      source.indexOf('DeleteRegKey HKCU "${inviteProtocolKey}"'),
    );
    expect(source.indexOf('DeleteRegKey HKCU "${inviteProtocolKey}"')).toBeLessThan(
      source.indexOf("preserve_invite_protocol:"),
    );
  });

  it("checks the silent install target directory for running instances before overwriting files", () => {
    const source = winCustomInstallerSource;
    const silentCheck = source.slice(source.indexOf("silent_check:"), source.indexOf("IfFileExists \"$INSTDIR\\\\${exeName}\" existing_install"));
    expect(silentCheck).toContain('IfFileExists "$INSTDIR\\\\${exeName}" 0 silent_detect_running_instances');
    expect(silentCheck).toContain('StrCpy $RunningInstancesInstallRoot "$INSTDIR"');
    expect(silentCheck.indexOf('StrCpy $RunningInstancesInstallRoot "$INSTDIR"')).toBeLessThan(
      silentCheck.indexOf("Call DetectRunningInstances"),
    );
  });
});
