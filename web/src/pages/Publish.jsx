import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { get, post } from '../api';

export default function Publish() {
  const [scripts, setScripts] = useState([]);
  const [policies, setPolicies] = useState([]);
  const [sel, setSel] = useState(null); // script detail
  const [newScript, setNewScript] = useState({ policy_id: '', title: '' });
  const [panels, setPanels] = useState({}); // versionId -> {validation, blockers, snapshot, artifacts, msg}
  const [msg, setMsg] = useState(null);

  const loadScripts = () => get('/api/scripts').then(r => setScripts(r.body.scripts));
  useEffect(() => { loadScripts(); get('/api/policies').then(r => setPolicies(r.body.policies)); }, []);
  const openScript = async id => { const r = await get(`/api/scripts/${id}`); setSel(r.body.script); setPanels({}); };
  const createScript = async () => {
    const r = await post('/api/scripts', { policy_id: Number(newScript.policy_id), title: newScript.title });
    if (r.status === 201) { setMsg({ ok: true, text: '脚本已创建' }); setNewScript({ policy_id: '', title: '' }); loadScripts(); }
    else setMsg({ ok: false, text: r.body?.message || '创建失败（需要 script.write 权限）' });
  };
  const setPanel = (vid, patch) => setPanels(p => ({ ...p, [vid]: { ...(p[vid] || {}), ...patch } }));

  const validate = async vid => {
    const r = await get(`/api/script-versions/${vid}/validate`);
    setPanel(vid, { validation: r.body.validation, blockers: r.body.gate.blockers });
  };
  const publish = async vid => {
    const r = await post(`/api/script-versions/${vid}/publish`);
    if (r.status === 200) { setPanel(vid, { msg: { ok: true, text: `发布成功，依据修订 #${r.body.version.basis_revision_id}，快照 #${r.body.snapshot_id}` } }); openScript(sel.id); }
    else setPanel(vid, { msg: { ok: false, text: r.body?.message || '发布失败' }, blockers: r.body?.blockers });
  };
  const snapshot = async vid => {
    const r = await get(`/api/script-versions/${vid}/snapshot`);
    setPanel(vid, { snapshot: r.status === 200 ? r.body.snapshot : { error: r.body?.message || '无快照' } });
  };
  const artifacts = async vid => {
    const r = await get(`/api/artifacts?script_version_id=${vid}`);
    setPanel(vid, { artifacts: r.body.artifacts });
  };
  const enqueueTask = async (type, vid) => {
    const r = await post('/api/tasks', { type, payload: { script_version_id: vid } });
    setPanel(vid, { msg: r.status === 201 ? { ok: true, text: `任务 #${r.body.task.id} 已入队，请到「异步任务」查看` } : { ok: false, text: r.body?.message || '入队失败' } });
  };

  return (
    <div>
      <div className="card">
        <h3>新建脚本</h3>
        <div className="row">
          <select value={newScript.policy_id} onChange={e => setNewScript(s => ({ ...s, policy_id: e.target.value }))}>
            <option value="">选择政策…</option>
            {policies.map(p => <option key={p.id} value={p.id}>{p.title}</option>)}
          </select>
          <input placeholder="脚本名称，如：《参保登记60秒》" value={newScript.title} onChange={e => setNewScript(s => ({ ...s, title: e.target.value }))} />
          <button className="primary" onClick={createScript} disabled={!newScript.policy_id || !newScript.title.trim()}>创建</button>
        </div>
        {msg && <div className={`alert ${msg.ok ? 'okk' : 'err'}`}>{msg.text}</div>}
      </div>

      <div className="card">
        <h3>选择脚本</h3>
        <div className="row">
          {scripts.map(s => (
            <button key={s.id} className={sel && sel.id === s.id ? 'primary' : ''} onClick={() => openScript(s.id)}>
              {s.title}（{s.policy.title}）
            </button>
          ))}
        </div>
        {sel && <p className="muted"><Link to={`/scripts/${sel.id}`}>进入场次编辑器 →</Link></p>}
      </div>

      {sel && sel.versions.map(v => {
        const p = panels[v.id] || {};
        return (
          <div key={v.id} className="card">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <div>
                <b>版本 v{v.version_no}</b>{' '}
                <span className={`badge ${v.status === 'published' ? 'green' : 'gray'}`}>{v.status}</span>
                {v.basis_revision_id && <span className="badge blue">依据修订 #{v.basis_revision_id}</span>}
                {v.published_at && <span className="muted">发布于 {v.published_at.slice(0, 19).replace('T', ' ')} by {v.published_by}</span>}
              </div>
              <div className="row">
                <button onClick={() => validate(v.id)}>导出校验</button>
                <button onClick={() => enqueueTask('generate_edit_list', v.id)}>剪辑清单任务</button>
                <button onClick={() => enqueueTask('generate_preview', v.id)}>预览包任务</button>
                <button onClick={() => artifacts(v.id)}>产物</button>
                {v.status === 'published'
                  ? <button onClick={() => snapshot(v.id)}>查看快照</button>
                  : <button className="primary" onClick={() => publish(v.id)}>发布</button>}
              </div>
            </div>
            {p.msg && <div className={`alert ${p.msg.ok ? 'okk' : 'err'}`}>{p.msg.text}</div>}
            {p.validation && (
              <div className={`alert ${p.validation.ok ? 'okk' : 'err'}`}>
                {p.validation.ok ? '导出校验通过（字幕/旁白/镜头卡/证据链齐备）' : (
                  <ul style={{ margin: 0 }}>{p.validation.errors.map((e, i) => <li key={i}>{e.message}</li>)}</ul>
                )}
              </div>
            )}
            {p.blockers && p.blockers.length > 0 && (
              <div className="alert warn">发布门禁拦截：
                <ul style={{ margin: 0 }}>{p.blockers.map((b, i) => <li key={i}>{b.reason}</li>)}</ul>
              </div>
            )}
            {p.artifacts && (
              <table><thead><tr><th>ID</th><th>类型</th><th>路径/内容</th><th>时间</th></tr></thead>
                <tbody>{p.artifacts.map(a => (
                  <tr key={a.id}><td>{a.id}</td><td>{a.kind}</td>
                    <td className="mono">{a.path || JSON.stringify(a.json).slice(0, 100)}</td>
                    <td className="mono">{a.created_at.slice(0, 19).replace('T', ' ')}</td></tr>
                ))}</tbody></table>
            )}
            {p.snapshot && !p.snapshot.error && (
              <div>
                <h4>发布快照（旧成果保留当时依据，条款原文已冻结）</h4>
                <pre className="json">{JSON.stringify(p.snapshot, null, 2)}</pre>
              </div>
            )}
            {p.snapshot && p.snapshot.error && <div className="alert err">{p.snapshot.error}</div>}
          </div>
        );
      })}
    </div>
  );
}
