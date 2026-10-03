import React, { useState, useCallback, useEffect } from 'react';
import { api, currentActor, setCurrentActor } from './api.js';
import SourcesTab from './tabs/SourcesTab.jsx';
import ScriptsTab from './tabs/ScriptsTab.jsx';
import JobsTab from './tabs/JobsTab.jsx';
import ServerlessTab from './tabs/ServerlessTab.jsx';

export const ToastCtx = React.createContext(null);

const TABS = [
  { key: 'sources', label: '① 政策来源与修订' },
  { key: 'scripts', label: '② 脚本与复核' },
  { key: 'jobs', label: '③ 异步任务/素材' },
  { key: 'serverless', label: '④ 无服务器页面' },
];

export default function App() {
  const [tab, setTab] = useState('sources');
  const [actor, setActor] = useState(currentActor());
  const [toast, setToast] = useState(null);

  const notify = useCallback((msg, kind = '') => {
    setToast({ msg, kind });
    setTimeout(() => setToast(null), 5200);
  }, []);

  const errMsg = useCallback((e) => {
    let msg = e.message;
    if (e.details?.length) msg += '\n· ' + e.details.slice(0, 6).map(d => d.message || JSON.stringify(d)).join('\n· ');
    notify(msg, 'error');
  }, [notify]);

  return (
    <ToastCtx.Provider value={{ notify, errMsg }}>
      <header className="topbar">
        <h1>县域政策短视频全栈编排台</h1>
        <span className="sub">条款可溯源 · 修订差异定位 · 双人复核 · 持久队列 · 旧成果留痕</span>
        <div className="actor">
          当前操作人
          <input value={actor} onChange={e => { setActor(e.target.value); setCurrentActor(e.target.value); }}
            style={{ width: 120 }} />
        </div>
      </header>
      <nav className="tabs">
        {TABS.map(t => (
          <button key={t.key} className={tab === t.key ? 'active' : ''} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </nav>
      <main>
        {tab === 'sources' && <SourcesTab goScripts={() => setTab('scripts')} />}
        {tab === 'scripts' && <ScriptsTab />}
        {tab === 'jobs' && <JobsTab />}
        {tab === 'serverless' && <ServerlessTab />}
      </main>
      {toast && <div className={`toast ${toast.kind}`}>{toast.msg}</div>}
    </ToastCtx.Provider>
  );
}
