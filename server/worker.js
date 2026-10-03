// 独立常驻 worker：消费持久队列（本地启动方式之一）
'use strict';
const { getDb } = require('./db.js');
const { runWorker } = require('./services/handlers.js');

const db = getDb();
const pollMs = Number(process.env.WORKER_POLL_MS || 300);
console.log(`[worker] started, polling every ${pollMs}ms (db=${process.env.DB_PATH || 'default'})`);
runWorker(db, { pollMs, owner: 'standalone' })
  .then(n => console.log('[worker] stopped, processed', n))
  .catch(e => { console.error('[worker] fatal', e); process.exit(1); });
