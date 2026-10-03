// SQLite 持久化 + schema 初始化
'use strict';
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

let _db;
function getDb(dbPath) {
  if (_db) return _db;
  const file = dbPath || process.env.DB_PATH || path.join(__dirname, '..', 'data', 'app.db');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  _db = new Database(file);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  init(_db);
  return _db;
}

// 供测试使用：内存库工厂
function createDb(file = ':memory:') {
  const db = new Database(file);
  db.pragma('foreign_keys = ON');
  init(db);
  return db;
}

function init(db) {
  db.exec(`
  CREATE TABLE IF NOT EXISTS sources (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    issuer TEXT,
    doc_no TEXT,
    current_revision_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS revisions (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    note TEXT,
    raw_text TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(source_id, version)
  );

  CREATE TABLE IF NOT EXISTS clauses (
    id TEXT PRIMARY KEY,
    revision_id TEXT NOT NULL REFERENCES revisions(id) ON DELETE CASCADE,
    ref TEXT NOT NULL,
    title TEXT,
    text TEXT NOT NULL,
    clause_order INTEGER NOT NULL,
    fingerprint TEXT NOT NULL,
    dates TEXT NOT NULL DEFAULT '[]'
  );
  CREATE INDEX IF NOT EXISTS idx_clauses_rev ON clauses(revision_id);
  CREATE INDEX IF NOT EXISTS idx_clauses_fp ON clauses(fingerprint);

  -- 修订间差异快照（用于审核失效计算与页面展示）
  CREATE TABLE IF NOT EXISTS revision_diffs (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL,
    revision_id TEXT NOT NULL,
    base_revision_id TEXT,
    summary TEXT NOT NULL,
    detail TEXT NOT NULL,
    invalidated_fingerprints TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS scripts (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    -- following: 跟随源文最新版；pinned: 固定当时版本
    mode TEXT NOT NULL DEFAULT 'following' CHECK(mode IN ('following','pinned')),
    base_revision_id TEXT,
    target_revision_id TEXT,
    status TEXT NOT NULL DEFAULT 'draft',
    published_version INTEGER DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS scenes (
    id TEXT PRIMARY KEY,
    script_id TEXT NOT NULL REFERENCES scripts(id) ON DELETE CASCADE,
    scene_order INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('opening','conditions','materials','location','closing','other')),
    title TEXT NOT NULL,
    narration TEXT NOT NULL DEFAULT '',
    subtitle TEXT NOT NULL DEFAULT '',
    shot_card TEXT NOT NULL DEFAULT '',
    linked_clause_id TEXT REFERENCES clauses(id) ON DELETE SET NULL,
    linked_fingerprint TEXT,
    content_version INTEGER NOT NULL DEFAULT 1,
    deleted INTEGER NOT NULL DEFAULT 0,
    delete_reason TEXT,
    deleted_at TEXT,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_scenes_script ON scenes(script_id);

  -- 双人复核：同一(场次, 目标版本)需要两个不同复核人，且内容版本一致
  CREATE TABLE IF NOT EXISTS reviews (
    id TEXT PRIMARY KEY,
    scene_id TEXT NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
    target_revision_id TEXT NOT NULL,
    content_version INTEGER NOT NULL,
    linked_fingerprint TEXT,
    reviewer TEXT NOT NULL,
    decision TEXT NOT NULL CHECK(decision IN ('approved','rejected')),
    comment TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(scene_id, target_revision_id, content_version, reviewer)
  );
  CREATE INDEX IF NOT EXISTS idx_reviews_scene ON reviews(scene_id);

  -- 发布意图（发布前取权限令牌；真正发布时再次校验——支持"发布时权限撤回"）
  CREATE TABLE IF NOT EXISTS publish_intents (
    id TEXT PRIMARY KEY,
    script_id TEXT NOT NULL REFERENCES scripts(id) ON DELETE CASCADE,
    target_revision_id TEXT NOT NULL,
    permission_token TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    consumed INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS releases (
    id TEXT PRIMARY KEY,
    script_id TEXT NOT NULL REFERENCES scripts(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    revision_id TEXT NOT NULL,
    snapshot TEXT NOT NULL,
    export_bundle_path TEXT,
    published_by TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(script_id, version)
  );

  -- 持久队列：任务与租约（无服务器页面通过 /api/serverless/tick 推动）
  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'queued'
      CHECK(status IN ('queued','leased','succeeded','failed','dead')),
    priority INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    lease_owner TEXT,
    leased_at TEXT,
    heartbeat_at TEXT,
    available_at TEXT NOT NULL,
    result TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_jobs_poll ON jobs(status, priority, available_at);

  -- 素材处理（异步任务依赖，支持超时场景）
  CREATE TABLE IF NOT EXISTS assets (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'footage',
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK(status IN ('pending','processing','ready','timeout','failed')),
    timeout_ms INTEGER NOT NULL DEFAULT 3000,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_attempt_at TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    role TEXT NOT NULL DEFAULT 'editor' CHECK(role IN ('editor','reviewer','publisher','admin')),
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY,
    actor TEXT,
    action TEXT NOT NULL,
    entity TEXT,
    detail TEXT,
    created_at TEXT NOT NULL
  );
  `);
}

module.exports = { getDb, createDb };
