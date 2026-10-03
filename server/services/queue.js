// 持久任务队列：SQLite 租约 + 心跳 + 指数退避；无服务器页面可通过 HTTP tick 驱动
'use strict';
const crypto = require('crypto');
const { log, httpErr } = require('./sources.js');

const uuid = () => crypto.randomUUID();
const now = () => new Date().toISOString();

const LEASE_MS = Number(process.env.JOB_LEASE_MS || 15000);
const MAX_RUN_MS = Number(process.env.JOB_MAX_RUN_MS || 30000);

function enqueue(db, type, payload = {}, { priority = 0, maxAttempts = 3 } = {}) {
  const id = uuid(), ts = now();
  db.prepare(`INSERT INTO jobs
    (id,type,payload,status,priority,attempts,max_attempts,available_at,created_at,updated_at)
    VALUES (?,?,?, 'queued', ?,0,?, ?,?,?)`)
    .run(id, type, JSON.stringify(payload), priority, maxAttempts, ts, ts, ts);
  log(db, 'system', 'job.enqueue', 'job:' + id, { type, payload });
  return getJob(db, id);
}

function getJob(db, id) {
  const row = db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
  return row ? hydrate(row) : null;
}

function listJobs(db, { status, type, limit = 100 } = {}) {
  let sql = 'SELECT * FROM jobs WHERE 1=1';
  const p = [];
  if (status) { sql += ' AND status=?'; p.push(status); }
  if (type) { sql += ' AND type=?'; p.push(type); }
  sql += ' ORDER BY priority DESC, created_at LIMIT ' + Math.min(limit, 500);
  return db.prepare(sql).all(...p).map(hydrate);
}

function hydrate(row) {
  return { ...row, payload: JSON.parse(row.payload || '{}'),
    result: row.result ? JSON.parse(row.result) : null,
    error: row.error ? JSON.parse(row.error) : null };
}

// 领取一个任务（含崩溃恢复：租约过期 + 心跳超时 -> 重新入队或判死）
function lease(db, owner, opts = {}) {
  const ts = now();
  const tx = db.transaction(() => {
    recoverStale(db, ts);
    const row = db.prepare(`SELECT * FROM jobs
      WHERE status='queued' AND available_at<=?
      ORDER BY priority DESC, created_at LIMIT 1`).get(ts);
    if (!row) return null;
    db.prepare(`UPDATE jobs SET status='leased', lease_owner=?, leased_at=?, heartbeat_at=?,
      attempts=attempts+1, updated_at=? WHERE id=?`)
      .run(owner, ts, ts, ts, row.id);
    return getJob(db, row.id);
  });
  return tx();
}

function heartbeat(db, jobId, owner) {
  const r = db.prepare("UPDATE jobs SET heartbeat_at=? WHERE id=? AND status='leased' AND lease_owner=?")
    .run(now(), jobId, owner);
  return r.changes === 1;
}

function succeed(db, jobId, result) {
  const ts = now();
  db.prepare("UPDATE jobs SET status='succeeded', result=?, lease_owner=NULL, updated_at=? WHERE id=?")
    .run(JSON.stringify(result || {}), ts, jobId);
  log(db, 'system', 'job.succeed', 'job:' + jobId, result ? { keys: Object.keys(result) } : null);
  return getJob(db, jobId);
}

// 失败：可重试 -> 退避后重新排队；超过次数 -> dead
function fail(db, jobId, error, { retriable = true } = {}) {
  const job = getJob(db, jobId);
  const ts = now();
  const errPayload = { message: String(error?.message || error), at: ts,
    code: error?.code || null, attempts: job ? job.attempts + 1 : null };
  if (retriable && job && job.attempts < job.max_attempts) {
    const backoffMs = Math.min(30000, 1000 * 2 ** (job.attempts - 1)); // 1s,2s,4s...
    const avail = new Date(Date.now() + backoffMs).toISOString();
    db.prepare(`UPDATE jobs SET status='queued', lease_owner=NULL, error=?, available_at=?, updated_at=? WHERE id=?`)
      .run(JSON.stringify(errPayload), avail, ts, jobId);
    log(db, 'system', 'job.retry', 'job:' + jobId, { backoffMs, attempts: job.attempts });
  } else {
    db.prepare(`UPDATE jobs SET status='dead', lease_owner=NULL, error=?, updated_at=? WHERE id=?`)
      .run(JSON.stringify({ ...errPayload, reason: 'max_attempts_exceeded' }), ts, jobId);
    log(db, 'system', 'job.dead', 'job:' + jobId, errPayload);
  }
  return getJob(db, jobId);
}

// 租约超时恢复（worker 崩溃 / 素材处理超时）
function recoverStale(db, ts = now()) {
  const stale = db.prepare(`SELECT * FROM jobs
    WHERE status='leased'`).all();
  const recovered = [];
  for (const j of stale) {
    const leasedMs = j.leased_at ? Date.now() - new Date(j.leased_at).getTime() : 0;
    const hbMs = j.heartbeat_at ? Date.now() - new Date(j.heartbeat_at).getTime() : Infinity;
    if (hbMs > LEASE_MS || leasedMs > MAX_RUN_MS) {
      const job = hydrate(j);
      const isTimeout = job.payload?._timeout === true || hbMs > LEASE_MS;
      const fakeErr = { message: isTimeout ? '素材处理超时（心跳/租约超时），任务已回收' : 'worker 租约过期',
        code: 'LEASE_TIMEOUT' };
      const next = fail(db, j.id, fakeErr, { retriable: true });
      recovered.push(next);
    }
  }
  return recovered;
}

module.exports = {
  enqueue, lease, succeed, fail, heartbeat, getJob, listJobs, recoverStale,
  LEASE_MS, MAX_RUN_MS, httpErr,
};
