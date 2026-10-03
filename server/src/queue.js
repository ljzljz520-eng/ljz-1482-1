'use strict';
/**
 * 持久任务队列（SQLite 表即队列）：
 * - 本地 worker 轮询执行；无服务器页面可通过 /api/queue/claim|complete|fail 接入同一队列；
 * - 任务带超时（素材处理超时 → timeout），支持重试；
 * - 处理程序：generate_edit_list（剪辑清单）、generate_preview（预览包）、process_material（素材处理）。
 */
const fs = require('fs');
const path = require('path');
const { now, audit } = require('./db');
const { buildEditList, renderPreviewHtml } = require('./editlist');
const { validateExport } = require('./validate');

function enqueue(db, type, payload, opts = {}) {
  const t = now();
  const r = db.prepare(`INSERT INTO tasks(type,payload,status,attempts,max_attempts,timeout_ms,created_at,updated_at)
    VALUES (?,?, 'queued', 0, ?, ?, ?, ?)`)
    .run(type, JSON.stringify(payload || {}), opts.maxAttempts || 3, opts.timeoutMs || 30000, t, t);
  return db.prepare('SELECT * FROM tasks WHERE id=?').get(r.lastInsertRowid);
}

/** 原子认领下一个到期任务（本地 worker 与无服务器共用） */
function claimNext(db, workerId) {
  const tx = db.transaction(() => {
    const t = db.prepare(`SELECT * FROM tasks WHERE status='queued' AND (run_after IS NULL OR run_after<=?)
      ORDER BY id LIMIT 1`).get(now());
    if (!t) return null;
    db.prepare(`UPDATE tasks SET status='running', locked_by=?, locked_at=?, attempts=attempts+1, updated_at=? WHERE id=?`)
      .run(workerId, now(), now(), t.id);
    return db.prepare('SELECT * FROM tasks WHERE id=?').get(t.id);
  });
  return tx();
}

function complete(db, id, result) {
  db.prepare(`UPDATE tasks SET status='done', result=?, error=NULL, updated_at=? WHERE id=?`)
    .run(JSON.stringify(result ?? null), now(), id);
  return db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
}

function fail(db, id, error) {
  db.prepare(`UPDATE tasks SET status='failed', error=?, updated_at=? WHERE id=?`).run(String(error), now(), id);
  return db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
}

function timeout(db, id, msg) {
  db.prepare(`UPDATE tasks SET status='timeout', error=?, updated_at=? WHERE id=?`).run(msg || '处理超时', now(), id);
  return db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
}

function retry(db, id, opts = {}) {
  const t = db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
  if (!t) return null;
  if (!['failed', 'timeout'].includes(t.status)) return t;
  db.prepare(`UPDATE tasks SET status='queued', error=NULL, locked_by=NULL, locked_at=NULL,
    timeout_ms=?, updated_at=? WHERE id=?`).run(opts.timeoutMs || t.timeout_ms, now(), id);
  audit(db, opts.actor || 'system', 'task.retry', { task_id: id, type: t.type });
  return db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
}

/** 清扫卡死任务（worker 崩溃等）：运行超过 timeout_ms → timeout */
function sweepTimeouts(db) {
  const rows = db.prepare(`SELECT id, timeout_ms, locked_at FROM tasks WHERE status='running'`).all();
  const nowMs = Date.now();
  for (const r of rows) {
    if (r.locked_at && nowMs - Date.parse(r.locked_at) > r.timeout_ms) timeout(db, r.id, '处理超时（看门狗标记）');
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

const handlers = {
  /** 生成剪辑清单 */
  generate_edit_list(db, payload) {
    const editList = buildEditList(db, payload.script_version_id);
    db.prepare('INSERT INTO artifacts(kind, script_version_id, json, created_at) VALUES (?,?,?,?)')
      .run('edit_list', payload.script_version_id, JSON.stringify(editList), now());
    return { edit_list: editList };
  },
  /** 生成预览包（先过导出校验：字幕/旁白/镜头卡/证据链） */
  generate_preview(db, payload, ctx) {
    const validation = validateExport(db, payload.script_version_id);
    if (!validation.ok) {
      const err = new Error('导出校验未通过：' + validation.errors.map(e => e.message).join('；'));
      err.validation = validation;
      throw err;
    }
    const editList = buildEditList(db, payload.script_version_id);
    const dir = path.join(ctx.dataDir, 'previews', `v${payload.script_version_id}_${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'edit_list.json'), JSON.stringify(editList, null, 2));
    fs.writeFileSync(path.join(dir, 'preview.html'), renderPreviewHtml(editList, validation));
    const manifest = { script_version_id: payload.script_version_id, basis_revision_id: editList.basis_revision_id, files: ['edit_list.json', 'preview.html', 'manifest.json'], validation, generated_at: now() };
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    db.prepare('INSERT INTO artifacts(kind, script_version_id, path, json, created_at) VALUES (?,?,?,?,?)')
      .run('preview_package', payload.script_version_id, dir, JSON.stringify(manifest), now());
    return { preview_dir: dir, manifest };
  },
  /** 素材处理（模拟耗时任务，用于验收超时与重试） */
  async process_material(db, payload) {
    await sleep(payload.duration_ms || 3000);
    return { material: payload.name || 'material', processed: true, duration_ms: payload.duration_ms || 3000 };
  },
};

/** 执行一个任务（带超时竞速） */
async function runClaimed(db, task, ctx) {
  const handler = handlers[task.type];
  if (!handler) return fail(db, task.id, `未知任务类型 ${task.type}`);
  let timer;
  try {
    const result = await Promise.race([
      Promise.resolve().then(() => handler(db, JSON.parse(task.payload), ctx)),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('TASK_TIMEOUT')), task.timeout_ms); }),
    ]);
    clearTimeout(timer);
    return complete(db, task.id, result);
  } catch (e) {
    clearTimeout(timer);
    if (e && e.message === 'TASK_TIMEOUT') {
      audit(db, 'worker', 'task.timeout', { task_id: task.id, type: task.type, timeout_ms: task.timeout_ms });
      return timeout(db, task.id, `处理超时（>${task.timeout_ms}ms）`);
    }
    return fail(db, task.id, e.message || String(e));
  }
}

async function runWorkerOnce(db, ctx) {
  sweepTimeouts(db);
  const task = claimNext(db, ctx.workerId || 'local-worker');
  if (!task) return null;
  return runClaimed(db, task, ctx);
}

function startWorker(db, ctx, intervalMs = 500) {
  const timer = setInterval(() => { runWorkerOnce(db, ctx).catch(() => {}); }, intervalMs);
  timer.unref();
  return timer;
}

module.exports = { enqueue, claimNext, complete, fail, timeout, retry, sweepTimeouts, runWorkerOnce, runClaimed, startWorker, handlers };
