// @vitest-environment node

import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { describe, expect, test } from 'vitest';

import {
  packagedAppShellExpression,
  packagedAppRouteUrl,
  PackagedOnboardingConfigError,
  packagedOnboardingCompletedFromProbe,
  packagedOnboardingConfigExpression,
  runPackagedAppShellPhase,
  type PackagedAppShellState,
} from '@/vitest/packaged-app-shell';
import { createPackagedSmokeReport } from '@/vitest/packaged-report';
import { resolvePackagedSmokeProfile } from '@/vitest/packaged-smoke-profile';
import {
  assertPackagedPtySmokeResult,
  packagedPtySmokeExpression,
} from '@/vitest/packaged-pty-smoke';
import { releaseAppVersionArgs, resolvePackagedWinInstallIdentity } from '@/vitest/packaged-win-identity';
import { resolvePackagedSmokeNamespace } from '@/vitest/suite';
import { missingWorkingWinInstallerOverwriteMarkers } from '@/vitest/win-installer-log';

const execFileAsync = promisify(execFile);
const e2eRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const workspaceRoot = dirname(e2eRoot);
const toolsPackDir = resolveFromWorkspace(process.env.OD_PACKAGED_E2E_TOOLS_PACK_DIR ?? '.tmp/tools-pack');
const namespace = resolvePackagedSmokeNamespace('win');
const toolsPackBin = join(workspaceRoot, 'tools', 'pack', 'bin', 'tools-pack.mjs');
const maxInstallDurationMs = Number.parseInt(process.env.OD_PACKAGED_E2E_WIN_MAX_INSTALL_MS ?? '120000', 10);
// `??` would keep an EMPTY value, and the release workflows can hand one down
// — see `resolvePackagedSmokeProfile` for why all three layers have to agree
// that empty means unset. An empty value surviving here reads as "not core"
// and silently selects the deeper full-profile path.
const smokeProfile = resolvePackagedSmokeProfile(process.env.OD_PACKAGED_E2E_WIN_SMOKE_PROFILE);
const verifyCoreOnly = smokeProfile === 'core';
const verifyReinstallWhileRunning = !verifyCoreOnly && process.env.OD_PACKAGED_E2E_WIN_VERIFY_REINSTALL !== '0';
const verifyUpgradePersistence =
  !verifyCoreOnly && process.env.OD_PACKAGED_E2E_WIN_VERIFY_UPGRADE_PERSISTENCE === '1';
// The release workflows hand the channel down alongside the version, and the
// per-channel tools-pack launcher root is keyed on it. Empty means unset, the
// same "empty is nothing chosen" rule `resolvePackagedSmokeProfile` documents.
const releaseChannel = normalizeOptionalEnv(process.env.OD_PACKAGED_E2E_RELEASE_CHANNEL) ?? 'beta';
const releaseVersion = process.env.OD_PACKAGED_E2E_RELEASE_VERSION;
const packagedInviteDeeplink =
  'opendesign://workspace/invite/continue?workspace_id=packaged-smoke-workspace&member_id=packaged-smoke-member&invite_id=packaged-smoke-invite&nonce=packaged-smoke-nonce';
const installIdentity = resolvePackagedWinInstallIdentity({ namespace, releaseVersion });

const outputNamespaceRoot = join(toolsPackDir, 'out', 'win', 'namespaces', namespace);
const runtimeNamespaceRoot = join(toolsPackDir, 'runtime', 'win', 'namespaces', namespace);
const launcherNamespaceRoot = join(
  toolsPackDir,
  'runtime',
  'win',
  'launcher',
  'channels',
  releaseChannel,
  'namespaces',
  namespace,
);
const screenshotPath = join(toolsPackDir, 'screenshots', `${namespace}.png`);
const preUpdateScreenshotPath = join(toolsPackDir, 'screenshots', `${namespace}-before-update.png`);
const readinessExpression = `
  (() => ({
    href: location.href,
    mounted: document.documentElement.getAttribute('data-od-app-mounted'),
    readyState: document.readyState,
    title: document.title,
  }))()
`;
const healthExpression = `
  (async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    try {
      const response = await fetch('/api/health', { signal: controller.signal });
      return {
        health: await response.json(),
        href: location.href,
        status: response.status,
        title: document.title,
      };
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : String(error),
        href: location.href,
        name: error instanceof Error ? error.name : null,
        title: document.title,
      };
    } finally {
      clearTimeout(timeout);
    }
  })()
`;
const upgradePersistenceProjectId = `packaged-upgrade-persistence-${Date.now().toString(36)}`;
const upgradePersistenceSeedExpression = `
  (async () => {
    const projectId = ${JSON.stringify(upgradePersistenceProjectId)};
    const html = '<!doctype html><html><head><style>' +
      'html,body{margin:0}.slide{width:1920px;height:1080px;display:flex;align-items:center;justify-content:center;font:96px sans-serif;color:white}' +
      '.slide:first-child{background:#17324d}.slide:last-child{background:#8b3a2b}' +
      '</style></head><body><section class="slide">Upgrade From 0.12</section><section class="slide">Persistence Check</section></body></html>';
    const created = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: projectId, name: 'Packaged upgrade persistence' }),
    });
    const written = created.ok
      ? await fetch('/api/projects/' + encodeURIComponent(projectId) + '/files', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'deck.html', content: html }),
        })
      : null;
    return {
      createdOk: created.ok,
      createdStatus: created.status,
      projectId,
      writtenOk: written?.ok ?? false,
      writtenStatus: written?.status ?? null,
    };
  })()
`;

const packagedOnboardingExpression = `
  (() => {
    const onboardingShell = document.querySelector('.entry-shell--onboarding');
    const onboardingModal = document.querySelector('.entry-onboarding-modal');
    // Identity is the first gate; runtime selection follows Cloud sign-in.
    const cloudSignIn = document.querySelector('.onboarding-cloud__primary');

    return {
      cloudSignInVisible: cloudSignIn instanceof HTMLElement,
      href: location.href,
      onboardingVisible: onboardingShell instanceof HTMLElement && onboardingModal instanceof HTMLElement,
      text: onboardingModal?.textContent?.trim().slice(0, 2000) ?? null,
      title: document.title,
    };
  })()
`;

type DesktopStatus = {
  pid?: number;
  state?: string;
  title?: string | null;
  url?: string | null;
  windowVisible?: boolean;
};

type WinInstallResult = {
  desktopShortcutExists: boolean;
  desktopShortcutPath: string;
  installDir: string;
  installPayload: {
    fileCount: number;
    totalBytes: number;
    topLevel: Array<{
      bytes: number;
      fileCount: number;
      path: string;
    }>;
  };
  installerPath: string;
  lifecycleTimings?: SmokeTiming[];
  namespace: string;
  registryEntries: unknown[];
  startMenuShortcutExists: boolean;
  startMenuShortcutPath: string;
  timingPath: string;
  uninstallerPath: string;
};

