'use strict';
/**
 * 数据库层：SQLite（better-sqlite3），持久化来源修订、脚本场次、复核意见、任务队列等。
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  permissions TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS policies(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS policy_revisions(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  policy_id INTEGER NOT NULL REFERENCES policies(id),
  version_no INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_by TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(policy_id, version_no)
);
CREATE TABLE IF NOT EXISTS clauses(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  revision_id INTEGER NOT NULL REFERENCES policy_revisions(id),
  clause_key TEXT NOT NULL,          -- 稳定条款号，如「第三条」，跨修订保持不变
  para_index INTEGER NOT NULL,       -- 段落顺序
  kind TEXT NOT NULL DEFAULT 'other',-- condition|material|location|reminder|other
  text TEXT NOT NULL,
  UNIQUE(revision_id, clause_key)
);
CREATE TABLE IF NOT EXISTS clause_changes(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  policy_id INTEGER NOT NULL,
  from_revision_id INTEGER NOT NULL,
  to_revision_id INTEGER NOT NULL,
  clause_key TEXT NOT NULL,
  change_type TEXT NOT NULL,         -- added|removed|text_change|date_change|reorder
  old_text TEXT, new_text TEXT,
  old_index INTEGER, new_index INTEGER,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS scripts(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  policy_id INTEGER NOT NULL REFERENCES policies(id),
  title TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS script_versions(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  script_id INTEGER NOT NULL REFERENCES scripts(id),
  version_no INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',  -- draft|published
  basis_revision_id INTEGER,             -- 发布时锁定的依据修订（旧成果保留当时依据）
  created_at TEXT NOT NULL,
  published_at TEXT,
  published_by TEXT,
  UNIQUE(script_id, version_no)
);
CREATE TABLE IF NOT EXISTS scenes(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  script_id INTEGER NOT NULL REFERENCES scripts(id),
  scene_no INTEGER NOT NULL,
  scene_type TEXT NOT NULL DEFAULT 'other', -- opening|conditions|materials|location|reminder|other
  title TEXT NOT NULL DEFAULT '',
  pin_mode TEXT NOT NULL DEFAULT 'follow',  -- follow=跟随更新的草稿 | fixed=固定源文版本
  pinned_revision_id INTEGER,
  subtitle TEXT NOT NULL DEFAULT '',
  voiceover TEXT NOT NULL DEFAULT '',
  shot_card TEXT NOT NULL DEFAULT '',
  updated_at TEXT,
  deleted_at TEXT
);
CREATE TABLE IF NOT EXISTS scene_statements(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scene_id INTEGER NOT NULL REFERENCES scenes(id),
  stmt_type TEXT NOT NULL DEFAULT 'other',  -- opening|condition|material|location|reminder|other
  paraphrase TEXT NOT NULL,                 -- 改写文本（改写不是法律判断，依据以引用条款为准）
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS statement_citations(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  statement_id INTEGER NOT NULL REFERENCES scene_statements(id),
  clause_key TEXT NOT NULL,
  UNIQUE(statement_id, clause_key)
);
CREATE TABLE IF NOT EXISTS reviews(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scene_id INTEGER NOT NULL REFERENCES scenes(id),
  reviewer_id TEXT NOT NULL,
  basis_revision_id INTEGER NOT NULL,       -- 复核时所依据的源文修订
  decision TEXT NOT NULL,                   -- approved|rejected
  comment TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  invalidated_at TEXT,
  invalidation_reason TEXT
);
-- 同一场次同一依据版本只允许一条生效的通过记录（两人同时审核时后者冲突）
CREATE UNIQUE INDEX IF NOT EXISTS ux_reviews_active_approved
  ON reviews(scene_id, basis_revision_id) WHERE decision='approved' AND invalidated_at IS NULL;
CREATE TABLE IF NOT EXISTS published_snapshots(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  script_version_id INTEGER NOT NULL REFERENCES script_versions(id),
  snapshot_json TEXT NOT NULL,              -- 发布时完整快照（含条款原文，冻结当时依据）
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS artifacts(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,                       -- edit_list|preview_package
  script_version_id INTEGER,
  path TEXT,
  json TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks(           -- 持久队列：本地 worker 与无服务器页面共用
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,                       -- generate_edit_list|generate_preview|process_material
  payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'queued',    -- queued|running|done|failed|timeout
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  timeout_ms INTEGER NOT NULL DEFAULT 30000,
  run_after TEXT,
  locked_by TEXT, locked_at TEXT,
  result TEXT, error TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_log(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT,
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
`;

const SEED_USERS = [
  ['u_admin', '管理员', ['admin']],
  ['u_editor', '编辑小李', ['policy.write', 'script.write', 'task.run']],
  ['u_reviewer_a', '复核员甲', ['review']],
  ['u_reviewer_b', '复核员乙', ['review']],
  ['u_publisher', '发布员', ['publish', 'task.run']],
];

function now() { return new Date().toISOString(); }

function createDb(dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  const c = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (c === 0) {
    const ins = db.prepare('INSERT INTO users(id,name,permissions) VALUES (?,?,?)');
    db.transaction(() => { for (const [id, name, perms] of SEED_USERS) ins.run(id, name, JSON.stringify(perms)); })();
  }
  return db;
}

function audit(db, actor, action, detail) {
  db.prepare('INSERT INTO audit_log(actor,action,detail,created_at) VALUES (?,?,?,?)')
    .run(actor || 'system', action, JSON.stringify(detail || {}), now());
}

function getUser(db, id) {
  if (!id) return null;
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(id);
  if (u) u.permissions = JSON.parse(u.permissions);
  return u;
}

function hasPerm(user, perm) {
  if (!user) return false;
  return user.permissions.includes('admin') || user.permissions.includes(perm);
}

module.exports = { createDb, audit, getUser, hasPerm, now };
