'use strict';
const path = require('path');
const { createApp } = require('./app');

const PORT = Number(process.env.PORT || 8377);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');

const { app } = createApp({
  dataDir: DATA_DIR,
  dbPath: path.join(DATA_DIR, 'app.db'),
  seedDemo: true,
  worker: true,
  workerIntervalMs: Number(process.env.WORKER_INTERVAL_MS || 500),
});

app.listen(PORT, () => {
  console.log(`[server] 县域政策短视频编排台 API 已启动: http://localhost:${PORT}`);
  console.log(`[server] 数据目录: ${DATA_DIR}（SQLite 持久队列，无服务器页面可用 x-worker-token 经 /api/queue/claim 接入）`);
});
