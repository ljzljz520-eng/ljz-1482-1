import React, { useState, useEffect, useContext } from 'react';
import { api } from '../api.js';
import { ToastCtx } from '../App.jsx';

const TYPE_LABEL = {
  added: '新增', removed: '删除', changed: '改写',
  date_changed: '日期订正', reordered: '段落重排', unchanged: '未变',
};

export default function SourcesTab({ goScripts }) {
  const { notify, errMsg } = useContext(ToastCtx);
  const [sources, setSources] = useState([]);
  const [sel, setSel] = useState(null);
  const [detail, setDetail] = useState(null);
  const [revision, setRevision] = useState(null);
  const [form, setForm] = useState({ title: '', issuer: '', docNo: '', rawText: '', note: '' });
  const [revText, setRevText] = useState('');
  const [revNote, setRevNote] = useState('');
  const [preview, setPreview] = useState(null);

  const load = async () => setSources(await api('/sources'));
  useEffect(() => { load().catch(errMsg); }, []);

  const openSource = async id => {
    setSel(id);
    const d = await api('/sources/' + id);
    setDetail(d);
    if (d.current_revision_id) {
      const r = await api('/revisions/' + d.current_revision_id);
      setRevision(r);
    } else setRevision(null);
  };

  const create = async () => {
    try {
      const rev = await api('/sources', { method: 'POST', body: JSON.stringify(form) });
      notify('政策来源已创建，初始版本 v' + rev.version, 'success');
      setForm({ title: '', issuer: '', docNo: '', rawText: '', note: '' });
      await load();
      await openSource(rev.id || sources[0]?.id);
    } catch (e) { errMsg(e); }
  };

  const addRevision = async () => {
    if (!sel) return;
    try {
      const r = await api(`/sources/${sel}/revisions`, {
        method: 'POST', body: JSON.stringify({ rawText: revText, note: revNote }),
      });
      const s = r.diff?.summary || {};
      notify(`新版本 v${r.version} 已创建：新增${s.added||0} 删除${s.removed||0} 改写${s.changed||0} ` +
        `日期订正${s.dateChanged||0} 重排${s.reordered||0}；` +
        `${r.diff?.invalidatedFingerprints?.length || 0} 个条款引用的复核已标记失效`, 'success');
      setRevText(''); setRevNote('');
      await openSource(sel);
    } catch (e) { errMsg(e); }
  };

  const doPreview = async () => {
    const r = await api('/parse-preview', { method: 'POST', body: JSON.stringify({ rawText: form.rawText }) });
    setPreview(r.clauses);
  };

  return (
    <div className="row">
      <div className="col" style={{ maxWidth: 360 }}>
        <div className="card">
          <h2>政策来源列表</h2>
          {sources.length === 0 && <div className="muted">暂无来源，请在右侧录入政策材料。</div>}
          {sources.map(s => (
            <div key={s.id} className={`source-item ${sel === s.id ? 'sel' : ''}`} onClick={() => openSource(s.id)}>
              <strong>{s.title}</strong>
              <div className="muted">{s.issuer || '未标注发文机关'} · {s.doc_no || '无文号'}</div>
              <div className="muted">版本数 {s.revision_count} · {new Date(s.updated_at).toLocaleString('zh-CN')}</div>
            </div>
          ))}
        </div>
        <div className="card">
          <h2>录入新政策材料</h2>
          <label>政策标题 *</label>
          <input type="text" value={form.title} onChange={e => setForm({ ...form, title: e.target.value })}
            placeholder="例：某县种粮补贴申领政策" />
          <label>发文机关</label>
          <input type="text" value={form.issuer} onChange={e => setForm({ ...form, issuer: e.target.value })} />
          <label>文号</label>
          <input type="text" value={form.docNo} onChange={e => setForm({ ...form, docNo: e.target.value })} />
          <label>政策原文 *（条款按空行分隔，支持 第一条 / 一、 / 1. 等格式）</label>
          <textarea rows={8} value={form.rawText} onChange={e => setForm({ ...form, rawText: e.target.value })}
            placeholder={'第一条 补贴对象……\n\n第二条 申请条件……\n\n第三条 申请材料……'} />
          <button className="btn ghost" onClick={doPreview}>预览条款切分</button>
          {preview && (
            <div style={{ marginTop: 8 }}>
              {preview.map(c => (
                <div key={c.order} className="muted">§ {c.ref} <span className="mono">{c.fingerprint.slice(0, 10)}</span>
                  {c.dates.length > 0 && <> · 日期 {c.dates.join(', ')}</>}
                </div>
              ))}
            </div>
          )}
          <div><button className="btn" onClick={create}>创建来源与初版</button></div>
        </div>
      </div>

      <div className="col">
        {!detail ? (
          <div className="card muted">← 选择或创建一个政策来源，查看版本、条款与差异定位。</div>
        ) : (
          <>
            <div className="card">
              <h2>{detail.title}
                <span className="badge following">当前 v{detail.currentRevision?.version ?? '-'}</span>
                <button className="btn small ghost" style={{ float: 'right' }} onClick={goScripts}>去编排脚本 →</button>
              </h2>
              <div className="muted">{detail.issuer} {detail.doc_no} · 共 {detail.revisions.length} 个修订版本</div>
            </div>

            {revision?.diff && (
              <div className="card">
                <h3>v{revision.version} 相对上一版的差异定位</h3>
                {(() => {
                  const s = revision.diff.summary;
                  return (
                    <div className="pill-group">
                      <span className="badge ready">重排 {s.reordered}</span>
                      <span className="badge evidence_issue">删除 {s.removed}</span>
                      <span className="badge evidence_issue">改写 {s.changed}</span>
                      <span className="badge evidence_issue">日期订正 {s.dateChanged}</span>
                      <span className="badge draft">新增 {s.added}</span>
                      <span className="muted">失效指纹 {revision.diff.invalidatedFingerprints.length} 个</span>
                    </div>
                  );
                })()}
                {revision.diff.reorderedOnly && (
                  <div className="info-banner" style={{ marginTop: 10 }}>
                    本次仅为<b>段落重排</b>：条款内容指纹未变，已通过的复核<b>不失效</b>，脚本引用自动按指纹对齐。
                  </div>
                )}
                {revision.diff.invalidatedFingerprints.length > 0 && (
                  <div className="warning-banner" style={{ marginTop: 10 }}>
                    {revision.diff.invalidatedFingerprints.length} 个被引用条款的内容发生变化/删除，
                    跟随该来源的草稿中相关场次进入<b>待复核</b>；固定版本脚本不受影响。
                  </div>
                )}
                <div style={{ marginTop: 10 }}>
                  {revision.diff.changes.map((c, i) => (
                    <div key={i} className={`diff-item ${c.type}`}>
                      <span className="diff-tag">[{TYPE_LABEL[c.type] || c.type}]</span>
                      <b>{c.ref}</b>
                      {c.type === 'reordered' && <> 位置 {c.oldOrder} → {c.newOrder}（内容未变，审核不失效）</>}
                      {c.type === 'date_changed' && (
                        <div>
                          <div style={{ color: '#b3261e' }}>原日期：{c.oldDates.join(', ') || '（无）'}</div>
                          <div style={{ color: '#1c7c43' }}>订正为：{c.newDates.join(', ')}</div>
                        </div>
                      )}
                      {(c.type === 'changed' || c.type === 'added' || c.type === 'removed') && (
                        <div className="evidence-text">
                          {c.type === 'changed' && <><s>{c.oldText}</s><br />→ {c.newText}</>}
                          {c.type === 'added' && c.newText}
                          {c.type === 'removed' && c.oldText}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="card">
              <h3>当前版本条款（{revision?.clauses.length || 0} 条）</h3>
              {revision?.clauses.map(c => (
                <div key={c.id} className="diff-item unchanged">
                  <b>{c.ref}</b> <span className="mono muted">{c.fingerprint}</span>
                  {c.dates.length > 0 && <span className="badge draft" style={{ marginLeft: 8 }}>{c.dates.join(', ')}</span>}
                  <div className="evidence-text">{c.text}</div>
                </div>
              ))}
            </div>

            <div className="card">
              <h3>提交新修订（政策更新）</h3>
              <label>修订说明</label>
              <input type="text" value={revNote} onChange={e => setRevNote(e.target.value)}
                placeholder="例：办理日期订正；条款顺序调整；新增第五条" />
              <label>新版政策原文 *</label>
              <textarea rows={6} value={revText} onChange={e => setRevText(e.target.value)} />
              <button className="btn" onClick={addRevision} disabled={!revText.trim()}>保存为新版本并计算差异</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
