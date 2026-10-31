/**
 * Migrações versionadas do banco local. Nunca edite uma migração já publicada:
 * adicione uma nova versão no fim da lista.
 */
export const MIGRATIONS: { version: number; name: string; sql: string }[] = [
  {
    version: 1,
    name: 'base',
    sql: `
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);

CREATE TABLE projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT, description TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE conversations (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  summary TEXT, summarized_upto INTEGER NOT NULL DEFAULT 0,
  origin TEXT NOT NULL DEFAULT 'local', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL, role TEXT NOT NULL CHECK (role IN ('system','user','assistant','tool')),
  content TEXT NOT NULL, tool_calls TEXT, tool_name TEXT, metrics TEXT, origin TEXT NOT NULL DEFAULT 'local',
  created_at TEXT NOT NULL
);
CREATE INDEX messages_conv ON messages(conversation_id, seq);
CREATE VIRTUAL TABLE messages_fts USING fts5(content, content='messages', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2');
CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content); END;
CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content); END;

CREATE TABLE tasks (
  id TEXT PRIMARY KEY, conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  origin TEXT NOT NULL, goal TEXT NOT NULL, state TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT '[]', success_criteria TEXT NOT NULL DEFAULT '[]',
  result TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX tasks_state ON tasks(state, updated_at);

CREATE TABLE task_steps (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, idx INTEGER NOT NULL,
  agent TEXT NOT NULL, description TEXT NOT NULL, tool TEXT, args TEXT, state TEXT NOT NULL,
  result TEXT, error TEXT, verification TEXT, started_at TEXT, finished_at TEXT
);
CREATE INDEX task_steps_task ON task_steps(task_id, idx);

CREATE TABLE tool_calls (
  id TEXT PRIMARY KEY, task_id TEXT, step_id TEXT, conversation_id TEXT, tool TEXT NOT NULL,
  args TEXT NOT NULL, origin TEXT NOT NULL, ok INTEGER, result TEXT, error TEXT, evidence TEXT, undo TEXT,
  verification TEXT, duration_ms INTEGER, created_at TEXT NOT NULL
);
CREATE INDEX tool_calls_task ON tool_calls(task_id);
CREATE INDEX tool_calls_tool ON tool_calls(tool, created_at);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY, task_id TEXT, step_id TEXT, tool TEXT NOT NULL, args TEXT NOT NULL, risk TEXT NOT NULL,
  reason TEXT NOT NULL, origin TEXT NOT NULL, state TEXT NOT NULL, decided_by TEXT,
  created_at TEXT NOT NULL, decided_at TEXT, expires_at TEXT NOT NULL
);

CREATE TABLE allowed_roots (
  id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, access TEXT NOT NULL CHECK (access IN ('read','readwrite')),
  remote INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE TABLE allowed_apps (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, exec_path TEXT NOT NULL, args TEXT NOT NULL DEFAULT '[]',
  can_close INTEGER NOT NULL DEFAULT 0, remote INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE TABLE scope_grants (
  scope TEXT NOT NULL, origin TEXT NOT NULL, enabled INTEGER NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (scope, origin)
);

CREATE TABLE memories (
  id TEXT PRIMARY KEY, category TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL,
  source TEXT NOT NULL, confidence REAL NOT NULL DEFAULT 1.0, tags TEXT NOT NULL DEFAULT '[]',
  syncable INTEGER NOT NULL DEFAULT 0, project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  superseded_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, expires_at TEXT, last_accessed_at TEXT,
  access_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX memories_cat ON memories(category, updated_at);
CREATE VIRTUAL TABLE memories_fts USING fts5(title, content, tags, content='memories', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2');
CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN INSERT INTO memories_fts(rowid, title, content, tags) VALUES (new.rowid, new.title, new.content, new.tags); END;
CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN INSERT INTO memories_fts(memories_fts, rowid, title, content, tags) VALUES ('delete', old.rowid, old.title, old.content, old.tags); END;
CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, title, content, tags) VALUES ('delete', old.rowid, old.title, old.content, old.tags);
  INSERT INTO memories_fts(rowid, title, content, tags) VALUES (new.rowid, new.title, new.content, new.tags);
END;
CREATE TABLE memory_embeddings (
  memory_id TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE, model TEXT NOT NULL, dim INTEGER NOT NULL, vector BLOB NOT NULL
);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, origin TEXT NOT NULL, detail TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX audit_kind ON audit_events(kind, created_at);

CREATE TABLE metrics (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, model TEXT, value TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX metrics_kind ON metrics(kind, created_at);

CREATE TABLE plugins (
  name TEXT PRIMARY KEY, version TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0, manifest TEXT NOT NULL,
  path TEXT NOT NULL, sha256 TEXT NOT NULL, installed_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE plugin_versions (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, version TEXT NOT NULL, path TEXT NOT NULL, sha256 TEXT NOT NULL,
  status TEXT NOT NULL, created_at TEXT NOT NULL
);

CREATE TABLE lab_experiments (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, problem TEXT NOT NULL, proposal TEXT, kind TEXT NOT NULL,
  status TEXT NOT NULL, workspace TEXT NOT NULL, files TEXT NOT NULL DEFAULT '{}', test_output TEXT,
  test_passed INTEGER, report TEXT, diff TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE updates (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, target TEXT NOT NULL, from_version TEXT, to_version TEXT NOT NULL,
  experiment_id TEXT, status TEXT NOT NULL, backup_path TEXT, approved_at TEXT, applied_at TEXT,
  rolled_back_at TEXT, created_at TEXT NOT NULL
);

CREATE TABLE relay_processed (command_id TEXT PRIMARY KEY, received_at TEXT NOT NULL, status TEXT NOT NULL);
`,
  },
  {
    version: 2,
    name: 'chat_pins_projects',
    sql: `
ALTER TABLE conversations ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
ALTER TABLE conversations ADD COLUMN mode TEXT;
CREATE INDEX conversations_pinned ON conversations(pinned, updated_at);
`,
  },
];
