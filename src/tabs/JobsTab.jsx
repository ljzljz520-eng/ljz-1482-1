import React, { useState, useEffect, useContext } from 'react';
import { api } from '../api.js';
import { ToastCtx } from '../App.jsx';

export default function JobsTab() {
  const { notify, errMsg } = useContext(ToastCtx);
  const [jobs, setJobs] = useState([]);
  const [assets, setAssets] = useState([]);
  const [users, setUsers] = useState([]);
  const [assetForm, setAssetForm] = useState({ name: '', timeoutMs: 3000 });
  const [newUser, setNewUser] = useState({ name: '', role: 'reviewer' });
  const [selJob, setSelJob] = useState(null);

  const load = async () => {
    setJobs(await api('/jobs?limit=50'));
    setAssets(await api('/assets'));
    setUsers(await api('/users'));
  };
  useEffect(() => { load().catch(errMsg); const t = setInterval(load, 2500); return () => clearInterval(t); }, []);

  const addAsset = async () => {
    await api('/assets', { method: 'POST', body: JSON.stringify(assetForm) });
    notify('素材已登记', 'success');
    setAssetForm({ name: '', timeoutMs: 3000 });
    load();
  };
  const process = async (id, forceTimeout, maxAttempts) => {
    try {
      const j = await api(`/assets/${id}/process`, { method: 'POST',
        body: JSON.stringify({ forceTimeout, maxAttempts }) });
      notify(`素材处理任务已入队 ${j.id.slice(0, 8)}（超时将退避重试）`, 'success');
    } catch (e) { errMsg(e); }
  };
  const addUser = async () => {
    await api('/users', { method: 'POST', body: JSON.stringify(newUser) });
    notify('用户已创建', 'success');
    setNewUser({ name: '', role: 'reviewer' });
    load();
  };

  return (
    <div>
      <div className="card">
        <h2>异步任务（持久队列）</h2>
        <div className="muted">任务保存在 SQLite 中，worker 租约执行；超时/崩溃后自动回收并指数退避重试，超过次数标记 dead。本地内置 worker 每 0.4s 轮询，也可由无服务器页面 tick 驱动。</div>
        <table className="jobs" style={{ marginTop: 8 }}>
          <thead><tr><th>类型</th><th>状态</th><th>尝试</th><th>入队时间</th><th>结果/错误</th><th></th></tr></thead>
          <tbody>
            {jobs.map(j => (
              <tr key={j.id}>
                <td>{j.type}<div className="mono muted">{j.id.slice(0, 12)}</div></td>
                <td><span className={`status-pill status-${j.status}`}>{j.status}</span>
                  {j.lease_owner && <div className="muted">{j.lease_owner}</div>}</td>
                <td>{j.attempts}/{j.max_attempts}</td>
                <td className="muted">{new Date(j.created_at).toLocaleTimeString('zh-CN')}</td>
                <td className="mono" style={{ maxWidth: 360 }}>
                  {j.result ? JSON.stringify(j.result).slice(0, 220)
                    : j.error ? <span style={{ color: '#b3261e' }}>{j.error.code}: {j.error.message}</span> : '—'}
                </td>
                <td><button className="btn small ghost" onClick={() => setSelJob(selJob === j.id ? null : j.id)}>详情</button></td>
              </tr>
            ))}
            {jobs.length === 0 && <tr><td colSpan={6} className="muted">暂无任务。去②脚本页触发"异步生成剪辑清单"，或在下方处理素材。</td></tr>}
          </tbody>
        </table>
        {selJob && (() => { const j = jobs.find(x => x.id === selJob); return j && <pre className="code">{JSON.stringify(j, null, 2)}</pre>; })()}
      </div>

      <div className="row">
        <div className="card col">
          <h2>素材处理（超时演练）</h2>
          <label>素材名称</label>
          <input type="text" value={assetForm.name} onChange={e => setAssetForm({ ...assetForm, name: e.target.value })} />
          <label>允许处理时长 timeoutMs（毫秒）</label>
          <input type="number" value={assetForm.timeoutMs} onChange={e => setAssetForm({ ...assetForm, timeoutMs: Number(e.target.value) })} />
          <button className="btn" onClick={addAsset}>登记素材</button>
          <table className="jobs" style={{ marginTop: 10 }}>
            <tbody>
              {assets.map(a => (
                <tr key={a.id}>
                  <td><b>{a.name}</b><div className="muted">限时 {a.timeoutMs}ms · 尝试 {a.attempts}</div></td>
                  <td><span className={`status-pill status-${a.status}`}>{a.status}</span></td>
                  <td className="pill-group">
                    <button className="btn small" onClick={() => process(a.id, false)}>正常处理</button>
                    <button className="btn small danger" onClick={() => process(a.id, true, 3)}>模拟超时</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="muted">模拟超时：任务处理超过素材限时 → 标记 timeout，队列退避（1s/2s/4s）重试 3 次后置为 dead。</div>
        </div>

        <div className="card col">
          <h2>用户与权限（发布时权限撤回演练）</h2>
          <label>姓名</label>
          <input type="text" value={newUser.name} onChange={e => setNewUser({ ...newUser, name: e.target.value })} />
          <label>角色</label>
          <select value={newUser.role} onChange={e => setNewUser({ ...newUser, role: e.target.value })}>
            <option value="editor">editor 编辑</option>
            <option value="reviewer">reviewer 复核</option>
            <option value="publisher">publisher 发布</option>
            <option value="admin">admin 管理员</option>
          </select>
          <button className="btn" onClick={addUser}>创建用户</button>
          <table className="jobs" style={{ marginTop: 10 }}>
            <tbody>
              {users.map(u => (
                <tr key={u.id}>
                  <td><b>{u.name}</b><div className="muted">{u.role}</div></td>
                  <td>{u.active ? <span className="status-pill status-succeeded">在职/有效</span>
                    : <span className="status-pill status-dead">已停用（权限撤回）</span>}</td>
                  <td>{u.active
                    ? <button className="btn small danger" onClick={async () => { await api(`/users/${u.id}/deactivate`, { method: 'POST' }); notify(`已撤回「${u.name}」权限`, 'success'); load(); }}>停用（撤回权限）</button>
                    : <button className="btn small" onClick={async () => { await api(`/users/${u.id}/activate`, { method: 'POST' }); load(); }}>恢复</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="muted">在②页取得发布令牌后、点击"发布"前停用发布人，即可验证发布瞬间的权限复核会拒绝发布。</div>
        </div>
      </div>
    </div>
  );
}
