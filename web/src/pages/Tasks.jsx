import React, { useEffect, useState } from 'react';
import { get, post } from '../api';

const STATUS_BADGE = { queued: 'blue', running: 'purple', done: 'green', failed: 'red', timeout: 'orange' };

export default function Tasks() {
  const [tasks, setTasks] = useState([]);
  const [scripts, setScripts] = useState([]);
  const [versions, setVersions] = useState([]);
  const [form, setForm] = useState({ script_id: '', script_version_id: '', material: '片头动画.mp4', duration_ms: 3000, timeout_ms: 1000 });
  const [msg, setMsg] = useState(null);
  const load = () => {
    get('/api/tasks').then(r => setTasks(r.body.tasks));
    get('/api/scripts').then(r => setScripts(r.body.scripts));
  };
  useEffect(() => { load(); const t = setInterval(load, 3000); return () => clearInterval(t); }, []);
  const pickScript = async sid => {
    setForm(f => ({ ...f, script_id: sid, script_version_id: '' }));
    if (!sid) return setVersions([]);
    const r = await get(`/api/scripts/${sid}`);
    setVersions(r.body.script.versions);
  };

  const enqueue = async (type, payload, timeout_ms) => {
    const r = await post('/api/tasks', { type, payload, timeout_ms });
    setMsg(r.status === 201 ? { ok: true, text: `任务 #${r.body.task.id} 已入队` } : { ok: false, text: r.body?.message || '入队失败（需要 task.run 权限）' });
    load();
  };
  const retry = async id => { await post(`/api/tasks/${id}/retry`, {}); load(); };

  return (
    <div>
      <div className="card">
        <h3>发起异步任务（持久队列：本地 worker 执行；无服务器页面可经 /api/queue/claim 接入）</h3>
        <div className="row">
          <select value={form.script_id} onChange={e => pickScript(e.target.value)}>
            <option value="">选择脚本…</option>
            {scripts.map(s => <option key={s.id} value={s.id}>{s.title}</option>)}
          </select>
          <select value={form.script_version_id} onChange={e => setForm(f => ({ ...f, script_version_id: e.target.value }))}>
            <option value="">选择版本…</option>
            {versions.map(v => <option key={v.id} value={v.id}>v{v.version_no}（{v.status}）</option>)}
          </select>
          <button onClick={() => enqueue('generate_edit_list', { script_version_id: Number(form.script_version_id) })} disabled={!form.script_version_id}>生成剪辑清单</button>
          <button onClick={() => enqueue('generate_preview', { script_version_id: Number(form.script_version_id) })} disabled={!form.script_version_id}>生成预览包</button>
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          <input style={{ width: 180 }} value={form.material} onChange={e => setForm(f => ({ ...f, material: e.target.value }))} />
          <label className="muted">耗时(ms)<input type="number" style={{ width: 90, marginLeft: 4 }} value={form.duration_ms} onChange={e => setForm(f => ({ ...f, duration_ms: Number(e.target.value) }))} /></label>
          <label className="muted">超时(ms)<input type="number" style={{ width: 90, marginLeft: 4 }} value={form.timeout_ms} onChange={e => setForm(f => ({ ...f, timeout_ms: Number(e.target.value) }))} /></label>
          <button onClick={() => enqueue('process_material', { name: form.material, duration_ms: form.duration_ms }, form.timeout_ms)}>素材处理（演示超时）</button>
        </div>
        {msg && <div className={`alert ${msg.ok ? 'okk' : 'err'}`}>{msg.text}</div>}
        <p className="muted">提示：把「耗时」调大于「超时」即可复现素材处理超时；超时任务可重试。</p>
      </div>
      <div className="card">
        <h3>任务列表</h3>
        <table>
          <thead><tr><th>ID</th><th>类型</th><th>状态</th><th>尝试</th><th>超时(ms)</th><th>错误/结果</th><th>时间</th><th></th></tr></thead>
          <tbody>
            {tasks.map(t => (
              <tr key={t.id}>
                <td>{t.id}</td><td>{t.type}</td>
                <td><span className={`badge ${STATUS_BADGE[t.status]}`}>{t.status}</span></td>
                <td>{t.attempts}/{t.max_attempts}</td><td>{t.timeout_ms}</td>
                <td className="mono">{t.error || (t.result ? JSON.stringify(t.result).slice(0, 80) : '')}</td>
                <td className="mono">{t.updated_at.slice(0, 19).replace('T', ' ')}</td>
                <td>{['failed', 'timeout'].includes(t.status) && <button onClick={() => retry(t.id)}>重试</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