type WinStartResult = {
  executablePath: string;
  logPath: string;
  namespace: string;
  pid: number;
  source: string;
  status: DesktopStatus | null;
};

type WinStopResult = {
  namespace: string;
  remainingPids: number[];
  status: string;
};

type WinCleanupResult = {
  namespace: string;
  residueObservation?: {
    installedExeExists?: boolean;
    managedProcessPids?: number[];
    productNamespaceRootExists?: boolean;
    registryResidues?: string[];
    startMenuShortcutExists?: boolean;
    uninstallerExists?: boolean;
    userDesktopShortcutExists?: boolean;
  };
};

type WinUninstallResult = {
  lifecycleTimings?: SmokeTiming[];
  namespace: string;
  residueObservation?: WinCleanupResult['residueObservation'];
};

type WinInspectResult = {
  daemonStatus: DesktopStatus | null;
  daemonStatusError?: string;
  desktopIpcUnavailable?: boolean;
  eval?: {
    error?: string;
    ok: boolean;
    value?: unknown;
  };
  screenshot?: {
    path: string;
  };
  status: DesktopStatus | null;
  statusError?: string;
  webStatus: DesktopStatus | null;
  webStatusError?: string;
  launcher: LauncherSnapshot;
};

type LauncherSnapshot = {
  active: LauncherPointer | null;
  attempt: (LauncherPointer & { channel?: string; namespace?: string }) | null;
  attemptsPath: string;
  channel: string;
  error?: string;
  exists: boolean;
  handoff: unknown | null;
  handoffPath: string;
  lastSuccessful: LauncherPointer | null;
  namespace: string;
  root: string;
  runtimePath: string;
  stateRoot: string;
  versionRoots: string[];
  versionsRoot: string;
};

type LauncherPointer = {
  generation: number;
  version: string;
};

type LogsResult = {
  logs: Record<string, { lines: string[]; logPath: string }>;
  namespace: string;
};

type TimingResult = {
  action: string;
  durationMs: number;
  status: string;
};

type HealthEvalValue = {
  health: {
    ok?: unknown;
    service?: unknown;
    version?: unknown;
  };
  href: string;
  status: number;
  title: string;
};

type UpgradePersistenceSeed = {
  createdOk: boolean;
  createdStatus: number;
  projectId: string;
  writtenOk: boolean;
  writtenStatus: number | null;
};

type PackagedOnboardingEvalValue = {
  cloudSignInVisible: boolean;
  href: string;
  onboardingVisible: boolean;
  text: string | null;
  title: string;
};

type SmokeTiming = {
  durationMs: number;
  step: string;
};

type DirectInstallerResult = {
  code: number | null;
  nsisLogTail: string[];
};

const shouldRunPackagedWinSmoke = process.platform === 'win32' && process.env.OD_PACKAGED_E2E_WIN === '1';
const winDescribe = shouldRunPackagedWinSmoke ? describe : describe.skip;
const shouldRunPackagedWinOnboardingSmoke =
  shouldRunPackagedWinSmoke && process.env.OD_PACKAGED_E2E_WIN_ONBOARDING_SMOKE === '1';
const winOnboardingDescribe = shouldRunPackagedWinOnboardingSmoke ? describe : describe.skip;

