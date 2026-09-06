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
      PRIMARY KEY (repository_project_id, clone_id, kind, portable_id),
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
    CREATE TABLE IF NOT EXISTS project_git_operation_requests (
      actor_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('retry')),
      idempotency_key TEXT NOT NULL,
      request_digest TEXT NOT NULL,
      operation_id TEXT NOT NULL REFERENCES project_git_operations(id),
      created_at INTEGER NOT NULL,
      PRIMARY KEY (actor_id, scope, action, idempotency_key),
      UNIQUE (operation_id)
    );
    CREATE TABLE IF NOT EXISTS project_git_retry_attempts (
      operation_id TEXT PRIMARY KEY REFERENCES project_git_operations(id),
      attempt INTEGER NOT NULL CHECK (attempt >= 1),
      state TEXT NOT NULL CHECK (state IN ('admitted', 'started', 'settled')),
      prior_status TEXT NOT NULL,
      prior_phase TEXT NOT NULL,
      prior_result_json TEXT,
      prior_error_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    INSERT OR IGNORE INTO project_git_retry_attempts
      (operation_id, attempt, state, prior_status, prior_phase, prior_result_json, prior_error_json, created_at, updated_at)
    SELECT request.operation_id, 1,
      CASE WHEN operation.status = 'succeeded'
        OR operation.status = 'waiting' AND (
          operation.phase IN ('conflict', 'auth_required', 'paused', 'pending_push', 'external_git_busy')
          OR operation.phase = 'waiting_idle' AND operation.error_json IS NOT NULL
        ) THEN 'settled' ELSE 'admitted' END,
      operation.status, operation.phase, operation.result_json, operation.error_json,
      request.created_at, request.created_at
    FROM project_git_operation_requests AS request
    JOIN project_git_operations AS operation ON operation.id = request.operation_id
    WHERE request.action = 'retry';
    UPDATE project_git_operations
    SET status = 'queued', phase = 'waiting_idle', error_json = NULL,
      updated_at = MAX(updated_at, (SELECT updated_at FROM project_git_retry_attempts WHERE operation_id = project_git_operations.id))
    WHERE status IN ('failed', 'waiting')
      AND NOT (status = 'waiting' AND (
        phase IN ('conflict', 'auth_required', 'paused', 'pending_push', 'external_git_busy')
        OR phase = 'waiting_idle' AND error_json IS NOT NULL
      ))
      AND id IN (SELECT operation_id FROM project_git_retry_attempts WHERE state IN ('admitted', 'started'));
    CREATE TABLE IF NOT EXISTS project_git_conflict_resolutions (
      conflict_operation_id TEXT PRIMARY KEY REFERENCES project_git_operations(id),
      resolve_operation_id TEXT NOT NULL UNIQUE REFERENCES project_git_operations(id)
    );
    DELETE FROM project_git_conflict_resolutions
      WHERE resolve_operation_id IN (SELECT id FROM project_git_operations WHERE status = 'failed')
        AND EXISTS (
          SELECT 1 FROM project_git_operations AS candidate
          WHERE candidate.kind = 'resolve' AND candidate.status != 'failed'
            AND json_extract(candidate.payload_json, '$.conflictOperationId') = project_git_conflict_resolutions.conflict_operation_id
        );
    INSERT OR IGNORE INTO project_git_conflict_resolutions (conflict_operation_id, resolve_operation_id)
      SELECT conflict_operation_id, id FROM (
        SELECT json_extract(payload_json, '$.conflictOperationId') AS conflict_operation_id, id,
          row_number() OVER (
            PARTITION BY json_extract(payload_json, '$.conflictOperationId')
            ORDER BY CASE WHEN status = 'failed' THEN 1 ELSE 0 END, created_at, id
          ) AS rank
        FROM project_git_operations
        WHERE kind = 'resolve' AND json_type(payload_json, '$.conflictOperationId') = 'text'
      ) WHERE rank = 1;
    CREATE TABLE IF NOT EXISTS project_git_run_terminals (
      run_id TEXT NOT NULL,
      execution_attempt INTEGER NOT NULL CHECK (execution_attempt >= 0),
      project_id TEXT NOT NULL,
      binding_generation INTEGER NOT NULL CHECK (binding_generation >= 1),
      project_revision INTEGER NOT NULL CHECK (project_revision >= 0),
      terminal TEXT NOT NULL CHECK (terminal IN ('succeeded', 'failed', 'canceled')),
      created_at INTEGER NOT NULL,
      PRIMARY KEY (run_id, execution_attempt)
    );
    CREATE TABLE IF NOT EXISTS project_git_preview_consumers (
      preview_operation_id TEXT PRIMARY KEY REFERENCES project_git_operations(id),
      consumer_operation_id TEXT NOT NULL UNIQUE REFERENCES project_git_operations(id)
    );
    CREATE TABLE IF NOT EXISTS project_git_open_remotes (
      operation_id TEXT PRIMARY KEY REFERENCES project_git_operations(id),
      head TEXT,
      object_format TEXT NOT NULL CHECK (object_format IN ('sha1', 'sha256'))
    );
    CREATE TABLE IF NOT EXISTS project_git_preparations (
      operation_id TEXT PRIMARY KEY REFERENCES project_git_operations(id),
      root_json TEXT,
      candidate_json TEXT,
      initialization_json TEXT
    );
    CREATE INDEX IF NOT EXISTS project_git_push_due ON project_git_push_queue(next_attempt_at);
    CREATE TABLE IF NOT EXISTS project_git_portable_records (
      project_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('manifest', 'project', 'conversation', 'message')),
      local_id TEXT NOT NULL,
      record_json TEXT NOT NULL,
      ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
      snapshot_digest TEXT,
      PRIMARY KEY (project_id, kind, local_id)
    );
    CREATE TABLE IF NOT EXISTS project_git_registrations (
      execution_operation_id TEXT PRIMARY KEY,
      user_operation_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      hidden INTEGER NOT NULL CHECK(hidden IN (0, 1)),
      state TEXT NOT NULL CHECK(state IN ('pending', 'complete', 'aborted')),
      intent_json TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS project_git_pending_registration
      ON project_git_registrations(project_id) WHERE state = 'pending';
    `);
    const terminalColumns = db.prepare('PRAGMA table_info(project_git_run_terminals)').all() as {
      name: string;
      pk: number;
    }[];
    if (!terminalColumns.some(column => column.name === 'execution_attempt')) {
      // The first terminal receipt schema keyed only by run_id. A resumed
      // physical execution reuses that id, so preserve every old receipt as
      // attempt zero while widening the key for later attempts.
      db.exec(`
        ALTER TABLE project_git_run_terminals RENAME TO project_git_run_terminals_prior;
        CREATE TABLE project_git_run_terminals (
          run_id TEXT NOT NULL,
          execution_attempt INTEGER NOT NULL CHECK (execution_attempt >= 0),
          project_id TEXT NOT NULL,
          binding_generation INTEGER NOT NULL CHECK (binding_generation >= 1),
          project_revision INTEGER NOT NULL CHECK (project_revision >= 0),
          terminal TEXT NOT NULL CHECK (terminal IN ('succeeded', 'failed', 'canceled')),
          created_at INTEGER NOT NULL,
          PRIMARY KEY (run_id, execution_attempt)
        );
        INSERT INTO project_git_run_terminals
          (run_id, execution_attempt, project_id, binding_generation, project_revision, terminal, created_at)
        SELECT run_id, 0, project_id, binding_generation, project_revision, terminal, created_at
          FROM project_git_run_terminals_prior;
        DROP TABLE project_git_run_terminals_prior;
      `);
    }
    const idColumns = db.prepare('PRAGMA table_info(project_git_id_map)').all() as { name: string; pk: number }[];
    if (idColumns.find(column => column.name === 'kind')?.pk === 0) {
      // Only the mapping table changes. Keep every historical mapping and roll
      // the whole migration back if a new invariant cannot be satisfied.
      db.exec(`
        ALTER TABLE project_git_id_map RENAME TO project_git_id_map_prior;
        CREATE TABLE project_git_id_map (
          repository_project_id TEXT NOT NULL, clone_id TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('project', 'conversation', 'message', 'turn')),
          portable_id TEXT NOT NULL, local_id TEXT NOT NULL,
          PRIMARY KEY (repository_project_id, clone_id, kind, portable_id),
          UNIQUE (repository_project_id, clone_id, kind, local_id));
        INSERT INTO project_git_id_map SELECT repository_project_id, clone_id, kind, portable_id, local_id
          FROM project_git_id_map_prior;
        DROP TABLE project_git_id_map_prior;
      `);
    }
    db.exec(`
      CREATE INDEX IF NOT EXISTS project_git_portable_kind
        ON project_git_id_map(repository_project_id, portable_id, kind);
      CREATE UNIQUE INDEX IF NOT EXISTS project_git_local_record ON project_git_id_map(kind, local_id);
      CREATE UNIQUE INDEX IF NOT EXISTS project_git_record_namespace
        ON project_git_id_map(repository_project_id, clone_id, portable_id) WHERE kind != 'turn';
    `);
    const columns = db.prepare('PRAGMA table_info(project_git_operations)').all() as { name: string }[];
    for (const name of ['records_transition_json', 'protection_json', 'owner_operation_id']) {
      if (!columns.some(column => column.name === name)) {
        db.exec(`ALTER TABLE project_git_operations ADD COLUMN ${name} TEXT`);
      }
    }
    const bindingColumns = db.prepare('PRAGMA table_info(project_git_bindings)').all() as { name: string }[];
    for (const name of ['canonical_root', 'local_branch']) {
      if (!bindingColumns.some(column => column.name === name)) db.exec(`ALTER TABLE project_git_bindings ADD COLUMN ${name} TEXT`);
    }
    db.exec(`UPDATE project_git_bindings SET canonical_root = json_extract(record_json, '$.canonicalRoot'),
      local_branch = COALESCE(json_extract(record_json, '$.localBranch'), branch)
      WHERE canonical_root IS NULL OR local_branch IS NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS project_git_writable_root ON project_git_bindings(canonical_root) WHERE active = 1;
      CREATE UNIQUE INDEX IF NOT EXISTS project_git_writable_local_branch ON project_git_bindings(common_dir, local_branch) WHERE active = 1;`);
  }).immediate();
}
