/**
 * 业务库（store.db）的表结构。
 *
 * 这里集中维护 sessions / messages / permission_rules / summaries 四张表，
 * 与审计库（audit.db）分开存放：业务数据可读改写、可关联查询；审计另存一库。
 */

export const STORE_SCHEMA_VERSION = 1;

export const STORE_SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  cwd         TEXT NOT NULL,
  title       TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id   TEXT NOT NULL REFERENCES sessions(id),
  seq          INTEGER NOT NULL,
  step         INTEGER,
  role         TEXT NOT NULL,
  content      TEXT,
  tool_calls   TEXT,
  tool_call_id TEXT,
  name         TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, seq);

CREATE TABLE IF NOT EXISTS permission_rules (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  scope      TEXT NOT NULL,
  tool_name  TEXT NOT NULL,
  pattern    TEXT,
  decision   TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_permission_lookup ON permission_rules(tool_name, scope);

CREATE TABLE IF NOT EXISTS summaries (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id       TEXT NOT NULL REFERENCES sessions(id),
  covers_seq_start INTEGER NOT NULL,
  covers_seq_end   INTEGER NOT NULL,
  content          TEXT NOT NULL,
  token_estimate   INTEGER,
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_summaries_session ON summaries(session_id);
`;