winDescribe('packaged windows runtime smoke', () => {
  let installed = false;
  let started = false;

  test('[P2] installs, starts, inspects with eval and screenshot, stops, and uninstalls the built windows artifact', async () => {
    const report = await createPackagedSmokeReport('win');
    let passed = false;
    const timings: SmokeTiming[] = [];
    let appShell: PackagedAppShellState | 'skipped' = 'skipped';
    let firstRunAppShell: PackagedAppShellState | 'skipped' = 'skipped';
    let seededOnboardingCompleted: boolean | 'skipped' = 'skipped';
    let onboardingCompleted: boolean | 'skipped' = 'skipped';
    let reinstall: DirectInstallerResult | { skipped: true } = { skipped: true };
    let logs: LogsResult | { skipped: true } = { skipped: true };
    let stop: WinStopResult | { skipped: true } = { skipped: true };
    let upgradePersistence: UpgradePersistenceSeed | { skipped: true } = { skipped: true };
    try {
      await measureSmokeStep(timings, 'pre-clean uninstall', async () => {
        await runToolsPackJson<WinUninstallResult>('uninstall', ['--remove-product-user-data']).catch(() => null);
        await resetPackagedUpdaterNamespaceRoots();
      });

      const install = await measureSmokeStep(timings, 'install', async () => runToolsPackJson<WinInstallResult>('install'));
      installed = true;

      expect(install.namespace).toBe(namespace);
      expectPathInside(install.installerPath, join(outputNamespaceRoot, 'builder'));
      expectPathInside(install.installDir, join(runtimeNamespaceRoot, 'install'));
      expectPathInside(install.uninstallerPath, install.installDir);
      expect(basename(install.uninstallerPath)).toBe(`Uninstall ${installIdentity.displayName}.exe`);
      expect(install.desktopShortcutExists).toBe(true);
      expect(install.startMenuShortcutExists).toBe(true);
      expect(basename(install.desktopShortcutPath)).toBe(`${installIdentity.displayName}.lnk`);
      expect(basename(install.startMenuShortcutPath)).toBe(`${installIdentity.displayName}.lnk`);
      expect(install.registryEntries.length).toBeGreaterThan(0);
      expect(JSON.stringify(install.registryEntries)).toContain(installIdentity.displayName);
      expect(JSON.stringify(install.registryEntries)).toContain(`Open Design-${installIdentity.namespaceToken}`);
      await assertWindowsInviteProtocolRegistration(install.installDir);
      expect(install.installPayload.fileCount).toBeGreaterThan(0);
      expect(install.installPayload.totalBytes).toBeGreaterThan(0);
      expect(install.installPayload.topLevel.length).toBeGreaterThan(0);
      const installTiming = await readTiming(install.timingPath);
      expect(installTiming.action).toBe('install');
      expect(installTiming.status).toBe('success');
      if (installTiming.durationMs > maxInstallDurationMs) {
        throw new Error(
          [
            `windows installer exceeded ${maxInstallDurationMs}ms budget: ${installTiming.durationMs}ms`,
            `installed files=${install.installPayload.fileCount} bytes=${install.installPayload.totalBytes}`,
            `top-level payload=${JSON.stringify(install.installPayload.topLevel.slice(0, 8))}`,
          ].join('\n'),
        );
      }

      // Phase 1 — the genuine first run. A packaged install nobody has signed
      // into is real product behaviour, not a broken state: since
      // `shouldRouteToFirstRunOnboarding` keys purely on `onboardingCompleted`,
      // the cloud sign-in landing is its correct terminal surface, and it is
      // accepted only when it actually rendered its sign-in CTA and both runtime
      // links. Core-only on purpose — every release workflow defaults there, and
      // the full profile refuses that landing because it has to drive the entry
      // rail, which is unreachable while onboarding is up.
      if (verifyCoreOnly) {
        await resetPackagedRuntimeDataRoot();
        const firstRunStart = await measureSmokeStep(timings, 'start unseeded first run', async () =>
          runToolsPackJson<WinStartResult>('start'),
        );
        started = true;
        expect(firstRunStart.source).toBe('installed');
        const firstRunInspect = await measureSmokeStep(timings, 'wait healthy unseeded first run', async () =>
          waitForHealthyDesktop(),
        );
        expect(firstRunInspect.status?.state).toBe('running');
        if (!firstRunInspect.desktopIpcUnavailable) {
          const firstRunPhase = await measureSmokeStep(timings, 'ensure first-run app shell', async () =>
            runPackagedAppShellPhase({
              coreProfile: verifyCoreOnly,
              describeLast: formatUnknown,
              observe: observePackagedAppShell,
              readOnboardingConfig: readPackagedOnboardingConfig,
              scenario: 'first-run',
            }),
          );
          expect(firstRunPhase.onboardingCompleted).toBe(false);
          expect(firstRunPhase.appShell).toBe('onboarding-landing');
          firstRunAppShell = firstRunPhase.appShell;
        }
        const firstRunStop = await measureSmokeStep(timings, 'stop unseeded first run', async () =>
          runToolsPackJson<WinStopResult>('stop'),
        );
        started = false;
        expect(firstRunStop.status).not.toBe('partial');
        expect(firstRunStop.remainingPids).toEqual([]);
        // Clear both the daemon data root and the Electron user-data partition
        // so phase 2's seed lands on a true clean slate and no localStorage
        // residue from this phase can ratchet into it.
        await resetPackagedRuntimeDataRoot();
      }

      await seedPackagedOnboardingComplete();

      const startDesktop = async (step: string): Promise<WinStartResult> => {
        const nextStart = await measureSmokeStep(timings, step, async () => runToolsPackJson<WinStartResult>('start'));
        started = true;
        return nextStart;
      };
      let start = await startDesktop('start');

      expect(start.namespace).toBe(namespace);
      expect(start.source).toBe('installed');
      expectPathInside(start.executablePath, install.installDir);
      expectPathInside(start.logPath, join(runtimeNamespaceRoot, 'logs', 'desktop'));
      expect(start.pid).toBeGreaterThan(0);

      const inspect = await measureSmokeStep(timings, 'wait healthy inspect eval', async () => waitForHealthyDesktop());
      expect(inspect.status?.state).toBe('running');
      if (inspect.desktopIpcUnavailable) expectWindowsFallbackWebUrl(inspect.status?.url);
      else expectWindowsPackagedRouteUrl(inspect.status?.url);

      const value = assertHealthEvalValue(inspect.eval?.value);
      if (inspect.desktopIpcUnavailable) expectWindowsDaemonUrl(value.href);
      else expectWindowsPackagedRouteUrl(value.href);
      expect(value.status).toBe(200);
      expect(value.health.ok).toBe(true);
      if (releaseVersion != null && releaseVersion !== '') expect(value.health.version).toBe(releaseVersion);
      else expect(value.health.version).toEqual(expect.any(String));

      // Establish the data-root postcondition before probing unrelated runtime
      // capabilities. A healthy auth-first renderer may already be on
      // od://app/onboarding, but it must still read the completed seed written
      // into this tools-pack namespace.
      if (!inspect.desktopIpcUnavailable) {
        seededOnboardingCompleted = await measureSmokeStep(timings, 'verify seeded onboarding config', async () =>
          packagedOnboardingCompletedFromProbe(await readPackagedOnboardingConfig()),
        );
        expect(
          seededOnboardingCompleted,
          'daemon did not read the seeded onboardingCompleted config; check that the packaged data root still resolves to the tools-pack runtime namespace root',
        ).toBe(true);
      }

      const ptyInspect = await measureSmokeStep(timings, 'packaged PTY capability', async () =>
        runToolsPackJson<WinInspectResult>('inspect', [
          '--expr',
          packagedPtySmokeExpression('win32'),
        ]),
      );
      const pty = assertPackagedPtySmokeResult(ptyInspect.eval?.value);
      expect(pty.projectCreateStatus).toBe(200);
      expect(pty.projectSeedStatus).toBe(200);
      expect(pty.terminalCreateStatus).toBe(200);
      expect(pty.stdinStatus).toBe(200);
      expect(pty.output).toContain(pty.marker);
      expect(pty.exitCode, JSON.stringify(pty, null, 2)).toBe(0);
      expect(pty.cleanup.terminalStatus).toBe(200);
      expect(pty.cleanup.projectStatus).toBe(200);
      // Runtime registration must preserve the stable installed outer path;
      // pointing at a versioned payload would break the scheme after cleanup.
      await assertWindowsInviteProtocolRegistration(install.installDir);
      const protocolHotPid = inspect.status?.pid ?? start.pid;
      const protocolHotContinuationCount = await countInviteContinuationResults();
      await invokeWindowsInviteDeeplink();
      const [protocolHotInspect, protocolHotContinuation] = await measureSmokeStep(
        timings,
        'invite protocol hot delivery',
        async () => Promise.all([
          waitForHealthyDesktop(),
          waitForInviteContinuationResult(protocolHotContinuationCount),
        ]),
      );
      expect(protocolHotInspect.status?.pid).toBe(protocolHotPid);
      expect(protocolHotContinuation.reason).not.toBe('daemon_unavailable');
      expect(protocolHotContinuation.reason).not.toBe('unreachable');

      if (verifyCoreOnly) {
        const protocolStop = await measureSmokeStep(
          timings,
          'stop before invite protocol cold delivery',
          async () => runToolsPackJson<WinStopResult>('stop'),
        );
        started = false;
        expect(protocolStop.status).not.toBe('partial');
        expect(protocolStop.remainingPids).toEqual([]);

        await invokeWindowsInviteDeeplink();
        started = true;
        const protocolColdInspect = await measureSmokeStep(
          timings,
          'invite protocol cold delivery',
          async () => waitForHealthyDesktop(),
        );
        expect(protocolColdInspect.status?.state).toBe('running');
        expect(protocolColdInspect.status?.pid).not.toBe(protocolHotPid);
        await assertWindowsInviteProtocolRegistration(install.installDir);
      }

      if (!inspect.desktopIpcUnavailable) {
        // Re-read rather than reusing the value from the seeded start: the core
        // profile stopped the app above and relaunched it through the OS
        // protocol handler, and that cold start carries none of this process's
        // environment — so it is a different daemon, and only it can say what
        // config the surface being asserted on is actually running under.
        // Phase 2 — the completed user. The seed must have been confirmed before
        // this point; the core auth-first profile may legitimately stop at the
        // cloud sign-in landing, while the full profile still needs Home.
        // Either way, a cold launch that lost the seed fails first.
        if (seededOnboardingCompleted !== true) {
          throw new Error('reached the completed-user app-shell check without a confirmed seeded onboarding state');
        }
        const completedUser = await measureSmokeStep(timings, 'ensure completed-user app shell', async () =>
          runPackagedAppShellPhase({
            coreProfile: verifyCoreOnly,
            describeLast: formatUnknown,
            observe: observePackagedAppShell,
            readOnboardingConfig: readPackagedOnboardingConfig,
            scenario: 'completed-user',
          }),
        );
        onboardingCompleted = completedUser.onboardingCompleted;
        appShell = completedUser.appShell;
        if (!verifyCoreOnly) expect(appShell).toBe('home');

        if (verifyUpgradePersistence) {
          const seedInspect = await measureSmokeStep(timings, 'seed pre-update persistence project', async () =>
            runToolsPackJson<WinInspectResult>('inspect', ['--expr', upgradePersistenceSeedExpression]),
          );
          upgradePersistence = assertUpgradePersistenceSeed(seedInspect.eval?.value);
        }

        await mkdir(dirname(preUpdateScreenshotPath), { recursive: true });
        const preUpdateScreenshot = await measureSmokeStep(timings, 'inspect screenshot before update', async () =>
          runToolsPackJson<WinInspectResult>('inspect', ['--path', preUpdateScreenshotPath]),
        );
        expect(preUpdateScreenshot.screenshot?.path).toBe(preUpdateScreenshotPath);
        expect(await fileSizeBytes(preUpdateScreenshotPath)).toBeGreaterThan(0);
        await report.report.save('screenshots/open-design-win-before-update.png', await readFile(preUpdateScreenshotPath));
      } else if (verifyUpgradePersistence) {
        throw new Error('upgrade persistence validation requires desktop IPC eval support');
      }

      if (verifyReinstallWhileRunning && verifyCoreOnly) {
        reinstall = await measureSmokeStep(timings, 'direct reinstall while running', async () =>
          runDirectInstaller(install.installerPath, install.installDir),
        );
        started = false;
        expect(reinstall.code).toBe(0);
        assertWorkingWinInstallerOverwriteLog(reinstall.nsisLogTail);
        expect(reinstall.nsisLogTail.join('\n')).toContain('running instances detected before silent install');
        expect(reinstall.nsisLogTail.join('\n')).toMatch(/running instances close via (?:pwsh|powershell)\.exe exit=0/);

        start = await measureSmokeStep(timings, 'restart after direct reinstall', async () =>
          runToolsPackJson<WinStartResult>('start'),
        );
        started = true;
        expect(start.namespace).toBe(namespace);
        expect(start.source).toBe('installed');
        expectPathInside(start.executablePath, install.installDir);

        const postReinstallInspect = await measureSmokeStep(timings, 'wait healthy inspect after reinstall', async () =>
          waitForHealthyDesktop(),
        );
        expect(postReinstallInspect.status?.state).toBe('running');
        expectWindowsPackagedAppUrl(postReinstallInspect.status?.url);
      }

      if (!inspect.desktopIpcUnavailable) {
        await mkdir(dirname(screenshotPath), { recursive: true });
        const screenshot = await measureSmokeStep(timings, 'inspect screenshot', async () =>
          runToolsPackJson<WinInspectResult>('inspect', ['--path', screenshotPath]),
        );
        expect(screenshot.screenshot?.path).toBe(screenshotPath);
        expect(await fileSizeBytes(screenshotPath)).toBeGreaterThan(0);
        await report.saveScreenshot(screenshotPath);
      }

      if (!verifyCoreOnly) {
        logs = await measureSmokeStep(timings, 'logs', async () => runToolsPackJson<LogsResult>('logs'));
        assertLogPathsAndContent(logs);

        stop = await measureSmokeStep(timings, 'stop', async () => runToolsPackJson<WinStopResult>('stop'));
        started = false;
        expect(stop.namespace).toBe(namespace);
        expect(stop.status).not.toBe('partial');
        expect(stop.remainingPids).toEqual([]);
      }

      const uninstall = await measureSmokeStep(timings, 'uninstall remove data', async () =>
        runToolsPackJson<WinUninstallResult>('uninstall', ['--remove-product-user-data']),
      );
      installed = false;
      started = false;
      expect(uninstall.namespace).toBe(namespace);
      expect(uninstall.residueObservation?.managedProcessPids ?? []).toEqual([]);
      expect(uninstall.residueObservation?.productNamespaceRootExists).toBe(false);
      expect(uninstall.residueObservation?.registryResidues ?? []).toEqual([]);
      expect(uninstall.residueObservation?.installedExeExists).toBe(false);
      expect(uninstall.residueObservation?.uninstallerExists).toBe(false);
      expect(uninstall.residueObservation?.startMenuShortcutExists).toBe(false);
      expect(uninstall.residueObservation?.userDesktopShortcutExists).toBe(false);
      await assertWindowsInviteProtocolRemoved();
      await report.saveSummary({
        appShell,
        onboarding: {
          afterSeed: seededOnboardingCompleted,
          atAppShell: onboardingCompleted,
          firstRunAppShell,
        },
        health: value,
        install: {
          desktopShortcutExists: install.desktopShortcutExists,
          installDir: install.installDir,
          installPayload: install.installPayload,
          installerPath: install.installerPath,
          lifecycleTimings: install.lifecycleTimings,
          registryEntryCount: install.registryEntries.length,
          startMenuShortcutExists: install.startMenuShortcutExists,
          timingPath: install.timingPath,
          uninstallerPath: install.uninstallerPath,
        },
        installTiming,
        logs: 'skipped' in logs ? logs : summarizeLogs(logs),
        namespace,
        pty,
        reinstall,
        screenshot: inspect.desktopIpcUnavailable ? null : report.screenshotRelpath,
        screenshots: inspect.desktopIpcUnavailable
          ? { afterUpdate: null, beforeUpdate: null }
          : {
              afterUpdate: report.screenshotRelpath,
              beforeUpdate: 'screenshots/open-design-win-before-update.png',
            },
        start: {
          executablePath: start.executablePath,
          logPath: start.logPath,
          pid: start.pid,
          source: start.source,
          status: start.status,
        },
        stop,
        timings,
        uninstall,
        upgradePersistence,
      });
      printLifecycleTimings('install lifecycle timings', install.lifecycleTimings);
      printLifecycleTimings('uninstall lifecycle timings', uninstall.lifecycleTimings);
      passed = true;
    } finally {
      if (!passed) {
        await printPackagedLogs().catch((error: unknown) => {
          console.error('failed to read packaged windows logs after failure', error);
        });
      }

      if (started) {
        await runToolsPackJson<WinStopResult>('stop').catch((error: unknown) => {
          console.error('failed to stop packaged windows app during cleanup', error);
        });
        started = false;
      }

      if (installed) {
        await runToolsPackJson<WinUninstallResult>('uninstall', ['--remove-product-user-data']).catch((error: unknown) => {
          console.error('failed to uninstall packaged windows app during cleanup', error);
        });
        installed = false;
      }

      printSmokeTimings(timings);
    }
  }, 720_000);
});

