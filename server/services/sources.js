// 政策来源与修订版本管理 + 差异定位 + 受影响脚本计算
'use strict';
const crypto = require('crypto');
const { parseClauses, diffClauses } = require('../../shared/clauses.js');

const uuid = () => crypto.randomUUID();
const now = () => new Date().toISOString();

function log(db, actor, action, entity, detail) {
  db.prepare(`INSERT INTO audit_logs (id, actor, action, entity, detail, created_at)
              VALUES (?,?,?,?,?,?)`).run(uuid(), actor || null, action, entity || null,
    detail ? JSON.stringify(detail) : null, now());
}

function createSource(db, { title, issuer, docNo, rawText, note, actor }) {
  if (!title || !String(title).trim()) throw httpErr(400, '来源标题不能为空');
  if (!rawText || !String(rawText).trim()) throw httpErr(400, '政策材料原文不能为空');
  const id = uuid();
  const ts = now();
  const tx = db.transaction(() => {
    db.prepare(`INSERT INTO sources (id,title,issuer,doc_no,current_revision_id,created_at,updated_at)
                VALUES (?,?,?,?,?,?,?)`).run(id, title.trim(), issuer || null, docNo || null, null, ts, ts);
    const rev = addRevisionTx(db, { sourceId: id, rawText, note: note || '初版录入', actor });
    db.prepare('UPDATE sources SET current_revision_id=?, updated_at=? WHERE id=?')
      .run(rev.id, ts, id);
    log(db, actor, 'source.create', 'source:' + id, { title, revisionId: rev.id });
    return rev;
  });
  return tx();
}

function addRevision(db, sourceId, { rawText, note, actor }) {
  const source = db.prepare('SELECT * FROM sources WHERE id=?').get(sourceId);
  if (!source) throw httpErr(404, '来源不存在');
  if (!rawText || !String(rawText).trim()) throw httpErr(400, '修订原文不能为空');
  const ts = now();
  const tx = db.transaction(() => {
    const rev = addRevisionTx(db, { sourceId, rawText, note, actor });
    db.prepare('UPDATE sources SET current_revision_id=?, updated_at=? WHERE id=?')
      .run(rev.id, ts, sourceId);
    // 跟随更新的草稿：目标版本移动到新版；固定源文版本的脚本不动
    db.prepare(`UPDATE scripts SET target_revision_id=?, updated_at=?
                WHERE source_id=? AND mode='following'`).run(rev.id, ts, sourceId);
    log(db, actor, 'revision.add', 'revision:' + rev.id,
      { sourceId, version: rev.version, summary: rev.diff.summary });
    return rev;
  });
  return tx();
}

function addRevisionTx(db, { sourceId, rawText, note, actor }) {
  const last = db.prepare('SELECT MAX(version) v FROM revisions WHERE source_id=?').get(sourceId);
  const version = (last.v || 0) + 1;
  const id = uuid();
  const ts = now();
  db.prepare(`INSERT INTO revisions (id,source_id,version,note,raw_text,created_at)
              VALUES (?,?,?,?,?,?)`).run(id, sourceId, version, note || null, rawText, ts);
  const parsed = parseClauses(rawText);
  const insClause = db.prepare(`INSERT INTO clauses
    (id,revision_id,ref,title,text,clause_order,fingerprint,dates) VALUES (?,?,?,?,?,?,?,?)`);
  for (const c of parsed) {
    insClause.run(uuid(), id, c.ref, c.title, c.text, c.order, c.fingerprint, JSON.stringify(c.dates || []));
  }
  // 与上一版做差异定位
  let diff = { changes: [], summary: { added: 0, removed: 0, changed: 0, dateChanged: 0, reordered: 0, unchanged: 0 },
    invalidatedFingerprints: [], reorderedOnly: false };
  const prev = db.prepare(`SELECT id FROM revisions WHERE source_id=? AND version=?`).get(sourceId, version - 1);
  if (prev) {
    const oldRows = getClauses(db, prev.id);
    diff = diffClauses(oldRows, parsed);
    db.prepare(`INSERT INTO revision_diffs (id,source_id,revision_id,base_revision_id,summary,detail,invalidated_fingerprints,created_at)
                VALUES (?,?,?,?,?,?,?,?)`)
      .run(uuid(), sourceId, id, prev.id, JSON.stringify(diff.summary), JSON.stringify(diff.changes),
        JSON.stringify(diff.invalidatedFingerprints), ts);
    invalidateAffectedReviews(db, { sourceId, oldRevisionId: prev.id, newRevisionId: id, diff });
  }
  return { id, version, note, clauses: parsed, diff, createdAt: ts };
}

