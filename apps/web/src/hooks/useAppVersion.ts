import { useEffect, useState } from 'react';

import { fetchAppVersionInfo } from '../providers/registry';

export const APP_VERSION_PLACEHOLDER = '0.0.0';

let runtimeAppVersion: string | null = null;
let runtimeAppVersionPromise: Promise<string | null> | null = null;

async function loadRuntimeAppVersion(): Promise<string | null> {
  if (runtimeAppVersion) return runtimeAppVersion;
  if (!runtimeAppVersionPromise) {
    runtimeAppVersionPromise = fetchAppVersionInfo()
      .then((info) => {
        const version = info?.version?.trim();
        if (!version) return null;
        runtimeAppVersion = version;
        return version;
      })
      .catch(() => null)
      .finally(() => {
        if (!runtimeAppVersion) runtimeAppVersionPromise = null;
      });
  }
  return runtimeAppVersionPromise;
}

export function isResolvedAppVersion(version: string | null | undefined): boolean {
  if (version == null) return false;
  const trimmed = version.trim();
  return trimmed.length > 0 && trimmed !== APP_VERSION_PLACEHOLDER;
}

export function useAppVersion(): string {
  const [version, setVersion] = useState(APP_VERSION_PLACEHOLDER);
  useEffect(() => {
    let cancelled = false;
    void loadRuntimeAppVersion().then((next) => {
      if (!cancelled && next) setVersion(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return version;
}
