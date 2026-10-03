import React, { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { get, post } from '../api';

const TYPE_BADGE = { added: 'green', removed: 'red', text_change: 'orange', date_change: 'purple', reorder: 'gray' };

export default function PolicyDetail() {
  const { id } = useParams();
  const [detail, setDetail] = useState(null);
  const [text, setText] = useState('');
  const [note, setNote] = useState('');
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [diff, setDiff] = useState(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [clauses, setClauses] = useState(null);

  const load = () => get(`/api/policies/${id}`).then(r => setDetail(r.body));
  useEffect(() => { load(); }, [id]);

  const submitRevision = async () => {
    setError(null); setResult(null);
    const r = await post(`/api/policies/${id}/revisions`, { text, note });
    if (r.status === 201) { setResult(r.body); setText(''); setNote(''); load(); }
    else setError(r.body?.message || '提交失败（需要 policy.write 权限）');
  };
  const runDiff = async () => {
    const r = await get(`/api/policies/${id}/diff?from=${from}&to=${to}`);
    setDiff(r.status === 200 ? r.body : { error: r.body?.message || '差异计算失败' });
  };
  const showClauses = async revId => {
    const r = await get(`/api/revisions/${revId}/clauses`);
    setClauses({ revId, list: r.body.clauses });
  };
  if (!detail) return <p className="muted">加载中…</p>;
  const { policy, revisions, scripts } = detail;
  return (
    <div>
      <div className="card">
        <h3>{policy.title}</h3>
        <p className="muted">脚本：
          {scripts.map(s => <Link key={s.id} to={`/scripts/${s.id}`} style={{ marginRight: 10 }}>{s.title}</Link>)}
          {scripts.length === 0 && '（暂无，可在发布与导出页创建）'}
        </p>
      </div>

      <div className="card">
        <h3>录入新修订（每行一条；支持「[材料] 第三条 ……」类别前缀；条款号自动识别）</h3>
        <textarea placeholder={'第一条 ……\n[条件] 第二条 ……\n[材料] 第三条 ……\n[地点] 第四条 ……\n[提醒] 第五条 ……'} value={text} onChange={e => setText(e.target.value)} />
        <div className="row" style={{ marginTop: 8 }}>
          <input placeholder="修订说明，如：参保期日期订正" value={note} onChange={e => setNote(e.target.value)} style={{ flex: 1 }} />
          <button className="primary" onClick={submitRevision} disabled={!text.trim()}>提交修订并计算影响</button>
        </div>
        {error && <div className="alert err">{error}</div>}
        {result && (
          <div className="alert okk">
            已生成 R{result.revision.version_no}：差异 {result.changes.length} 处；
            受影响脚本 {result.impact.affected_scripts.length} 个；复核失效 {result.impact.invalidated_reviews} 条。
            {result.impact.affected_scripts.map(s => (
              <div key={s.script_id} className="muted">受影响：{s.title} —— {s.scenes.map(sc => `第${sc.scene_no}场(${sc.effect === 'review_invalidated' ? '复核失效' : '固定源文保留'})`).join('、')}</div>
            ))}
          </div>
        )}
      </div>

      <div className="card">
        <h3>修订历史</h3>
        <table>
          <thead><tr><th>版本</th><th>说明</th><th>条款数</th><th>时间</th><th></th></tr></thead>
          <tbody>
            {revisions.map(r => (
              <tr key={r.id}>
                <td>R{r.version_no}</td><td>{r.note}</td><td>{r.clauses}</td>
                <td className="mono">{r.created_at.slice(0, 19).replace('T', ' ')}</td>
                <td><button onClick={() => showClauses(r.id)}>查看条款</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        {clauses && (
          <div style={{ marginTop: 10 }}>
            <h4>条款（修订 #{clauses.revId}）</h4>
            <table>
              <thead><tr><th>段</th><th>条款号</th><th>类别</th><th>原文</th></tr></thead>
              <tbody>{clauses.list.map(c => <tr key={c.id}><td>{c.para_index}</td><td>{c.clause_key}</td><td>{c.kind}</td><td>{c.text}</td></tr>)}</tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <h3>差异定位（段落重排 / 日期订正 / 文本修订）</h3>
        <div className="row">
          <select value={from} onChange={e => setFrom(e.target.value)}><option value="">从…</option>{revisions.map(r => <option key={r.id} value={r.id}>R{r.version_no}</option>)}</select>
          <select value={to} onChange={e => setTo(e.target.value)}><option value="">到…</option>{revisions.map(r => <option key={r.id} value={r.id}>R{r.version_no}</option>)}</select>
          <button onClick={runDiff} disabled={!from || !to}>比较</button>
        </div>
        {diff && !diff.error && (
          <table style={{ marginTop: 10 }}>
            <thead><tr><th>条款</th><th>类型</th><th>段落</th><th>旧文本</th><th>新文本</th></tr></thead>
            <tbody>
              {diff.changes.length === 0 && <tr><td colSpan="5" className="muted">无差异</td></tr>}
              {diff.changes.map((c, i) => (
                <tr key={i}>
                  <td>{c.clause_key}</td>
                  <td><span className={`badge ${TYPE_BADGE[c.change_type]}`}>{c.label}</span></td>
                  <td className="mono">{c.old_index ?? '—'} → {c.new_index ?? '—'}</td>
                  <td className="diff-old">{c.old_text || '—'}</td>
                  <td className="diff-new">{c.new_text || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {diff && diff.error && <div className="alert err">{diff.error}</div>}
      </div>
    </div>
  );
}
