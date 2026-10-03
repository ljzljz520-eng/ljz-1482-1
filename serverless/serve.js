// 本地托管"无服务器静态页面"的最小静态服务器（与 API 分离，演示跨域）
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PAGE_PORT || 8080);
const dir = path.join(__dirname, 'public');
http.createServer((req, res) => {
  const file = path.join(dir, req.url === '/' ? 'index.html' : req.url);
  if (!file.startsWith(dir) || !fs.existsSync(file)) { res.writeHead(404); return res.end('not found'); }
  const ext = path.extname(file);
  res.writeHead(200, { 'Content-Type': ext === '.html' ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8' });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, () => console.log(`serverless static page: http://localhost:${PORT}`));
