interface RunHtmlArtifactFile {
  name: string;
}

export interface RunHtmlArtifactReconciliationInput {
  files: readonly RunHtmlArtifactFile[];
  runStartTimeMs: number;
  stat(name: string): Promise<{ mtimeMs: number }>;
  isRunTouchedProjectFile(mtimeMs: number, runStartTimeMs: number): boolean;
  reconcile(name: string): Promise<unknown>;
}

/** Best-effort local close work; the returned promise is the terminal publication barrier. */
export async function reconcileRunHtmlArtifactManifests(
  input: RunHtmlArtifactReconciliationInput,
): Promise<void> {
  for (const file of input.files) {
    const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
    if (ext !== '.html' && ext !== '.htm') continue;
    try {
      const info = await input.stat(file.name);
      if (!input.isRunTouchedProjectFile(info.mtimeMs, input.runStartTimeMs)) continue;
      await input.reconcile(file.name);
    } catch { /* Per-file reconciliation is best-effort. */ }
  }
}
