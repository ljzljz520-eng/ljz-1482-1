import React, { useState, useEffect, useContext } from 'react';
import { api } from '../api.js';
import { ToastCtx } from '../App.jsx';

const KINDS = [
  { key: 'opening', label: '开场' },
  { key: 'conditions', label: '条件' },
  { key: 'materials', label: '材料' },
  { key: 'location', label: '办理地点' },
  { key: 'closing', label: '结尾' },
  { key: 'other', label: '其他' },
];
const NEEDS_EVIDENCE = ['opening', 'conditions', 'materials', 'location'];

const STATE_LABEL = {
  approved: '双人复核通过',
  needs_review: '待复核',
  missing_evidence: '缺证据',
  stale_reference: '待复核（依据已更新）',
};

export default function ScriptsTab() {
  const { notify, errMsg } = useContext(ToastCtx);
  const [sources, setSources] = useState([]);
  const [scripts, setScripts] = useState([]);
  const [sel, setSel] = useState(null);
  const [script, setScript] = useState(null);
  const [validation, setValidation] = useState(null);
  const [newScript, setNewScript] = useState({ title: '', sourceId: '', mode: 'following' });
  const [newScene, setNewScene] = useState({ kind: 'opening', title: '', clauseId: '', narration: '', subtitle: '', shotCard: '' });
  const [reviewer, setReviewer] = useState('复核员张三');
  const [release, setRelease] = useState(null);
  const [pkg, setPkg] = useState(null);

  const refresh = async () => {
    setSources(await api('/sources'));
    setScripts(await api('/scripts'));
  };
  useEffect(() => { refresh().catch(errMsg); }, []);
  const open = async id => {
    setSel(id); setRelease(null); setPkg(null);
    const s = await api('/scripts/' + id);
    setScript(s);
    setValidation(await api(`/scripts/${id}/validate`));
  };

  const createScript = async () => {
    try {
      const s = await api('/scripts', { method: 'POST', body: JSON.stringify(newScript) });
      notify(`脚本已创建（${s.mode === 'pinned' ? '固定源文版本' : '跟随更新'}）`, 'success');
      setNewScript({ title: '', sourceId: '', mode: 'following' });
      await refresh();
      open(s.id);
    } catch (e) { errMsg(e); }
  };

  const targetClauses = script?.targetRevision ? scriptClauses(script) : [];
  function scriptClauses(s) {
    // 条款列表从 source 当前打开接口不便；用场景中已有 + 单独拉
    return s._clauses || [];
  }
  useEffect(() => {
    if (script) api('/revisions/' + script.targetRevision.id).then(r => setScript(s => ({ ...s, _clauses: r.clauses })));
  }, [sel, script?.targetRevision?.id]);

  const addScene = async () => {
    try {
      await api(`/scripts/${sel}/scenes`, {
        method: 'POST',
        body: JSON.stringify({
          kind: newScene.kind, title: newScene.title || KINDS.find(k => k.key === newScene.kind).label + '场次',
          narration: newScene.narration, subtitle: newScene.subtitle, shotCard: newScene.shotCard,
          linkedClauseId: NEEDS_EVIDENCE.includes(newScene.kind) ? newScene.clauseId : (newScene.clauseId || null),
        }),
      });
      notify('场次已加入时间线', 'success');
      setNewScene({ kind: 'opening', title: '', clauseId: '', narration: '', subtitle: '', shotCard: '' });
      await open(sel);
    } catch (e) { errMsg(e); }
  };

  const updateSceneField = async (sceneId, body) => {
    try { await api('/scenes/' + sceneId, { method: 'PATCH', body: JSON.stringify(body) }); await open(sel); }
    catch (e) { errMsg(e); await open(sel); }
  };

  const removeScene = async sc => {
    let reason = null;
    if (NEEDS_EVIDENCE.includes(sc.kind)) {
      reason = window.prompt(`「${sc.kindLabel}」属于必要办理提醒，删除必须填写原因：\n` +
        `（若依据条款仍有效且无替代场次，系统将拒绝删除）`, sc.state.status === 'stale_reference' ? '依据条款已更新，重写后替换' : '');
      if (!reason) { notify('已取消：必要场次删除必须填写原因', 'error'); return; }
    }
    try { await api('/scenes/' + sc.id, { method: 'DELETE', body: JSON.stringify({ reason }) }); notify('场次已删除（含原因留痕）', 'success'); await open(sel); }
    catch (e) { errMsg(e); }
  };

  const move = async (id, dir) => { try { await api(`/scenes/${id}/move`, { method: 'POST', body: JSON.stringify({ dir }) }); await open(sel); } catch (e) { errMsg(e); } };

  const review = async (id, decision) => {
    const comment = window.prompt(`${decision === 'approved' ? '通过' : '驳回'}复核意见（可留空）：`, decision === 'rejected' ? '陈述与条款表述不一致，需修改' : '');
    try {
      const r = await api(`/scenes/${id}/reviews`, {
        method: 'POST', body: JSON.stringify({ reviewer, decision, comment }),
      });
      notify(`${reviewer} 已${decision === 'approved' ? '通过' : '驳回'}：当前状态「${STATE_LABEL[r.sceneState.status]}」（${r.sceneState.reviewerCount}/2 人）`, 'success');
      await open(sel);
    } catch (e) { errMsg(e); }
  };

  const rebase = async mode => {
    try { await api(`/scripts/${sel}/rebase`, { method: 'POST', body: JSON.stringify({ mode }) });
      notify(mode === 'following' ? '已改为跟随最新版本，相关场次按引用关系重新判定复核' : '已固定到当前版本', 'success');
      await open(sel);
    } catch (e) { errMsg(e); }
  };

  const exportPreview = async () => {
    try { const p = await api(`/scripts/${sel}/export-preview`, { method: 'POST' }); setPkg(p); } catch (e) { errMsg(e); }
  };

  const enqueueExport = async () => {
    try { const j = await api(`/scripts/${sel}/jobs/export`, { method: 'POST', body: {} });
      notify(`剪辑清单生成任务已入队：${j.id.slice(0, 8)}（可在③页查看）`, 'success');
    } catch (e) { errMsg(e); }
  };

  const publish = async () => {
    const publisher = window.prompt('发布人（需 publisher/admin 角色）：', '发布员王五');
    if (!publisher) return;
    try {
      const intent = await api(`/scripts/${sel}/publish-intent`, { method: 'POST', body: JSON.stringify({ publisher }) });
      const proceed = window.confirm('发布校验通过，已取得一次性发布令牌。\n' +
        '提示：现在可到"③ 异步任务/素材"或用户管理中停用该发布人，以演练"发布时权限撤回"。\n\n点击确定立即发布。');
      if (!proceed) { notify('保留发布令牌，稍后可重试发布（令牌10分钟有效）'); return; }
      const r = await api(`/scripts/${sel}/publish`, {
        method: 'POST', body: JSON.stringify({ publisher, permissionToken: intent.permissionToken }),
      });
      notify(`新版本 v${r.version} 已发布，快照已固定（依据 revision ${r.basisRevision.slice(0, 8)}）`, 'success');
      setRelease(await api(`/scripts/${sel}/releases/${r.version}`));
      await refresh(); await open(sel);
    } catch (e) { errMsg(e); }
  };

  if (!sources.length) return <div className="card">请先到「① 政策来源与修订」录入政策材料。</div>;

  return (
    <div className="row">
      <div className="col" style={{ maxWidth: 340 }}>
        <div className="card">
          <h2>新建脚本</h2>
          <label>脚本标题</label>
          <input type="text" value={newScript.title} onChange={e => setNewScript({ ...newScript, title: e.target.value })} />
          <label>政策来源</label>
          <select value={newScript.sourceId} onChange={e => setNewScript({ ...newScript, sourceId: e.target.value })}>
            <option value="">选择来源…</option>
            {sources.map(s => <option key={s.id} value={s.id}>{s.title}</option>)}
          </select>
          <label>版本机制</label>
          <select value={newScript.mode} onChange={e => setNewScript({ ...newScript, mode: e.target.value })}>
            <option value="following">跟随更新（草稿跟随源文最新版，更新后相关场次重新复核）</option>
            <option value="pinned">固定源文版本（锁定当时依据，不自动更新）</option>
          </select>
          <button className="btn" onClick={createScript}>创建</button>
        </div>
        <div className="card">
          <h2>脚本列表</h2>
          {scripts.map(s => (
            <div key={s.id} className={`source-item ${sel === s.id ? 'sel' : ''}`} onClick={() => open(s.id)}>
              <strong>{s.title}</strong>
              <div style={{ marginTop: 4 }}>
                <span className={`badge ${s.status}`}>{s.statusLabel}</span>
                <span className={`badge ${s.mode}`}>{s.mode === 'pinned' ? '固定' : '跟随'}</span>
                {s.publishedVersion > 0 && <span className="badge published">已发布 v{s.publishedVersion}</span>}
              </div>
              {s.affectedSceneIds.length > 0 && <div className="muted" style={{ color: '#c25016' }}>⚠ {s.affectedSceneIds.length} 个场次依据已更新，待复核</div>}
            </div>
          ))}
        </div>
      </div>

      <div className="col">
        {!script ? <div className="card muted">← 选择或创建一个脚本。</div> : (
          <>
            <div className="card">
              <h2>{script.title}
                <span className={`badge ${script.mode}`}>{script.mode === 'pinned' ? '固定源文版本' : '跟随更新'}</span>
                <span className={`badge ${script.status}`}>{script.statusLabel}</span>
                {script.publishedVersion > 0 && <span className="badge published">线上 v{script.publishedVersion}</span>}
              </h2>
              <div className="muted">
                依据：{script.source.title} · 目标版本 v{script.targetRevision.version}
                {script.baseRevision && script.baseRevision.id !== script.targetRevision.id &&
                  `（初始依据 v${script.baseRevision.version}）`}
              </div>
              <div style={{ marginTop: 8 }}>
                {script.mode === 'following'
                  ? <button className="btn small ghost" onClick={() => rebase('pinned')}>锁定为固定版本</button>
                  : <button className="btn small ghost" onClick={() => rebase('following')}>升级并跟随最新版本</button>}
              </div>
              {script.pendingReasons.length > 0 && (
                <div className="warning-banner" style={{ marginTop: 10 }}>
                  <b>缺证据 / 待复核原因（{script.pendingReasons.length}）</b>
                  <ul className="reasons">
                    {script.pendingReasons.map((p, i) => (
                      <li key={i}>第{p.sceneId ? script.scenes.find(x => x.id === p.sceneId)?.order : '?'}场 {p.kind}「{p.title}」
                        — {p.reasons.join('；')}</li>
                    ))}
                  </ul>
                </div>
              )}
              {script.allApproved && <div className="success-banner" style={{ marginTop: 10 }}>所有必要场次均双人复核通过且依据有效，可发布。</div>}
            </div>

            <div className="card">
              <h3>时间线场次</h3>
              {script.scenes.map(sc => (
                <SceneCard key={sc.id} sc={sc} clauses={script._clauses || []}
                  onMove={move} onRemove={removeScene} onReview={review}
                  reviewer={reviewer} setReviewer={setReviewer}
                  onEdit={updateSceneField} />
              ))}
            </div>

            <div className="card">
              <h3>新增场次</h3>
              <div className="kind-tabs">
                {KINDS.map(k => <button key={k.key} className={newScene.kind === k.key ? 'on' : ''}
                  onClick={() => setNewScene({ ...newScene, kind: k.key, clauseId: '' })}>{k.label}</button>)}
              </div>
              {NEEDS_EVIDENCE.includes(newScene.kind)
                ? <div className="info-banner">「{KINDS.find(k => k.key === newScene.kind).label}」陈述必须绑定具体条款，改写不是法律判断，系统不会自动补造条件或地址。</div>
                : <div className="muted">该类型不强制条款引用。</div>}
              <div className="row">
                <div className="col">
                  <label>场次标题</label>
                  <input type="text" value={newScene.title} onChange={e => setNewScene({ ...newScene, title: e.target.value })} />
                  {NEEDS_EVIDENCE.includes(newScene.kind) && <>
                    <label>引用条款 *</label>
                    <select value={newScene.clauseId} onChange={e => setNewScene({ ...newScene, clauseId: e.target.value })}>
                      <option value="">选择条款…</option>
                      {(script._clauses || []).map(c => <option key={c.id} value={c.id}>{c.ref}：{c.title}</option>)}
                    </select>
                  </>}
                </div>
                <div className="col">
                  <label>旁白 narration</label>
                  <textarea rows={2} value={newScene.narration} onChange={e => setNewScene({ ...newScene, narration: e.target.value })} />
                  <label>字幕 subtitle</label>
                  <textarea rows={2} value={newScene.subtitle} onChange={e => setNewScene({ ...newScene, subtitle: e.target.value })} />
                  <label>镜头卡 shot card</label>
                  <textarea rows={2} value={newScene.shotCard} onChange={e => setNewScene({ ...newScene, shotCard: e.target.value })} />
                </div>
              </div>
              <button className="btn" onClick={addScene}>加入时间线</button>
            </div>

            <div className="card">
              <h3>导出校验与发布</h3>
              {validation && (
                <div>
                  {validation.ok
                    ? <div className="success-banner">校验通过：字幕 / 旁白 / 镜头卡三轨齐全，证据链完整，双人复核完成。警告 {validation.warnings.length} 条。</div>
                    : <div className="warning-banner">
                        <b>{validation.errors.length} 条阻断性问题：</b>
                        <ul className="reasons">{validation.errors.map((e, i) => <li key={i}>{e.message}</li>)}</ul>
                      </div>}
                  {validation.warnings.length > 0 && <details><summary className="muted">{validation.warnings.length} 条警告</summary>
                    <ul className="reasons">{validation.warnings.map((e, i) => <li key={i}>{e.message}</li>)}</ul></details>}
                </div>
              )}
              <div className="pill-group">
                <button className="btn ghost" onClick={exportPreview}>生成预览包（同步查看）</button>
                <button className="btn ghost" onClick={enqueueExport}>异步生成剪辑清单+预览包（入队）</button>
                <button className="btn" onClick={publish} disabled={!validation?.ok}>申请发布并发布新版本</button>
              </div>
              {pkg && (
                <details style={{ marginTop: 10 }} open>
                  <summary>预览包（{pkg.editList.length} 场，SRT {pkg.preview.srt.split('\n').length} 行）</summary>
                  <pre className="code">{pkg.preview.srt}</pre>
                  <pre className="code">{JSON.stringify(pkg.editList, null, 1)}</pre>
                </details>
              )}
              {release && (
                <div className="success-banner" style={{ marginTop: 10 }}>
                  已发布 v{release.version}：快照中固定了 {release.snapshot.basisRevision.clauses.length} 条当时依据条款，
                  源文后续更新不会改动本版本。
                  <pre className="code">{release.export_bundle_path}</pre>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function SceneCard({ sc, clauses, onMove, onRemove, onReview, onEdit, reviewer, setReviewer }) {
  const { notify, errMsg } = useContext(ToastCtx);
  const [editing, setEditing] = useState(false);
  const [f, setF] = useState({ subtitle: sc.subtitle, narration: sc.narration, shotCard: sc.shotCard, clauseId: sc.linkedClauseId || '' });
  useEffect(() => setF({ subtitle: sc.subtitle, narration: sc.narration, shotCard: sc.shotCard, clauseId: sc.linkedClauseId || '' }), [sc.id]);

  const save = async () => {
    const body = { subtitle: f.subtitle, narration: f.narration, shotCard: f.shotCard };
    if (f.clauseId !== sc.linkedClauseId) body.linkedClauseId = f.clauseId || null;
    try {
      await onEdit(sc.id, body);
      setEditing(false);
      notify('场次已更新（内容变更将使旧版本复核失效，需重新双人复核）', 'success');
    } catch (e) { errMsg(e); }
  };

  return (
    <div className={`scene-card ${sc.deleted ? 'deleted' : ''}`}>
      <div className="scene-head">
        <span className="order">{sc.order}</span>
        <strong>{sc.title}</strong>
        <span className="badge draft">{sc.kindLabel}</span>
        {!sc.deleted && sc.state && (
          <span className={`scene-state ${sc.state.status}`}>{STATE_LABEL[sc.state.status] || sc.state.status}</span>
        )}
        {sc.deleted && <span className="scene-state deleted">已删除</span>}
        <span style={{ marginLeft: 'auto' }} className="pill-group">
          {!sc.deleted && <>
            <button className="btn small ghost" onClick={() => onMove(sc.id, 'up')}>↑</button>
            <button className="btn small ghost" onClick={() => onMove(sc.id, 'down')}>↓</button>
            <button className="btn small ghost" onClick={() => setEditing(e => !e)}>{editing ? '收起' : '编辑'}</button>
            <button className="btn small danger" onClick={() => onRemove(sc)}>删除</button>
          </>}
        </span>
      </div>

      {sc.deleted ? (
        <div className="muted" style={{ marginTop: 6 }}>删除原因：{sc.deleteReason}（{new Date(sc.deletedAt).toLocaleString('zh-CN')}）</div>
      ) : (
        <>
          <div style={{ marginTop: 6 }}>
            <div><b>旁白：</b>{sc.narration || <span className="muted">（空）</span>}</div>
            <div><b>字幕：</b>{sc.subtitle || <span className="muted">（空）</span>}</div>
            <div><b>镜头卡：</b>{sc.shotCard || <span className="muted">（空）</span>}</div>
          </div>

          <div className={`evidence-box ${sc.state.evidenceStatus === 'missing' ? 'missing' : sc.state.evidenceStatus === 'stale' ? 'stale' : ''}`}>
            {sc.linkedRef
              ? <>溯源：<b>{sc.linkedRef}</b> <span className="mono">{sc.linkedFingerprint}</span>（内容版本 v{sc.contentVersion}）
                  <div className="evidence-text">{sc.linkedClauseText || '（条款在新版本中位置变化，内容指纹一致）'}</div>
                </>
              : <><b>无条款引用</b>（{sc.kindLabel}为必要类型时不可发布）</>}
            <ul className="reasons">{sc.state.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>
          </div>

          {editing && (
            <div style={{ marginTop: 8 }}>
              {sc.state.required && <>
                <label>改引条款{sc.state.evidenceStatus === 'stale' && <span style={{ color: '#c25016' }}>（当前依据已失效，请改引到新版本对应条款）</span>}</label>
                <select value={clauses.some(c => c.id === f.clauseId) ? f.clauseId : (f.clauseId ? '__missing__' : '')} onChange={e => setF({ ...f, clauseId: e.target.value })}>
                  <option value="">选择条款…</option>
                  {f.clauseId && !clauses.some(c => c.id === f.clauseId) &&
                    <option value="__missing__">⚠ 原引用条款不在目标版本（{sc.linkedRef || '旧版'}）</option>}
                  {clauses.map(c => <option key={c.id} value={c.id}>{c.ref}：{c.title}</option>)}
                </select>
              </>}
              <label>旁白</label>
              <textarea rows={2} value={f.narration} onChange={e => setF({ ...f, narration: e.target.value })} />
              <label>字幕</label>
              <textarea rows={2} value={f.subtitle} onChange={e => setF({ ...f, subtitle: e.target.value })} />
              <label>镜头卡</label>
              <textarea rows={2} value={f.shotCard} onChange={e => setF({ ...f, shotCard: e.target.value })} />
              <button className="btn small" onClick={save}>保存修改</button>
            </div>
          )}

          <div className="row" style={{ marginTop: 8, alignItems: 'center' }}>
            <input type="text" value={reviewer} onChange={e => setReviewer(e.target.value)}
              style={{ width: 150 }} placeholder="复核人姓名" />
            <button className="btn small" onClick={() => onReview(sc.id, 'approved')}
              disabled={sc.state.status === 'missing_evidence' || sc.state.status === 'stale_reference'}>复核通过</button>
            <button className="btn small danger" onClick={() => onReview(sc.id, 'rejected')}>驳回</button>
            <span className="muted">
              已通过：{sc.state.reviews.length > 0
                ? sc.state.reviews.map(r => `${r.reviewer}`).join('、')
                : '无'}（需 2 名不同复核人）
            </span>
          </div>
        </>
      )}
    </div>
  );
}
