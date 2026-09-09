// Browser-sourcemap strip step for packaged builds.
//
// Why this exists
// ---------------
// `apps/web/next.config.ts` sets `productionBrowserSourceMaps: true`, so
// every `next build` invoked from tools-pack also produces `.js.map` files
// alongside the minified chunks. No `.map` may ever end up inside a shipped
// installer (`.dmg`, `.nsis`, `.AppImage`): sourcemaps publish the original
// TypeScript source to anyone who can read the bundle, which is a security
// & competitive-disclosure problem.
//
// `processWebSourcemaps` removes every `.map` under the browser chunks
// directory. Stripping is a hard security requirement and runs
// unconditionally after the web build, before any packaging step copies the
// web output into the Electron resources.
//
// Scope
// -----
// Only the packaged (mac/win/linux Electron) path is covered here. The OSS
// `od` CLI distribution path serves `apps/web/out/_next/static/chunks/`
// directly and is not currently used by any release artifact.

import { existsSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import type { ToolPackConfig } from "./config/index.js";

function resolveBrowserChunksDir(workspaceRoot: string): string {
  // Both `output: 'standalone'` (mac/win) and the implicit server output
  // (linux) write browser chunks to `.next/static`. Static-export mode
  // (`apps/web/out/_next/static`) is not used by any release artifact.
  return join(workspaceRoot, "apps", "web", ".next", "static");
}

async function findMapFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current == null) break;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      // Directory might not exist on this branch of the tree; skip silently.
      continue;
    }
    for (const entry of entries) {
      const entryPath = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
      } else if (entry.isFile() && entry.name.endsWith(".map")) {
        out.push(entryPath);
      }
    }
  }
  return out;
}

async function deleteMapFiles(dir: string): Promise<number> {
  const maps = await findMapFiles(dir);
  for (const mapPath of maps) {
    await rm(mapPath, { force: true });
  }
  return maps.length;
}

function log(line: string): void {
  process.stderr.write(`[web-sourcemaps] ${line}\n`);
}

export async function processWebSourcemaps(config: ToolPackConfig): Promise<void> {
  const chunksDir = resolveBrowserChunksDir(config.workspaceRoot);
  if (!existsSync(chunksDir)) {
    log(`browser chunks dir not found at ${chunksDir}; skipping`);
    return;
  }

  const initialMaps = await findMapFiles(chunksDir);
  if (initialMaps.length === 0) {
    log(`no .map files under ${chunksDir}; nothing to do`);
    return;
  }
  log(`found ${initialMaps.length} .map file(s) under ${chunksDir}`);

  // Hard requirement: never let a .map slip into the shipped installer. The
  // explicit pass also catches files future tooling we haven't audited yet
  // might add.
  const stripped = await deleteMapFiles(chunksDir);
  log(`stripped ${stripped} .map file(s) before packaging`);
}