winOnboardingDescribe('packaged windows onboarding AMR smoke', () => {
  let installed = false;
  let started = false;

  test('[P0] @electron-smoke starts a fresh packaged Windows app on the Cloud identity gate', async () => {
    const report = await createPackagedSmokeReport('win');
    const timings: SmokeTiming[] = [];
    let install: WinInstallResult | null = null;
    let installedNamespaceRoot: string | null = null;
    let passed = false;
    try {
      await measureSmokeStep(timings, 'pre-clean uninstall', async () => {
        await runToolsPackJson<WinUninstallResult>('uninstall', ['--remove-product-user-data']).catch(() => null);
      });

      install = await measureSmokeStep(timings, 'install', async () => runToolsPackJson<WinInstallResult>('install'));
      installed = true;
      expect(install.namespace).toBe(namespace);
      expectPathInside(install.installDir, join(runtimeNamespaceRoot, 'install'));
      installedNamespaceRoot = runtimeNamespaceRoot;
      await resetPackagedRuntimeDataRoot();

      const start = await measureSmokeStep(timings, 'start fresh onboarding', async () => runToolsPackJson<WinStartResult>('start'));
      started = true;
      expect(start.namespace).toBe(namespace);
      expect(start.source).toBe('installed');
      expectPathInside(start.executablePath, install.installDir);

      const inspect = await measureSmokeStep(timings, 'wait healthy inspect eval', async () => waitForHealthyDesktop());
      expect(inspect.status?.state).toBe('running');
      // A fresh install boots at `od://app/` and the SPA immediately redirects to the dedicated
      // onboarding route (`od://app/onboarding`, since the #4513 cloud sign-in redesign). Whether
      // the desktop is reported healthy just before or just after that redirect is a race, so the
      // healthy URL/href may be either — match the prefix leniently exactly as the mac smoke and
      // the onboarding-landing assertion below do, instead of pinning the bare root (which flaked
      // ~3 of 4 nightly Windows builds when the redirect won the race).
      expect(inspect.status?.url).toMatch(/^(od:\/\/app\/|http:\/\/127\.0\.0\.1:\d+\/)/);
      const health = assertHealthEvalValue(inspect.eval?.value);
      expect(health.href).toMatch(/^(od:\/\/app\/|http:\/\/127\.0\.0\.1:\d+\/)/);
      expect(health.status).toBe(200);
      expect(health.health.ok).toBe(true);

      const initial = await waitForPackagedOnboarding((snapshot) =>
        snapshot.onboardingVisible && snapshot.cloudSignInVisible,
        'fresh packaged Windows onboarding Cloud identity gate',
      );
      // Onboarding lives on a dedicated route since the #4513 cloud sign-in
      // redesign, so the href is `od://app/onboarding` (packaged) — not the
      // bare app root. Match the prefix the same lenient way the mac smoke
      // does instead of pinning the exact root path. Before the user-data
      // reset fix the app booted to Home and never reached this line, which
      // is why the stale exact-match assertion went unnoticed.
      expect(initial.href).toMatch(/^(od:\/\/app\/|http:\/\/127\.0\.0\.1:\d+\/)/);
      expect(initial.cloudSignInVisible).toBe(true);

      const onboardingScreenshotPath = join(toolsPackDir, 'screenshots', `${namespace}-onboarding.png`);
      await mkdir(dirname(onboardingScreenshotPath), { recursive: true });
      const screenshot = await runToolsPackJson<WinInspectResult>('inspect', ['--path', onboardingScreenshotPath]);
      expect(screenshot.screenshot?.path).toBe(onboardingScreenshotPath);
      expect(await fileSizeBytes(onboardingScreenshotPath)).toBeGreaterThan(0);
      await report.report.save('screenshots/open-design-win-onboarding-smoke.png', await readFile(onboardingScreenshotPath));
      await report.report.json('onboarding-summary.json', {
        health,
        initial,
        namespace,
        screenshot: 'screenshots/open-design-win-onboarding-smoke.png',
        start: {
          executablePath: start.executablePath,
          logPath: start.logPath,
          pid: start.pid,
          source: start.source,
          status: start.status,
        },
        timings,
      });

      const stop = await measureSmokeStep(timings, 'stop', async () => runToolsPackJson<WinStopResult>('stop'));
      started = false;
      expect(stop.namespace).toBe(namespace);
      expect(stop.status).not.toBe('partial');

      const uninstall = await measureSmokeStep(timings, 'uninstall remove data', async () =>
        runToolsPackJson<WinUninstallResult>('uninstall', ['--remove-product-user-data']),
      );
      installed = false;
      expect(uninstall.namespace).toBe(namespace);
      expect(uninstall.residueObservation?.productNamespaceRootExists).toBe(false);
      passed = true;
    } finally {
      if (!passed) {
        await printPackagedLogs().catch((error: unknown) => {
          console.error('failed to read packaged windows onboarding logs after failure', error);
        });
      }

      if (started) {
        await runToolsPackJson<WinStopResult>('stop').catch((error: unknown) => {
          console.error('failed to stop packaged windows onboarding app during cleanup', error);
        });
        started = false;
      }

      if (installed) {
        await runToolsPackJson<WinUninstallResult>('uninstall', ['--remove-product-user-data']).catch((error: unknown) => {
          console.error('failed to uninstall packaged windows onboarding app during cleanup', error);
        });
        installed = false;
      }

      if (installedNamespaceRoot != null) {
        await resetPackagedRuntimeNamespaceRoot(installedNamespaceRoot).catch((error: unknown) => {
          console.error('failed to reset packaged windows onboarding runtime data during cleanup', error);
        });
      }
      printSmokeTimings(timings);
    }
  }, 720_000);
});