/**
 * 审核失效规则：
 *  - 引用条款内容变化/删除 -> 该指纹上的复核意见对新版本失效（通过 approval 快照比对实现，不删历史记录）
 *  - 仅段落重排（指纹不变）-> 不失效
 *  - 固定版本脚本：不改变其目标版本，复核始终针对其固定版本，保持有效
 */
function invalidateAffectedReviews(db, { sourceId, diff }) {
  if (!diff.invalidatedFingerprints.length) return 0;
  const fps = new Set(diff.invalidatedFingerprints);
  const affected = db.prepare(`
    SELECT s.id script_id, sc.id scene_id, sc.linked_fingerprint
    FROM scenes sc JOIN scripts s ON s.id = sc.script_id
    WHERE s.source_id=? AND sc.deleted=0 AND sc.linked_fingerprint IS NOT NULL`).all(sourceId);
  // 失效是"计算式"的——这里只记录影响事实，状态在读取时判定。
  // 记录到 audit，便于页面展示"待复核原因"。
  let n = 0;
  for (const a of affected) {
    if (fps.has(a.linked_fingerprint)) {
      log(db, 'system', 'review.invalidated', 'scene:' + a.scene_id,
        { reason: 'linked_clause_changed_or_removed', fingerprint: a.linked_fingerprint });
      n++;
    }
  }
  return n;
}

function getClauses(db, revisionId) {
  return db.prepare('SELECT * FROM clauses WHERE revision_id=? ORDER BY clause_order')
    .all(revisionId)
    .map(c => ({ ...c, order: c.clause_order, dates: JSON.parse(c.dates || '[]') }));
}

function listSources(db) {
  return db.prepare(`SELECT s.*, (SELECT COUNT(*) FROM revisions r WHERE r.source_id=s.id) revision_count
                     FROM sources s ORDER BY s.updated_at DESC`).all();
}

function getSource(db, id) {
  const source = db.prepare('SELECT * FROM sources WHERE id=?').get(id);
  if (!source) throw httpErr(404, '来源不存在');
  source.revisions = db.prepare('SELECT id,version,note,created_at FROM revisions WHERE source_id=? ORDER BY version').all(id);
  source.currentRevision = source.current_revision_id
    ? getRevision(db, source.current_revision_id) : null;
  return source;
}

function getRevision(db, revisionId) {
  const r = db.prepare('SELECT * FROM revisions WHERE id=?').get(revisionId);
  if (!r) throw httpErr(404, '修订版本不存在');
  const clauses = getClauses(db, revisionId);
  const diffRow = db.prepare('SELECT * FROM revision_diffs WHERE revision_id=?').get(revisionId);
  return {
    ...r, clauses,
    diff: diffRow ? {
      summary: JSON.parse(diffRow.summary),
      changes: JSON.parse(diffRow.detail),
      invalidatedFingerprints: JSON.parse(diffRow.invalidated_fingerprints),
    } : null,
  };
}

// 预览解析结果（不落库）
function previewParse(rawText) {
  return parseClauses(rawText);
}

function httpErr(status, message, details) {
  const e = new Error(message);
  e.status = status;
  if (details !== undefined) e.details = details;
  return e;
}

module.exports = {
  createSource, addRevision, getSource, getRevision, listSources,
  getClauses, previewParse, log, httpErr,
};
