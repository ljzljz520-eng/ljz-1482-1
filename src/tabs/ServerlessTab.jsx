import React, { useState, useEffect, useContext } from 'react';
import { api } from '../api.js';
import { ToastCtx } from '../App.jsx';

export default function ServerlessTab() {
  const { notify, errMsg } = useContext(ToastCtx);
  const [tickLog, setTickLog] = useState([]);
  const [auto, setAuto] = useState(false);
  const [stats, setStats] = useState(null);

  const tick = async () => {
    try {
      const r = await api('/serverless/tick', { method: 'POST', body: JSON.stringify({ owner: 'browser-page' }) });
      setTickLog(l => [{ t: new Date().toLocaleTimeString('zh-CN'), ...r }, ...l].slice(0, 12));
      const jobs = await api('/jobs?limit=8');
      setStats(jobs.reduce((m, j) => { m[j.status] = (m[j.status] || 0) + 1; return m; }, {}));
    } catch (e) { errMsg(e); }
  };
  useEffect(() => {
    if (!auto) return;
    tick();
    const t = setInterval(tick, 1500);
    return () => clearInterval(t);
  }, [auto]);

  return (
    <div className="row">
      <div className="card col" style={{ maxWidth: 460 }}>
        <h2>无服务器页面 ↔ 持久队列</h2>
        <div className="muted" style={{ lineHeight: 1.7 }}>
          队列持久化在 SQLite（<code>jobs</code> 表）。无服务器函数/静态页面无需常驻进程，
          只需调用 <code className="mono">POST /api/serverless/tick</code> 领取并处理一个任务，
          页面轮询 <code className="mono">GET /api/jobs/:id</code> 获取结果。
          <ul>
            <li>函数实例缩容到 0 也不丢任务——任务状态在数据库里；</li>
            <li>租约 + 心跳：实例中途失败，任务超时后被回收重试；</li>
            <li>可独立托管的演示页：<code>serverless/public/index.html</code>（纯静态，填写 API 地址即可）。</li>
          </ul>
        </div>
        <div className="pill-group">
          <button className="btn" onClick={tick}>手动 tick 一次</button>
          <button className={`btn ${auto ? 'danger' : 'ghost'}`} onClick={() => setAuto(a => !a)}>
            {auto ? '停止自动 tick' : '自动 tick（每1.5秒）'}
          </button>
        </div>
        {stats && <div style={{ marginTop: 10 }}>
          {Object.entries(stats).map(([k, v]) => <span key={k} className={`status-pill status-${k}`} style={{ marginRight: 6 }}>{k}: {v}</span>)}
        </div>}
      </div>
      <div className="card col">
        <h2>tick 记录</h2>
        {tickLog.length === 0 && <div className="muted">尚无 tick。先在②页把导出任务入队，或在③页提交素材处理。</div>}
        {tickLog.map((l, i) => (
          <div key={i} className="diff-item unchanged">
            <b>{l.t}</b> processed={l.processed}
            {l.recovered?.length > 0 && <span style={{ color: '#c25016' }}> · 回收超时任务 {l.recovered.length} 个</span>}
            {l.job && <div className="mono">
              {l.job.type} → <span className={`status-pill status-${l.job.status}`}>{l.job.status}</span>
              {l.job.result && <span> {JSON.stringify(l.job.result).slice(0, 160)}</span>}
            </div>}
          </div>
        ))}
      </div>
    </div>
  );
}