async function measureSmokeStep<T>(timings: SmokeTiming[], step: string, run: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  try {
    return await run();
  } finally {
    timings.push({ durationMs: Date.now() - startedAt, step });
  }
}

function printSmokeTimings(timings: SmokeTiming[]): void {
  const totalMs = timings.reduce((sum, timing) => sum + timing.durationMs, 0);
  console.info(
    [
      '[windows smoke timings]',
      ...timings.map((timing) => `${timing.step}: ${Math.round(timing.durationMs / 100) / 10}s`),
      `measured total: ${Math.round(totalMs / 100) / 10}s`,
    ].join('\n'),
  );
}

function printLifecycleTimings(title: string, timings: SmokeTiming[] | undefined): void {
  if (timings == null || timings.length === 0) return;
  console.info(
    [
      `[windows ${title}]`,
      ...timings.map((timing) => `${timing.step}: ${Math.round(timing.durationMs / 100) / 10}s`),
    ].join('\n'),
  );
}

async function runToolsPackJson<T>(action: string, extraArgs: string[] = []): Promise<T> {
  return runToolsPackJsonForVersion(action, releaseVersion, extraArgs);
}

async function runToolsPackJsonForVersion<T>(
  action: string,
  appVersion: string | null | undefined,
  extraArgs: string[] = [],
): Promise<T> {
  const args = [
    toolsPackBin,
    'win',
    action,
    '--dir',
    toolsPackDir,
    '--namespace',
    namespace,
    ...releaseAppVersionArgs(appVersion),
    '--json',
    ...extraArgs,
  ];
  const result = await execFileAsync(process.execPath, args, {
    cwd: workspaceRoot,
    env: process.env,
    maxBuffer: 20 * 1024 * 1024,
  }).catch((error: unknown) => {
    if (isExecError(error)) {
      throw new Error(
        [
          `tools-pack win ${action} failed`,
          `message:\n${error.message}`,
          `stdout:\n${error.stdout}`,
          `stderr:\n${error.stderr}`,
        ].join('\n'),
      );
    }
    throw error;
  });

  try {
    return JSON.parse(result.stdout) as T;
  } catch (error) {
    throw new Error(`tools-pack win ${action} did not print JSON: ${String(error)}\n${result.stdout}`);
  }
}

