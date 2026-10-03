import React, { useState } from 'react';
import { NavLink, Routes, Route, Navigate } from 'react-router-dom';
import { USERS, getUser, setUser } from './api';
import Dashboard from './pages/Dashboard';
import Policies from './pages/Policies';
import PolicyDetail from './pages/PolicyDetail';
import ScriptEditor from './pages/ScriptEditor';
import ReviewCenter from './pages/ReviewCenter';
import Tasks from './pages/Tasks';
import Publish from './pages/Publish';

export default function App() {
  const [uid, setUid] = useState(getUser());
  return (
    <div className="layout">
      <nav className="sidebar">
        <h1>县域政策短视频<br />全栈编排台</h1>
        <NavLink to="/dashboard">概览</NavLink>
        <NavLink to="/policies">政策来源</NavLink>
        <NavLink to="/review">复核中心</NavLink>
        <NavLink to="/tasks">异步任务</NavLink>
        <NavLink to="/publish">发布与导出</NavLink>
      </nav>
      <main className="main">
        <div className="topbar">
          <h2>编排台</h2>
          <div className="user-switch">
            当前身份：
            <select value={uid} onChange={e => { setUser(e.target.value); setUid(e.target.value); }}>
              {USERS.map(([id, name]) => <option key={id} value={id}>{name}（{id}）</option>)}
            </select>
          </div>
        </div>
        <Routes>
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/policies" element={<Policies />} />
          <Route path="/policies/:id" element={<PolicyDetail />} />
          <Route path="/scripts/:id" element={<ScriptEditor />} />
          <Route path="/review" element={<ReviewCenter />} />
          <Route path="/tasks" element={<Tasks />} />
          <Route path="/publish" element={<Publish />} />
        </Routes>
      </main>
    </div>
  );
}
