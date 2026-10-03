// 复核意见：两人同时审核（同一人重复通过只计一次），事务 + 唯一约束防并发竞争
'use strict';
const crypto = require('crypto');
const { log, httpErr } = require('./sources.js');
const { computeSceneState, getScript, EVIDENCE_KINDS } = require('./scripts.js');

const uuid = () => crypto.randomUUID();
const now = () => new Date().toISOString();

function listUsers(db) {
  return db.prepare('SELECT id,name,role,active FROM users ORDER BY created_at').all();
}

function ensureUser(db, name, role = 'reviewer') {
  let u = db.prepare('SELECT * FROM users WHERE name=?').get(name);
  if (u) return u;
  const id = uuid();
  db.prepare('INSERT INTO users (id,name,role,active,created_at) VALUES (?,?,?,1,?)')
    .run(id, name, role, now());
  return db.prepare('SELECT * FROM users WHERE id=?').get(id);
}

function setUserActive(db, userId, active) {
  const r = db.prepare('UPDATE users SET active=? WHERE id=?').run(active ? 1 : 0, userId);
  if (!r.changes) throw httpErr(404, '用户不存在');
  return db.prepare('SELECT id,name,role,active FROM users WHERE id=?').get(userId);
}

/**
 * 提交复核意见。
 * 并发安全：
 *  - UNIQUE(scene_id,target_revision_id,content_version,reviewer) 防止同一人重复计入；
 *  - IMMEDIATE 事务序列化并发提交，返回更新后的完整状态；
 *  - 无证据/依据失效的场次不允许通过（必须先修复引用）。
 */
function submitReview(db, sceneId, { reviewer, decision, comment, actor }) {
  if (!reviewer || !String(reviewer).trim()) throw httpErr(400, '必须填写复核人');
  if (!['approved', 'rejected'].includes(decision)) throw httpErr(400, 'decision 非法');
  const sc = db.prepare('SELECT * FROM scenes WHERE id=? AND deleted=0').get(sceneId);
  if (!sc) throw httpErr(404, '场次不存在');

  const script = db.prepare('SELECT * FROM scripts WHERE id=?').get(sc.script_id);

  const tx = db.transaction(() => {
    const user = ensureUser(db, String(reviewer).trim(), 'reviewer');
    if (!user.active) throw httpErr(403, `复核人「${user.name}」已被停用，不能提交复核`);

    // 以最新行状态重新评估证据
    const fresh = db.prepare('SELECT * FROM scenes WHERE id=?').get(sceneId);
    const targetClauses = require('./sources.js').getClauses(db, script.target_revision_id);
    const st = computeSceneState(db, fresh, script, targetClauses);

    if (decision === 'approved' && st.required && st.evidenceStatus !== 'ok') {
      throw httpErr(409, `该场次证据状态为 ${st.evidenceStatus}（${st.reasons.join('；')}），不能通过复核，请先修复引用`);
    }

    db.prepare(`INSERT INTO reviews
      (id,scene_id,target_revision_id,content_version,linked_fingerprint,reviewer,decision,comment,created_at)
      VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(scene_id,target_revision_id,content_version,reviewer)
      DO UPDATE SET decision=excluded.decision, comment=excluded.comment, created_at=excluded.created_at`)
      .run(uuid(), sceneId, script.target_revision_id, fresh.content_version,
        fresh.linked_fingerprint, user.name, decision, comment || null, now());

    log(db, actor || user.name, 'review.submit', 'scene:' + sceneId,
      { reviewer: user.name, decision, target: script.target_revision_id, contentVersion: fresh.content_version });

    return { user: user.name };
  });

  const { user } = tx();
  const updated = getScript(db, sc.script_id);
  const sceneState = updated.scenes.find(s => s.id === sceneId)?.state;
  return { reviewer: user, sceneState, script: updated };
}

function listReviews(db, sceneId) {
  return db.prepare('SELECT * FROM reviews WHERE scene_id=? ORDER BY created_at DESC').all(sceneId);
}

module.exports = { submitReview, listReviews, listUsers, ensureUser, setUserActive, log, httpErr };