function assertWorkingWinInstallerOverwriteLog(lines: string[]): void {
  // #6008 deliberately restored this working replace flow after the
  // transactional installer failed fresh installs. Keep the full release
  // smoke aligned with the generated installer until a transactional redesign
  // lands together with real installer coverage.
  expect(missingWorkingWinInstallerOverwriteMarkers(lines)).toEqual([]);
}

async function runDirectInstaller(
  installerPath: string,
  installDir: string,
  nsisLogPath = join(outputNamespaceRoot, 'logs', 'nsis.log'),
): Promise<DirectInstallerResult> {
  const previousLogLines = await readNsisLogLines(nsisLogPath);
  const command =
    process.platform === 'win32'
      ? execFileAsync(
          'powershell.exe',
          [
            '-NoLogo',
            '-NoProfile',
            '-ExecutionPolicy',
            'Bypass',
            '-Command',
            "& { $process = Start-Process -FilePath $env:OD_TEST_INSTALLER_PATH -ArgumentList '/S', $env:OD_TEST_INSTALL_DIR_ARG -Wait -PassThru; exit $process.ExitCode }",
          ],
          {
            cwd: dirname(installerPath),
            env: {
              ...process.env,
              OD_TEST_INSTALL_DIR_ARG: `/D=${installDir}`,
              OD_TEST_INSTALLER_PATH: installerPath,
            },
            maxBuffer: 20 * 1024 * 1024,
          },
        )
      : execFileAsync(installerPath, ['/S', `/D=${installDir}`], {
          cwd: dirname(installerPath),
          env: process.env,
          maxBuffer: 20 * 1024 * 1024,
        });
  const error = await command.then(
    () => null,
    (caught: unknown) => caught,
  );
  const code = isExecError(error) ? Number(error.code) : error == null ? 0 : null;
  return {
    code,
    nsisLogTail: (await readNsisLogLines(nsisLogPath)).slice(previousLogLines.length),
  };
}

async function readNsisLogLines(nsisLogPath = join(outputNamespaceRoot, 'logs', 'nsis.log')): Promise<string[]> {
  const raw = await readFile(nsisLogPath, 'utf8').catch(() => '');
  return raw.split(/\r?\n/).filter((line) => line.length > 0);
}

async function waitForHealthyDesktop(): Promise<WinInspectResult> {
  const timeoutMs = 90_000;
  const startedAt = Date.now();
  let lastResult: unknown = null;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const statusInspect = await runToolsPackJson<WinInspectResult>('inspect');
      lastResult = { inspect: statusInspect, step: 'status' };
      const fallback = await maybeCoreHealthFallback(statusInspect);
      if (fallback != null) return fallback;
      if (statusInspect.status?.state !== 'running') {
        await delay(1000);
        continue;
      }

      const readinessInspect = await runToolsPackJson<WinInspectResult>('inspect', ['--expr', readinessExpression]);
      lastResult = { inspect: readinessInspect, step: 'readiness' };
      if (readinessInspect.eval?.ok !== true) {
        await delay(1000);
        continue;
      }

      const inspect = await runToolsPackJson<WinInspectResult>('inspect', ['--expr', healthExpression]);
      lastResult = { inspect, step: 'health' };
      if (inspect.eval?.ok === true) {
        const value = asHealthEvalValue(inspect.eval.value);
        if (value?.status === 200 && value.health.ok === true && typeof value.health.version === 'string') return inspect;
      }
    } catch (error) {
      lastResult = error;
    }
    await delay(1000);
  }

  throw new Error(`packaged windows runtime did not become healthy: ${formatUnknown(lastResult)}`);
}

async function maybeCoreHealthFallback(inspect: WinInspectResult): Promise<WinInspectResult | null> {
  if (!verifyCoreOnly) return null;
  if (inspect.status != null) return null;
  if (inspect.statusError == null || !inspect.statusError.includes('IPC request timed out')) return null;
  if (inspect.daemonStatus?.state !== 'running' || inspect.daemonStatus.url == null) return null;
  if (inspect.webStatus?.state !== 'running' || inspect.webStatus.url == null) return null;

  const health = await fetchPackagedHealth(inspect.daemonStatus.url);
  if (health.status !== 200 || health.health.ok !== true) return null;
  return {
    ...inspect,
    desktopIpcUnavailable: true,
    eval: {
      ok: true,
      value: health,
    },
    status: {
      ...(inspect.daemonStatus.pid == null ? {} : { pid: inspect.daemonStatus.pid }),
      state: 'running',
      title: null,
      url: inspect.webStatus.url,
      windowVisible: false,
    },
  };
}

