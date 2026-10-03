// 任务处理器：剪辑清单/预览包生成；素材处理（可超时）
'use strict';
const path = require('path');
const fs = require('fs');
const queue = require('./queue.js');
const { buildPackage } = require('./export.js');

const uuid4 = () => require('crypto').randomUUID();
const now = () => new Date().toISOString();

// ---- 素材登记与处理状态 ----
function registerAsset(db, { name, kind = 'footage', timeoutMs = 3000 }) {
  const id = uuid4();
  db.prepare(`INSERT INTO assets (id,name,kind,status,timeout_ms,attempts,created_at)
              VALUES (?,?,?, 'pending', ?,0,?)`).run(id, name, kind, timeoutMs, now());
  return db.prepare('SELECT * FROM assets WHERE id=?').get(id);
}

function listAssets(db) {
  return db.prepare('SELECT * FROM assets ORDER BY created_at DESC').all();
}

function getAsset(db, id) {
  const a = db.prepare('SELECT * FROM assets WHERE id=?').get(id);
  if (!a) throw queue.httpErr(404, '素材不存在');
  return a;
}

/**
 * 处理素材：
 *  - 正常：在 timeoutMs 内完成 -> ready
 *  - 超时：超过 timeout_ms 未完成 -> 标记 timeout 并抛出可重试错误（持久队列退避重试，超过次数判死）
 *  - 可通过 forceTimeout=true 模拟"素材处理超时"验收场景
 */
async function processAssetOnce(db, assetId, { forceTimeout = false, tickMs = 100 } = {}) {
  const asset = getAsset(db, assetId);
  db.prepare("UPDATE assets SET status='processing', attempts=attempts+1, last_attempt_at=? WHERE id=?")
    .run(now(), assetId);

  const processingMs = forceTimeout ? asset.timeout_ms + 2000 : Math.min(500, asset.timeout_ms - 500);
  await sleep(Math.max(50, processingMs));

  const fresh = db.prepare('SELECT * FROM assets WHERE id=?').get(assetId);
  // 判定超时：处理耗时 >= 素材允许时长，或显式 forceTimeout
  const elapsed = fresh.last_attempt_at ? Date.now() - new Date(fresh.last_attempt_at).getTime() : 0;
  if (forceTimeout || elapsed >= asset.timeout_ms) {
    db.prepare("UPDATE assets SET status='timeout' WHERE id=?").run(assetId);
    const err = new Error(`素材「${asset.name}」处理超时（${elapsed}ms >= ${asset.timeout_ms}ms）`);
    err.code = 'ASSET_TIMEOUT';
    err.retriable = true;
    throw err;
  }
  db.prepare("UPDATE assets SET status='ready' WHERE id=?").run(assetId);
  return db.prepare('SELECT * FROM assets WHERE id=?').get(assetId);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- 任务类型处理器表 ----
function buildHandlers(deps) {
  const { db, outputRoot } = deps;
  return {
    // 异步生成剪辑清单及预览包
    async export_bundle(job, { heartbeat }) {
      const { scriptId } = job.payload;
      await heartbeat();
      const bundle = buildPackage(db, scriptId);
      if (!bundle.validation.ok) {
        const err = new Error('导出校验未通过：' + bundle.validation.errors.map(e => e.message).join(' | '));
        err.code = 'VALIDATION_FAILED';
        err.retriable = false;
        err.detail = bundle.validation;
        throw err;
      }
      await heartbeat();
      const dir = path.join(outputRoot, scriptId);
      fs.mkdirSync(dir, { recursive: true });
      const base = `job_${job.id.slice(0, 8)}`;
      const jsonPath = path.join(dir, `${base}_editlist.json`);
      const srtPath = path.join(dir, `${base}_preview.srt`);
      fs.writeFileSync(jsonPath, JSON.stringify({ editList: bundle.editList, preview: bundle.preview }, null, 2));
      fs.writeFileSync(srtPath, bundle.preview.srt);
      return {
        editListPath: jsonPath, previewPackagePath: srtPath,
        sceneCount: bundle.editList.length,
        validation: { ok: true, warnings: bundle.validation.warnings.length },
      };
    },

    // 素材处理任务：payload.assetId + 可选 forceTimeout（超时后走队列重试）
    async process_asset(job) {
      const asset = await processAssetOnce(db, job.payload.assetId, {
        forceTimeout: !!job.payload.forceTimeout,
      });
      return { assetId: asset.id, status: asset.status, name: asset.name };
    },
  };
}

// ---- worker 循环（本地常驻进程）；serverless tick 复用 processOne ----
async function processOne(db, owner = 'worker') {
  const job = queue.lease(db, owner + ':' + process.pid);
  if (!job) return null;
  const handlers = buildHandlers({
    db,
    outputRoot: path.join(__dirname, '..', '..', 'output'),
  });
  const h = handlers[job.type];
  let hbTimer = null;
  const heartbeat = async () => { queue.heartbeat(db, job.id, owner + ':' + process.pid); };
  try {
    if (!h) throw Object.assign(new Error('未知任务类型: ' + job.type), { retriable: false });
    hbTimer = setInterval(() => queue.heartbeat(db, job.id, owner + ':' + process.pid), Math.max(500, queue.LEASE_MS / 3));
    const result = await h(job, { heartbeat });
    clearInterval(hbTimer);
    return queue.succeed(db, job.id, result);
  } catch (e) {
    if (hbTimer) clearInterval(hbTimer);
    return queue.fail(db, job.id, { message: e.message, code: e.code || null },
      { retriable: e.retriable !== false });
  }
}

async function runWorker(db, { pollMs = 300, maxJobs = Infinity, owner = 'worker' } = {}) {
  let processed = 0;
  while (processed < maxJobs) {
    const done = await processOne(db, owner);
    if (done) { processed++; continue; }
    await sleep(pollMs);
    // 常驻循环退出条件（测试用 maxJobs；生产无限）
    if (processed >= maxJobs) break;
    if (process.env.WORKER_ONESHOT) break;
  }
  return processed;
}

module.exports = {
  buildHandlers, processOne, runWorker,
  registerAsset, listAssets, getAsset, processAssetOnce,
};
