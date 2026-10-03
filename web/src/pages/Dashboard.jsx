import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { get } from '../api';

export default function Dashboard() {
  const [data, setData] = useState(null);
  useEffect(() => { get('/api/overview').then(r => setData(r.body)); }, []);
  if (!data) return <p className="muted">加载中…</p>;
  const taskCount = s => (data.tasks.find(t => t.status === s) || {}).c || 0;
  return (
    <div>
      <div className="grid cols-4">
        <div className="stat"><div className="num">{data.policies}</div><div className="lbl">政策来源</div></div>
        <div className="stat"><div className="num">{data.revisions}</div><div className="lbl">来源修订</div></div>
        <div className="stat"><div className="num">{data.scripts}</div><div className="lbl">脚本</div></div>
        <div className="stat"><div className="num" style={{ color: data.pending_review ? '#e8710a' : '#0f9d58' }}>{data.pending_review}</div><div className="lbl">待复核场次</div></div>
      </div>
      <div className="card" style={{ marginTop: 14 }}>
        <h3>任务队列（持久化，支持无服务器页面接入）</h3>
        <div className="row">
          {['queued', 'running', 'done', 'failed', 'timeout'].map(s => (
            <span key={s} className={`badge ${s === 'done' ? 'green' : s === 'queued' ? 'blue' : s === 'running' ? 'purple' : 'red'}`}>
              {s}: {taskCount(s)}
            </span>
          ))}
          <Link to="/tasks">进入任务台 →</Link>
        </div>
      </div>
      <div className="card">
        <h3>最近审计</h3>
        <table>
          <thead><tr><th>时间</th><th>操作者</th><th>动作</th><th>详情</th></tr></thead>
          <tbody>
            {data.audit.map(a => (
              <tr key={a.id}>
                <td className="mono">{a.created_at.slice(0, 19).replace('T', ' ')}</td>
                <td>{a.actor}</td><td>{a.action}</td>
                <td className="mono">{JSON.stringify(a.detail).slice(0, 120)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