async function fetchPackagedHealth(daemonUrl: string): Promise<HealthEvalValue> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);
  try {
    const response = await fetch(new URL('/api/health', daemonUrl), { signal: controller.signal });
    return {
      health: await response.json() as HealthEvalValue['health'],
      href: daemonUrl,
      status: response.status,
      title: 'Open Design Beta',
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * What the running daemon reports for `onboardingCompleted`.
 *
 * This is the seed's actual postcondition. `seedPackagedOnboardingComplete`
 * writes `<runtimeNamespaceRoot>/data/app-config.json`, and on a
 * `tools-pack win start` the daemon resolves the same path — `tools-pack`
 * rewrites the launch config's `namespaceBaseRoot` to the tools-pack runtime
 * root (tools/pack/src/win/lifecycle.ts) and `apps/packaged/src/paths.ts`
 * derives `join(namespaceBaseRoot, namespace, 'data')` from it. So a healthy
 * seeded start MUST report true, and anything else is a real data-root
 * regression rather than a test-fixture detail.
 */
async function readPackagedOnboardingConfig(): Promise<unknown> {
  const inspect = await runToolsPackJson<WinInspectResult>('inspect', [
    '--expr',
    packagedOnboardingConfigExpression,
  ]);
  if (inspect.eval?.ok !== true) {
    throw new PackagedOnboardingConfigError(`the renderer could not evaluate the probe: ${formatUnknown(inspect)}`);
  }
  // Returns the raw probe outcome. Interpretation belongs to the scenario, not
  // to the reader: an absent key means different things to a first run and to a
  // run that seeded completion.
  return inspect.eval.value;
}

/**
 * One reading of the packaged renderer's app shell.
 *
 * Throws on an eval that did not run, so the settle loop records the whole
 * inspect payload as the failure cause rather than an empty observation.
 */
async function observePackagedAppShell(): Promise<unknown> {
  const inspect = await runToolsPackJson<WinInspectResult>('inspect', ['--expr', packagedAppShellExpression]);
  if (inspect.eval?.ok !== true) {
    throw new Error(`packaged windows renderer could not evaluate the app-shell probe: ${formatUnknown(inspect)}`);
  }
  return inspect.eval.value;
}

async function waitForPackagedOnboarding(
  predicate: (value: PackagedOnboardingEvalValue) => boolean,
  label: string,
  timeoutMs = 90_000,
): Promise<PackagedOnboardingEvalValue> {
  const startedAt = Date.now();
  let lastResult: unknown = null;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const inspect = await runToolsPackJson<WinInspectResult>('inspect', ['--expr', packagedOnboardingExpression]);
      lastResult = inspect;
      if (inspect.status?.state === 'running' && inspect.eval?.ok === true) {
        const value = asPackagedOnboardingEvalValue(inspect.eval.value);
        if (value != null && predicate(value)) return value;
      }
    } catch (error) {
      lastResult = error;
    }
    await delay(1000);
  }

  throw new Error(`${label}: packaged Windows onboarding timed out: ${formatUnknown(lastResult)}`);
}

function assertLogPathsAndContent(result: LogsResult): void {
  expect(result.namespace).toBe(namespace);
  for (const app of ['desktop', 'web', 'daemon']) {
    const entry = result.logs[app];
    if (entry == null) {
      throw new Error(`expected ${app} log entry`);
    }
    expectPathInside(entry.logPath, join(runtimeNamespaceRoot, 'logs', app));
  }

  const combined = Object.values(result.logs)
    .flatMap((entry) => entry.lines)
    .join('\n');
  const unexpectedStandaloneExits = combined
    .split(/\r?\n/)
    .filter((line) => /standalone Next\.js server exited/i.test(line) && !/signal=SIGTERM/i.test(line));
  expect(combined).not.toMatch(/ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING/);
  expect(combined).not.toMatch(/packaged runtime failed/i);
  expect(unexpectedStandaloneExits).toEqual([]);
}

function summarizeLogs(result: LogsResult): Record<string, { lineCount: number; logPath: string }> {
  return Object.fromEntries(
    Object.entries(result.logs).map(([app, entry]) => [
      app,
      {
        lineCount: entry.lines.length,
        logPath: entry.logPath,
      },
    ]),
  );
}

async function printPackagedLogs(): Promise<void> {
  const result = await runToolsPackJson<LogsResult>('logs');
  for (const [app, entry] of Object.entries(result.logs)) {
    console.error(`[${app}] ${entry.logPath}`);
    console.error(entry.lines.join('\n') || '(no log lines)');
  }
  await printLauncherRuntimeSnapshot();
}

async function printLauncherRuntimeSnapshot(): Promise<void> {
  const runtimePath = join(launcherNamespaceRoot, 'runtime.json');
  const content = await readFile(runtimePath, 'utf8').catch(() => null);
  console.error(`[launcher-runtime] ${runtimePath}`);
  console.error(content?.trim() ?? '(missing)');
}

function assertUpgradePersistenceSeed(value: unknown): UpgradePersistenceSeed {
  if (
    !isRecord(value) ||
    typeof value.createdOk !== 'boolean' ||
    typeof value.createdStatus !== 'number' ||
    typeof value.projectId !== 'string' ||
    typeof value.writtenOk !== 'boolean' ||
    (value.writtenStatus != null && typeof value.writtenStatus !== 'number')
  ) {
    throw new Error(`unexpected upgrade persistence seed value: ${formatUnknown(value)}`);
  }
  expect(value.createdOk).toBe(true);
  expect(value.writtenOk).toBe(true);
  return value as UpgradePersistenceSeed;
}

function assertHealthEvalValue(value: unknown): HealthEvalValue {
  const normalized = asHealthEvalValue(value);
  if (normalized == null) {
    throw new Error(`unexpected health eval value: ${formatUnknown(value)}`);
  }
  return normalized;
}

function asHealthEvalValue(value: unknown): HealthEvalValue | null {
  if (!isRecord(value)) return null;
  if (typeof value.href !== 'string' || typeof value.status !== 'number' || typeof value.title !== 'string') return null;
  if (!isRecord(value.health)) return null;
  return value as HealthEvalValue;
}

function asPackagedOnboardingEvalValue(value: unknown): PackagedOnboardingEvalValue | null {
  if (!isRecord(value)) return null;
  if (typeof value.cloudSignInVisible !== 'boolean') return null;
  if (typeof value.href !== 'string') return null;
  if (typeof value.onboardingVisible !== 'boolean') return null;
  if (value.text != null && typeof value.text !== 'string') return null;
  if (typeof value.title !== 'string') return null;
  return value as PackagedOnboardingEvalValue;
}

function expectPathInside(filePath: string, expectedRoot: string): void {
  const normalizedPath = resolve(filePath);
  const normalizedRoot = resolve(expectedRoot);
  expect(
    normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}${sep}`),
    `${normalizedPath} should be inside ${normalizedRoot}`,
  ).toBe(true);
}

function expectWindowsPackagedAppUrl(value: string | null | undefined): void {
  expect(value).toEqual(expect.stringMatching(/^od:\/\/app\/$/));
}

function expectWindowsPackagedRouteUrl(value: string | null | undefined): void {
  expect(packagedAppRouteUrl(value), `${String(value)} should be an od://app/* packaged renderer URL`).toBe(true);
}

function expectWindowsFallbackWebUrl(value: string | null | undefined): void {
  expect(value).toEqual(expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/?$/));
}

function expectWindowsDaemonUrl(value: string | null | undefined): void {
  expect(value).toEqual(expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/?$/));
}

async function assertWindowsInviteProtocolRegistration(installDir: string): Promise<void> {
  const { stdout } = await execFileAsync('reg.exe', [
    'query',
    'HKCU\\Software\\Classes\\opendesign\\shell\\open\\command',
    '/ve',
  ]);
  const normalized = stdout.toLowerCase();
  expect(normalized).toContain(installDir.toLowerCase());
  expect(normalized).toContain('%1');
  expect(normalized).not.toContain('\\versions\\');
}

