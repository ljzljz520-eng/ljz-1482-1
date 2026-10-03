import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { get, post } from '../api';

export default function ReviewCenter() {
  const [queue, setQueue] = useState(null);
  const [comments, setComments] = useState({});
  const [messages, setMessages] = useState({});
  const load = () => get('/api/review-queue').then(r => setQueue(r.body.queue));
  useEffect(() => { load(); }, []);

  const submit = async (item, decision) => {
    const r = await post(`/api/scenes/${item.scene_id}/review`, {
      decision, comment: comments[item.scene_id] || '', expected_basis: item.effective_revision_id,
    });
    if (r.status === 201) { setMessages(m => ({ ...m, [item.scene_id]: { ok: true, text: decision === 'approved' ? '已通过' : '已驳回' } })); load(); }
    else if (r.status === 409) setMessages(m => ({ ...m, [item.scene_id]: { ok: false, text: `冲突：${r.body.message}（他人已提交或依据已变化，请刷新）` } }));
    else if (r.status === 422) setMessages(m => ({ ...m, [item.scene_id]: { ok: false, text: `缺证据：${(r.body.issues || []).map(i => i.message).join('；')}` } }));
    else setMessages(m => ({ ...m, [item.scene_id]: { ok: false, text: r.body?.message || '失败（需要 review 权限）' } }));
  };

  if (!queue) return <p className="muted">加载中…</p>;
  return (
    <div>
      <div className="card">
        <h3>待复核队列（含缺证据与待复核原因）</h3>
        {queue.length === 0 && <p className="muted">当前没有待处理场次 🎉</p>}
        {queue.map(item => (
          <div key={item.scene_id} className="scene head-warn">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <div>
                <b>第{item.scene_no}场 · {item.title}</b>
                <span className="muted">　{item.script_title}（{item.policy_title}）</span>
                <Link to={`/scripts/${item.script_id}`} style={{ marginLeft: 8 }}>去编辑 →</Link>
              </div>
              <span className="badge blue">依据 R{item.effective_revision_no}</span>
            </div>
            <div style={{ margin: '8px 0' }}>
              {item.reasons.map((r, i) => (
                <span key={i} className={`badge ${/缺证据|不存在/.test(r) ? 'red' : 'orange'}`}>{r}</span>
              ))}
            </div>
            <div className="row">
              <input placeholder="复核意见" style={{ flex: 1 }} value={comments[item.scene_id] || ''}
                onChange={e => setComments(c => ({ ...c, [item.scene_id]: e.target.value }))} />
              <button className="primary" onClick={() => submit(item, 'approved')}>通过</button>
              <button className="danger" onClick={() => submit(item, 'rejected')}>驳回</button>
            </div>
            {messages[item.scene_id] && (
              <div className={`alert ${messages[item.scene_id].ok ? 'okk' : 'err'}`}>{messages[item.scene_id].text}</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
