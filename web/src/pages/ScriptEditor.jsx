import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { get, post, put, del } from '../api';

const SCENE_TYPES = { opening: '开场', conditions: '条件', materials: '材料', location: '办理地点', reminder: '必要提醒', other: '其他' };
const STMT_TYPES = { opening: '开场', condition: '条件', material: '材料', location: '办理地点', reminder: '必要办理提醒', other: '其他' };

function ReviewBadge({ review }) {
  if (review.state === 'approved') return <span className="badge green">已复核 · 依据R{review.basis_revision_no} · {review.reviewer_id}</span>;
  if (review.state === 'invalidated') return <span className="badge orange">待复核：{review.reason}</span>;
  return <span className="badge orange">待复核：尚未复核</span>;
}

export default function ScriptEditor() {
  const { id } = useParams();
  const [script, setScript] = useState(null);
  const [clausesByRev, setClausesByRev] = useState({});
  const [msg, setMsg] = useState(null);
  const [guardDlg, setGuardDlg] = useState(null); // {scene, reasons}
  const [guardReason, setGuardReason] = useState('');
  const [newScene, setNewScene] = useState({ scene_type: 'other', title: '' });
  const [newStmt, setNewStmt] = useState({}); // sceneId -> {stmt_type, paraphrase, citations:[]}

  const load = async () => {
    const r = await get(`/api/scripts/${id}`);
    if (r.status !== 200) { setMsg({ ok: false, text: '脚本不存在' }); return; }
    setScript(r.body.script);
    // 预取各场生效依据版本的条款（引用选择器用）
    const revIds = [...new Set(r.body.script.scenes.map(s => s.effective_revision_id))];
    const map = {};
    for (const rid of revIds) {
      const c = await get(`/api/revisions/${rid}/clauses`);
      map[rid] = c.body.clauses;
    }
    setClausesByRev(map);
  };
  useEffect(() => { load(); }, [id]);

  const saveScene = async (scene, patch) => {
    const r = await put(`/api/scenes/${scene.id}`, patch);
    if (r.status !== 200) setMsg({ ok: false, text: r.body?.message || '保存失败（需要 script.write 权限）' });
    load();
  };
  const removeScene = async (scene, ack, reason) => {
    const r = await del(`/api/scenes/${scene.id}`, ack ? { ack: true, reason } : undefined);
    if (r.status === 409 && r.body.error === 'guarded_delete') { setGuardDlg({ scene, reasons: r.body.reasons }); return; }
    if (r.status !== 200) setMsg({ ok: false, text: r.body?.message || '删除失败' });
    else setMsg({ ok: true, text: r.body.guarded ? '已删除（守卫确认，已留审计）' : '已删除' });
    setGuardDlg(null); setGuardReason(''); load();
  };
  const addStatement = async scene => {
    const st = newStmt[scene.id];
    if (!st || !st.paraphrase) return;
    const r = await post(`/api/scenes/${scene.id}/statements`, st);
    if (r.status !== 201) setMsg({ ok: false, text: r.body?.message || '新增陈述失败' });
    setNewStmt(s => ({ ...s, [scene.id]: { stmt_type: 'other', paraphrase: '', citations: [] } }));
    load();
  };
  const removeStatement = async stmtId => { await del(`/api/statements/${stmtId}`); load(); };
  const addScene = async () => {
    const r = await post(`/api/scripts/${id}/scenes`, newScene);
    if (r.status !== 201) setMsg({ ok: false, text: r.body?.message || '新增场次失败' });
    setNewScene({ scene_type: 'other', title: '' }); load();
  };
  const newVersion = async () => {
    const r = await post(`/api/scripts/${id}/versions`);
    setMsg(r.status === 201 ? { ok: true, text: `已创建草稿版本 v${r.body.version.version_no}` } : { ok: false, text: r.body?.message || '失败' });
    load();
  };

  if (!script) return <p className="muted">加载中…</p>;
  return (
    <div>
      <div className="card">
        <h3>{script.title} <span className="muted">｜政策：{script.policy.title}｜最新修订 R{script.latest_revision_no}</span></h3>
        <div className="row">
          <span className="muted">版本：{script.versions.map(v => `v${v.version_no}(${v.status})`).join('、')}</span>
          <button onClick={newVersion}>新建草稿版本</button>
        </div>
        {msg && <div className={`alert ${msg.ok ? 'okk' : 'err'}`}>{msg.text}</div>}
      </div>

      {guardDlg && (
        <div className="card" style={{ borderColor: '#f5c6c0' }}>
          <h3>删场守卫：不能悄悄删除必要办理提醒</h3>
          {guardDlg.reasons.map((r, i) => <div key={i} className="alert warn">{r}</div>)}
          <div className="row">
            <input style={{ flex: 1 }} placeholder="确认删除原因（必填，写入审计）" value={guardReason} onChange={e => setGuardReason(e.target.value)} />
            <button className="danger" disabled={!guardReason.trim()} onClick={() => removeScene(guardDlg.scene, true, guardReason)}>确认删除</button>
            <button onClick={() => { setGuardDlg(null); setGuardReason(''); }}>取消</button>
          </div>
        </div>
      )}

      {script.scenes.map(scene => (
        <div key={scene.id} className={`scene ${scene.missing_evidence.length ? 'head-warn' : ''}`}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div>
              <b>第{scene.scene_no}场</b> <span className="badge blue">{SCENE_TYPES[scene.scene_type] || scene.scene_type}</span>
              <input style={{ width: 180 }} defaultValue={scene.title} onBlur={e => e.target.value !== scene.title && saveScene(scene, { title: e.target.value })} />
            </div>
            <div className="row">
              <select value={scene.pin_mode} onChange={e => saveScene(scene, { pin_mode: e.target.value, pinned_revision_id: e.target.value === 'fixed' ? (scene.pinned_revision_id || script.latest_revision_id) : null })}>
                <option value="follow">跟随更新（草稿）</option>
                <option value="fixed">固定源文版本</option>
              </select>
              {scene.pin_mode === 'fixed' && (
                <select value={scene.pinned_revision_id || ''} onChange={e => saveScene(scene, { pinned_revision_id: Number(e.target.value) })}>
                  {script.revisions.map(r => <option key={r.id} value={r.id}>R{r.version_no}</option>)}
                </select>
              )}
              {scene.stale && <span className="badge purple">源文已有新版本（旧依据保留）</span>}
              <button className="danger" onClick={() => removeScene(scene)}>删场</button>
            </div>
          </div>
          <div className="row" style={{ margin: '6px 0' }}>
            <ReviewBadge review={scene.review} />
            {scene.missing_evidence.map((iss, i) => <span key={i} className="badge red">缺证据：{iss.message}</span>)}
          </div>

          {scene.statements.map(st => (
            <div key={st.id} className="stmt">
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <span className="badge gray">{STMT_TYPES[st.stmt_type]}</span>
                <button className="danger" onClick={() => removeStatement(st.id)}>删除陈述</button>
              </div>
              <div>{st.paraphrase}</div>
              <div className="muted">改写不是法律判断，依据以引用条款为准：</div>
              <div>
                {st.citations.length === 0 && <span className="chip missing">未引用条款（缺证据）</span>}
                {st.citations.map(c => (
                  <span key={c.clause_key} className={`chip ${c.exists ? '' : 'missing'}`} title={c.excerpt || '条款在当前依据版本中不存在'}>
                    {c.clause_key}{c.exists ? '' : '（不存在）'}
                  </span>
                ))}
              </div>
            </div>
          ))}

          {/* 新增陈述：引用只能选自生效依据版本的条款，系统不补造 */}
          <div className="stmt">
            <div className="row">
              <select value={(newStmt[scene.id] || {}).stmt_type || 'other'}
                onChange={e => setNewStmt(s => ({ ...s, [scene.id]: { ...(s[scene.id] || { citations: [] }), stmt_type: e.target.value } }))}>
                {Object.entries(STMT_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
              <input style={{ flex: 1 }} placeholder="改写陈述（不得超出引用条款的事实范围）"
                value={(newStmt[scene.id] || {}).paraphrase || ''}
                onChange={e => setNewStmt(s => ({ ...s, [scene.id]: { ...(s[scene.id] || { stmt_type: 'other', citations: [] }), paraphrase: e.target.value } }))} />
              <button onClick={() => addStatement(scene)}>添加陈述</button>
            </div>
            <div className="muted">选择引用条款（依据版本 #{scene.effective_revision_id}）：</div>
            <div>
              {(clausesByRev[scene.effective_revision_id] || []).map(c => {
                const cur = (newStmt[scene.id] || {}).citations || [];
                const on = cur.includes(c.clause_key);
                return (
                  <span key={c.clause_key} className="chip" style={{ cursor: 'pointer', background: on ? '#2563eb' : undefined, color: on ? '#fff' : undefined }}
                    title={c.text}
                    onClick={() => setNewStmt(s => {
                      const base = s[scene.id] || { stmt_type: 'other', paraphrase: '', citations: [] };
                      const citations = on ? cur.filter(k => k !== c.clause_key) : [...cur, c.clause_key];
                      return { ...s, [scene.id]: { ...base, citations } };
                    })}>
                    {c.clause_key}
                  </span>
                );
              })}
            </div>
          </div>

          <div className="grid" style={{ gridTemplateColumns: '1fr 1fr 1fr' }}>
            {[['subtitle', '字幕'], ['voiceover', '旁白'], ['shot_card', '镜头卡']].map(([f, label]) => (
              <div key={f}>
                <div className="muted">{label}{!scene[f] && <span className="badge red">缺失</span>}</div>
                <textarea style={{ minHeight: 52 }} defaultValue={scene[f]}
                  onBlur={e => e.target.value !== scene[f] && saveScene(scene, { [f]: e.target.value })} />
              </div>
            ))}
          </div>
        </div>
      ))}

      <div className="card">
        <h3>新增场次</h3>
        <div className="row">
          <select value={newScene.scene_type} onChange={e => setNewScene(s => ({ ...s, scene_type: e.target.value }))}>
            {Object.entries(SCENE_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <input placeholder="场次标题" value={newScene.title} onChange={e => setNewScene(s => ({ ...s, title: e.target.value }))} />
          <button className="primary" onClick={addScene} disabled={!newScene.title.trim()}>添加</button>
        </div>
      </div>
    </div>
  );
}
