// 无服务器函数适配器示例（Vercel/Netlify/任意 FaaS 形态）
// 函数本身无状态：所有任务状态都在编排台 SQLite（可替换为云数据库实现 queue 接口）。
// 部署形态：HTTP 触发本函数 -> 驱动一次 tick；也可由定时触发器周期调用。
'use strict';

// 这里以"调用自建编排台 HTTP API"的形式给出最小实现；
// 若 FaaS 与 API 同 VPC，可直接 require server/services 模块并传入 db 连接。
const STUDIO_API = process.env.STUDIO_API || 'http://localhost:4000/api';

module.exports.handler = async (event = {}) => {
  const owner = event.requestContext?.requestId || 'faas';
  const res = await fetch(`${STUDIO_API}/serverless/tick`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ owner: 'faas:' + owner }),
  });
  const data = await res.json();
  return { statusCode: 200, body: JSON.stringify(data) };
};
