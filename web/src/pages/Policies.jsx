import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { get, post } from '../api';

export default function Policies() {
  const [list, setList] = useState([]);
  const [title, setTitle] = useState('');
  const [msg, setMsg] = useState(null);
  const load = () => get('/api/policies').then(r => setList(r.body.policies));
  useEffect(() => { load(); }, []);
  const create = async () => {
    const r = await post('/api/policies', { title });
    if (r.status === 201) { setTitle(''); setMsg({ ok: true, text: '已创建' }); load(); }
    else setMsg({ ok: false, text: r.body?.message || '创建失败（需要 policy.write 权限）' });
  };
  return (
    <div>
      <div className="card">
        <h3>新建政策来源</h3>
        <div className="row">
          <input style={{ flex: 1 }} placeholder="政策名称，如：城乡居民医保参保登记办事指南" value={title} onChange={e => setTitle(e.target.value)} />
          <button className="primary" onClick={create} disabled={!title.trim()}>创建</button>
        </div>
        {msg && <div className={`alert ${msg.ok ? 'okk' : 'err'}`}>{msg.text}</div>}
      </div>
      <div className="card">
        <h3>政策列表</h3>
        <table>
          <thead><tr><th>ID</th><th>名称</th><th>最新修订</th><th>脚本数</th><th></th></tr></thead>
          <tbody>
            {list.map(p => (
              <tr key={p.id}>
                <td>{p.id}</td><td>{p.title}</td>
                <td>{p.latest_revision ? `R${p.latest_revision.version_no}（${p.latest_revision.created_at.slice(0, 10)}）` : '—'}</td>
                <td>{p.scripts}</td>
                <td><Link to={`/policies/${p.id}`}>修订与差异 →</Link></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