async function invokeWindowsInviteDeeplink(): Promise<void> {
  const escaped = packagedInviteDeeplink.replaceAll("'", "''");
  await execFileAsync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `Start-Process -FilePath '${escaped}'`,
  ]);
}

type InviteContinuationResult = {
  ok: boolean;
  reason?: string;
  status?: number;
};

async function countInviteContinuationResults(): Promise<number> {
  return (await readInviteContinuationResults()).length;
}

async function waitForInviteContinuationResult(
  priorCount: number,
  timeoutMs = 30_000,
): Promise<InviteContinuationResult> {
  const startedAt = Date.now();
  let lastCount = priorCount;
  while (Date.now() - startedAt < timeoutMs) {
    const results = await readInviteContinuationResults();
    lastCount = results.length;
    if (results.length > priorCount) return results.at(-1)!;
    await delay(250);
  }
  throw new Error(
    `invite deeplink did not produce a continuation result within ${timeoutMs}ms (before=${priorCount}, after=${lastCount})`,
  );
}

async function readInviteContinuationResults(): Promise<InviteContinuationResult[]> {
  const logPath = join(runtimeNamespaceRoot, 'logs', 'desktop', 'latest.log');
  const content = await readFile(logPath, 'utf8').catch(() => '');
  const results: InviteContinuationResult[] = [];
  for (const line of content.split(/\r?\n/u)) {
    if (line.trim().length === 0) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line) as unknown;
    } catch {
      continue;
    }
    if (!isRecord(entry) || entry.message !== 'console.info' || !isRecord(entry.meta)) continue;
    const args = entry.meta.args;
    if (!Array.isArray(args) || args[0] !== '[open-design desktop] invite deeplink continuation completed') continue;
    const outcome = args[1];
    if (!isRecord(outcome) || typeof outcome.ok !== 'boolean') continue;
    results.push({
      ok: outcome.ok,
      ...(typeof outcome.reason === 'string' ? { reason: outcome.reason } : {}),
      ...(typeof outcome.status === 'number' ? { status: outcome.status } : {}),
    });
  }
  return results;
}

async function assertWindowsInviteProtocolRemoved(): Promise<void> {
  await expect(
    execFileAsync('reg.exe', [
      'query',
      'HKCU\\Software\\Classes\\opendesign',
    ]),
  ).rejects.toMatchObject({ code: 1 });
}

async function fileSizeBytes(filePath: string): Promise<number> {
  return (await stat(filePath)).size;
}

async function readTiming(filePath: string): Promise<TimingResult> {
  return JSON.parse(await readFile(filePath, 'utf8')) as TimingResult;
}

async function seedPackagedOnboardingComplete(): Promise<void> {
  // Pre-mark first-run onboarding as complete so the packaged app boots
  // straight to the home shell. Since #4389 the Connect onboarding step is
  // required and has no Skip affordance, so the only way past it on a fresh
  // install is an `onboardingCompleted: true` config the daemon reads on boot.
  //
  // Write to the SAME data dir the running daemon actually reads —
  // `<runtimeNamespaceRoot>/data` — not a path derived from the installed
  // app's baked config. `tools-pack win start` rewrites the launch config's
  // `namespaceBaseRoot` to the tools-pack runtime root (see
  // writeInstalledLaunchPackagedConfig in tools/pack/src/win/lifecycle.ts) and
  // hands it to the runtime via OD_PACKAGED_CONFIG_PATH, so the live daemon's
  // RUNTIME_DATA_DIR is always under runtimeNamespaceRoot regardless of what
  // the installer baked. Deriving the path from the installed manifest landed
  // the seed elsewhere (the AppData fallback), so the daemon never saw it and
  // the app stuck on onboarding once the Skip button was removed. This mirrors
  // the macOS smoke's seed, which already writes under runtimeNamespaceRoot.
  const configPath = join(runtimeNamespaceRoot, 'data', 'app-config.json');
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify({ onboardingCompleted: true }, null, 2)}\n`, 'utf8');
}

async function resetPackagedRuntimeNamespaceRoot(namespaceRoot: string): Promise<void> {
  await rm(namespaceRoot, { force: true, recursive: true });
}

async function resetPackagedUpdaterNamespaceRoots(): Promise<void> {
  await Promise.all([
    resetPackagedRuntimeNamespaceRoot(runtimeNamespaceRoot),
    resetPackagedRuntimeNamespaceRoot(launcherNamespaceRoot),
  ]);
}

// Reset every per-namespace runtime state directory before a fresh-onboarding
// start, EXCEPT the installed app payload (`install/`). On Windows the install
// lives UNDER the runtime namespace root, so — unlike the macOS smoke, which
// installs to /Applications and can `rm` the whole namespace root
// (resetPackagedMacRuntimeData) — we must preserve `install/` while wiping
// everything else.
//
// Wiping only `data/` is not enough. The packaged web frontend persists its
// config — including `onboardingCompleted` — to `localStorage`, which Electron
// stores under the SEPARATE `user-data/` partition, not the daemon's `data/`
// dir (see the `daemonDataRoot` vs `electronUserDataRoot` split logged on
// boot). When `<data>/app-config.json` is absent the daemon OMITS
// `onboardingCompleted`, so `mergeDaemonConfig` keeps the localStorage value;
// a leftover `onboardingCompleted: true` from an earlier run (e.g. the [P2]
// smoke that ran first in this file) then boots the app straight to Home
// instead of onboarding, and this test times out waiting for the cloud
// sign-in landing. Clearing `user-data/` alongside `data/` gives the same
// true-first-run guarantee the mac smoke gets from removing the entire root.
async function resetPackagedRuntimeDataRoot(): Promise<void> {
  // A missing root means the namespace has no runtime state yet — already a
  // fresh first-run, nothing to wipe. Any OTHER readdir failure (permissions,
  // I/O) is a real problem that must surface loudly: swallowing it would turn
  // the reset into a silent no-op and let stale state through, defeating the
  // very guarantee this helper exists to make.
  const entries = await readdir(runtimeNamespaceRoot).catch((error: NodeJS.ErrnoException) => {
    if (error?.code === 'ENOENT') return [] as string[];
    throw error;
  });
  await Promise.all(
    entries
      .filter((entry) => entry !== 'install')
      .map((entry) => rm(join(runtimeNamespaceRoot, entry), { force: true, recursive: true })),
  );
}

function resolveFromWorkspace(filePath: string): string {
  return isAbsolute(filePath) ? filePath : resolve(workspaceRoot, filePath);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value != null && !Array.isArray(value);
}

function isExecError(value: unknown): value is { code?: unknown; message: string; stderr: string; stdout: string } {
  return (
    isRecord(value) &&
    typeof value.message === 'string' &&
    typeof value.stdout === 'string' &&
    typeof value.stderr === 'string'
  );
}

function formatUnknown(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function normalizeOptionalEnv(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized == null || normalized.length === 0 ? null : normalized;
}
