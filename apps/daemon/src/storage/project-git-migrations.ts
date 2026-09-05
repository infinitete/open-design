import type Database from 'better-sqlite3';

/** Additive, retryable domain schema; existing application records are never imported as history. */
export function migrateProjectGit(db: Database.Database): void {
  db.transaction(() => {
    db.exec(`
    CREATE TABLE IF NOT EXISTS project_git_bindings (
      project_id TEXT PRIMARY KEY,
      common_dir TEXT NOT NULL,
      branch TEXT NOT NULL,
      generation INTEGER NOT NULL CHECK (generation >= 1),
      active INTEGER NOT NULL CHECK (active IN (0, 1)),
      project_revision INTEGER NOT NULL CHECK (project_revision >= 0),
      content_revision INTEGER NOT NULL CHECK (content_revision >= 0),
      exported_content_revision INTEGER NOT NULL CHECK (exported_content_revision >= 0 AND exported_content_revision <= content_revision),
      record_json TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS project_git_writable_branch
      ON project_git_bindings(common_dir, branch) WHERE active = 1;
    CREATE TABLE IF NOT EXISTS project_git_id_map (
      repository_project_id TEXT NOT NULL,
      clone_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('project', 'conversation', 'message', 'turn')),
      portable_id TEXT NOT NULL,
      local_id TEXT NOT NULL,
      PRIMARY KEY (repository_project_id, clone_id, portable_id),
      UNIQUE (repository_project_id, clone_id, kind, local_id)
    );
    CREATE INDEX IF NOT EXISTS project_git_portable_kind
      ON project_git_id_map(repository_project_id, portable_id, kind);
    CREATE UNIQUE INDEX IF NOT EXISTS project_git_local_record
      ON project_git_id_map(kind, local_id);
    CREATE TABLE IF NOT EXISTS project_git_operations (
      id TEXT PRIMARY KEY,
      actor_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      kind TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      request_digest TEXT NOT NULL,
      project_id TEXT,
      basis_json TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL,
      phase TEXT NOT NULL,
      result_json TEXT,
      error_json TEXT,
      journal_phase TEXT,
      phase_completed INTEGER NOT NULL DEFAULT 0,
      recovery_json TEXT,
      completed_project_revision INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (actor_id, scope, kind, idempotency_key)
    );
    CREATE TABLE IF NOT EXISTS project_git_push_queue (
      project_id TEXT PRIMARY KEY,
      binding_generation INTEGER NOT NULL,
      target_oid TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS project_git_push_due ON project_git_push_queue(next_attempt_at);
    `);
    const columns = db.prepare('PRAGMA table_info(project_git_operations)').all() as { name: string }[];
    for (const name of ['records_transition_json', 'protection_json', 'owner_operation_id']) {
      if (!columns.some(column => column.name === name)) {
        db.exec(`ALTER TABLE project_git_operations ADD COLUMN ${name} TEXT`);
      }
    }
  }).immediate();
}
