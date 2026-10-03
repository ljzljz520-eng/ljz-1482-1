// HTTP API：来源/修订、脚本/场次、复核、发布、异步任务、无服务器驱动入口
'use strict';
const express = require('express');
const cors = require('cors');
const path = require('path');
const { getDb } = require('./db.js');
const sourcesSvc = require('./services/sources.js');
const scriptsSvc = require('./services/scripts.js');
const reviewsSvc = require('./services/reviews.js');
const publishSvc = require('./services/publish.js');
const exportSvc = require('./services/export.js');
const queue = require('./services/queue.js');
const handlers = require('./services/handlers.js');

function createApp(db) {
  db = db || getDb();
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '2mb' }));
  app.set('db', db);

  const wrap = fn => (req, res, next) => {
    try {
      Promise.resolve(fn(req, res, next)).catch(err => sendErr(res, err));
    } catch (err) { sendErr(res, err); }
  };
  const sendErr = (res, err) => {
    const status = err.status || 500;
    if (res.headersSent) return;
    res.status(status).json({ error: err.message, status, details: err.details });
  };
  const actor = req => req.get('x-actor') || req.body?.actor || null;

  // ---------- 来源与修订 ----------
  app.post('/api/sources', wrap((req, res) => {
    const rev = sourcesSvc.createSource(db, { ...req.body, actor: actor(req) });
    res.status(201).json(rev);
  }));
  app.get('/api/sources', wrap((req, res) => res.json(sourcesSvc.listSources(db))));
  app.get('/api/sources/:id', wrap((req, res) => res.json(sourcesSvc.getSource(db, req.params.id))));
  app.post('/api/sources/:id/revisions', wrap((req, res) => {
    const rev = sourcesSvc.addRevision(db, req.params.id, { ...req.body, actor: actor(req) });
    res.status(201).json(rev);
  }));
  app.get('/api/revisions/:id', wrap((req, res) => res.json(sourcesSvc.getRevision(db, req.params.id))));
  app.post('/api/parse-preview', wrap((req, res) =>
    res.json({ clauses: sourcesSvc.previewParse(req.body.rawText || '') })));

  // ---------- 脚本与场次 ----------
  app.post('/api/scripts', wrap((req, res) =>
    res.status(201).json(scriptsSvc.createScript(db, { ...req.body, actor: actor(req) }))));
  app.get('/api/scripts', wrap((req, res) => res.json(scriptsSvc.listScripts(db))));
  app.get('/api/scripts/:id', wrap((req, res) => res.json(scriptsSvc.getScript(db, req.params.id))));
  app.post('/api/scripts/:id/rebase', wrap((req, res) =>
    res.json(scriptsSvc.rebaseScript(db, req.params.id, { ...req.body, actor: actor(req) }))));
  app.post('/api/scripts/:id/scenes', wrap((req, res) =>
    res.status(201).json(scriptsSvc.addScene(db, req.params.id, req.body, actor(req)))));
  app.patch('/api/scenes/:id', wrap((req, res) =>
    res.json(scriptsSvc.updateScene(db, req.params.id, req.body, actor(req)))));
  app.delete('/api/scenes/:id', wrap((req, res) =>
    res.json(scriptsSvc.deleteScene(db, req.params.id, { reason: req.body?.reason, actor: actor(req) }))));
  app.post('/api/scenes/:id/move', wrap((req, res) =>
    res.json(scriptsSvc.moveScene(db, req.params.id, { dir: req.body.dir, actor: actor(req) }))));

  // ---------- 复核 ----------
  app.post('/api/scenes/:id/reviews', wrap((req, res) =>
    res.status(201).json(reviewsSvc.submitReview(db, req.params.id, { ...req.body, actor: actor(req) }))));
  app.get('/api/scenes/:id/reviews', wrap((req, res) => res.json(reviewsSvc.listReviews(db, req.params.id))));
  app.get('/api/users', wrap((req, res) => res.json(reviewsSvc.listUsers(db))));
  app.post('/api/users', wrap((req, res) => {
    res.status(201).json(reviewsSvc.ensureUser(db, req.body.name, req.body.role || 'editor'));
  }));
  app.post('/api/users/:id/deactivate', wrap((req, res) =>
    res.json(reviewsSvc.setUserActive(db, req.params.id, false))));
  app.post('/api/users/:id/activate', wrap((req, res) =>
    res.json(reviewsSvc.setUserActive(db, req.params.id, true))));

  // ---------- 校验 / 发布 ----------
  app.get('/api/scripts/:id/validate', wrap((req, res) =>
    res.json(exportSvc.validateForExport(db, req.params.id))));
  app.post('/api/scripts/:id/export-preview', wrap((req, res) =>
    res.json(exportSvc.buildPackage(db, req.params.id))));
  app.post('/api/scripts/:id/publish-intent', wrap((req, res) =>
    res.status(201).json(publishSvc.createPublishIntent(db, req.params.id, req.body))));
  app.post('/api/scripts/:id/publish', wrap((req, res) =>
    res.status(201).json(publishSvc.publish(db, req.params.id, req.body))));
  app.get('/api/scripts/:id/releases/:version', wrap((req, res) =>
    res.json(publishSvc.getRelease(db, req.params.id, Number(req.params.version)))));

  // ---------- 异步任务（持久队列）----------
  app.post('/api/scripts/:id/jobs/export', wrap((req, res) => {
    scriptsSvc.mustScript(db, req.params.id);
    const job = queue.enqueue(db, 'export_bundle', { scriptId: req.params.id, options: req.body || {} });
    res.status(202).json(job);
  }));
  app.get('/api/jobs', wrap((req, res) => res.json(queue.listJobs(db, req.query))));
  app.get('/api/jobs/:id', wrap((req, res) => {
    const job = queue.getJob(db, req.params.id);
    if (!job) return res.status(404).json({ error: '任务不存在' });
    res.json(job);
  }));

  // ---------- 素材 ----------
  app.post('/api/assets', wrap((req, res) =>
    res.status(201).json(handlers.registerAsset(db, req.body))));
  app.get('/api/assets', wrap((req, res) => res.json(handlers.listAssets(db))));
  app.post('/api/assets/:id/process', wrap(async (req, res) => {
    const forceTimeout = !!req.body?.forceTimeout;
    const job = queue.enqueue(db, 'process_asset',
      { assetId: req.params.id, forceTimeout }, { maxAttempts: forceTimeout ? (req.body.maxAttempts || 3) : 3 });
    res.status(202).json(job);
  }));

  // ---------- 无服务器页面入口：显式 tick 推动持久队列 ----------
  // 页面本身可纯静态托管（serverless/public），只需能访问本 API。
  app.post('/api/serverless/tick', wrap(async (req, res) => {
    const owner = req.body?.owner || 'serverless:' + (req.ip || 'unknown');
    const recovered = queue.recoverStale(db);
    const before = queue.listJobs(db, { status: 'leased' }).length;
    const done = await handlers.processOne(db, owner);
    res.json({
      processed: done ? 1 : 0,
      recovered: recovered.map(j => ({ id: j.id, type: j.type, status: j.status, attempts: j.attempts })),
      job: done,
      leasedBefore: before,
    });
  }));

  app.get('/api/health', wrap((req, res) => res.json({ ok: true, ts: new Date().toISOString() })));

  // 生产模式托管 React 构建产物
  if (process.env.SERVE_DIST === '1') {
    const dist = path.join(__dirname, '..', 'dist');
    app.use(express.static(dist));
    app.get(/^\/(?!api).*/, (req, res) => res.sendFile(path.join(dist, 'index.html')));
  }
  return app;
}

if (require.main === module) {
  const db = getDb();
  const port = Number(process.env.PORT || 4000);
  const app = createApp(db);
  const server = app.listen(port, () => console.log(`API listening on http://localhost:${port}`));

  // 未启用独立 worker 时，API 进程内置一个轻量 worker（可通过 DISABLE_BUILTIN_WORKER=1 关闭，
  // 改由 server/worker.js 或无服务器 tick 驱动）
  if (!process.env.DISABLE_BUILTIN_WORKER) {
    const { runWorker } = handlers;
    runWorker(db, { pollMs: 400, owner: 'builtin' }).catch(e => console.error('worker error:', e));
  }
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
}

module.exports = { createApp };
