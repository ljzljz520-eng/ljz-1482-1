'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');
const { createDb } = require('./db');
const { registerRoutes } = require('./routes');
const queue = require('./queue');
const { seedDemo } = require('./seedDemo');

function createApp(opts = {}) {
  const dataDir = opts.dataDir || path.join(__dirname, '..', '..', 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const db = createDb(opts.dbPath || path.join(dataDir, 'app.db'));
  if (opts.seedDemo) seedDemo(db);
  const ctx = {
    db, dataDir,
    workerToken: opts.workerToken || process.env.WORKER_TOKEN || 'dev-worker-token',
    workerId: opts.workerId || 'local-worker',
  };
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  registerRoutes(app, ctx);
  const dist = path.join(__dirname, '..', '..', 'web', 'dist');
  if (fs.existsSync(dist)) {
    app.use(express.static(dist));
    app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(dist, 'index.html')));
  }
  // 统一错误处理
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: 'internal', message: err.message });
  });
  let workerTimer = null;
  if (opts.worker) workerTimer = queue.startWorker(db, ctx, opts.workerIntervalMs || 500);
  return {
    app, db, ctx,
    runWorkerOnce: () => queue.runWorkerOnce(db, ctx),
    stopWorker: () => workerTimer && clearInterval(workerTimer),
  };
}

module.exports = { createApp };
