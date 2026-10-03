'use strict';
/**
 * 影响计算与审核失效规则：
 * - 政策更新后按引用关系（statement_citations → clause_key）计算受影响脚本与场次；
 * - follow（跟随更新）场次：引用的条款发生内容型变化时，生效中的复核意见失效并记录原因；
 * - fixed（固定源文版本）场次：不失效，旧成果保留当时依据，仅标记「源文已有新版本」；
 * - 段落重排不视为内容变化，不触发失效。
 */
const { CONTENT_CHANGE_TYPES, CHANGE_LABEL } = require('./diff');
const { now, audit } = require('./db');

function latestRevisionId(db, policyId) {
  const r = db.prepare('SELECT id FROM policy_revisions WHERE policy_id=? ORDER BY version_no DESC LIMIT 1').get(policyId);
  return r ? r.id : null;
}

/** 场次生效依据：fixed 用固定版本，follow 跟随最新修订 */
function effectiveRevisionId(db, scene, policyId) {
  if (scene.pin_mode === 'fixed' && scene.pinned_revision_id) return scene.pinned_revision_id;
  return latestRevisionId(db, policyId);
}

/**
 * 新修订生效：落库差异、按引用关系计算影响、执行失效规则。
 * 返回 { changes, affected_scripts, invalidated_reviews }。
 */
function applyRevisionImpact(db, policyId, fromRevId, toRevId, changes, actor) {
  const insChange = db.prepare(`INSERT INTO clause_changes
    (policy_id, from_revision_id, to_revision_id, clause_key, change_type, old_text, new_text, old_index, new_index, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
  for (const c of changes) {
    insChange.run(policyId, fromRevId, toRevId, c.clause_key, c.change_type,
      c.old_text ?? null, c.new_text ?? null, c.old_index ?? null, c.new_index ?? null, now());
  }

  const contentChanges = changes.filter(c => CONTENT_CHANGE_TYPES.includes(c.change_type));
  const result = { changes, affected_scripts: [], invalidated_reviews: 0 };
  if (contentChanges.length === 0) return result; // 仅段落重排或无变化

  const keys = contentChanges.map(c => c.clause_key);
  const placeholders = keys.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT DISTINCT sc.id AS scene_id, sc.scene_no, sc.scene_type, sc.pin_mode,
           s.id AS script_id, s.title AS script_title
    FROM statement_citations cit
    JOIN scene_statements st ON st.id = cit.statement_id
    JOIN scenes sc ON sc.id = st.scene_id AND sc.deleted_at IS NULL
    JOIN scripts s ON s.id = sc.script_id
    WHERE s.policy_id = ? AND cit.clause_key IN (${placeholders})
  `).all(policyId, ...keys);

  const byScript = new Map();
  const invalidate = db.prepare(`UPDATE reviews SET invalidated_at=?, invalidation_reason=?
    WHERE scene_id=? AND decision='approved' AND invalidated_at IS NULL`);

  for (const row of rows) {
    const citedChanges = contentChanges.filter(c => {
      return db.prepare(`SELECT 1 FROM statement_citations cit
        JOIN scene_statements st ON st.id=cit.statement_id
        WHERE st.scene_id=? AND cit.clause_key=? LIMIT 1`).get(row.scene_id, c.clause_key);
    });
    const reason = '政策更新：' + citedChanges.map(c => `${c.clause_key}（${CHANGE_LABEL[c.change_type]}）`).join('、');

    if (row.pin_mode === 'follow') {
      // 失效规则：跟随更新的场次，引用条款内容变化 → 生效复核失效
      const n = invalidate.run(now(), reason, row.scene_id).changes;
      result.invalidated_reviews += n;
      if (!byScript.has(row.script_id)) byScript.set(row.script_id, { script_id: row.script_id, title: row.script_title, scenes: [] });
      byScript.get(row.script_id).scenes.push({ scene_id: row.scene_id, scene_no: row.scene_no, pin_mode: row.pin_mode, effect: 'review_invalidated', reason });
    } else {
      // 固定源文版本：保留旧依据，不触动复核，仅提示有新版本
      if (!byScript.has(row.script_id)) byScript.set(row.script_id, { script_id: row.script_id, title: row.script_title, scenes: [] });
      byScript.get(row.script_id).scenes.push({ scene_id: row.scene_id, scene_no: row.scene_no, pin_mode: row.pin_mode, effect: 'stale_notice', reason: reason + '（固定源文场次不受影响，旧成果保留当时依据）' });
    }
  }
  result.affected_scripts = [...byScript.values()];
  audit(db, actor, 'policy.impact', { policy_id: policyId, to_revision_id: toRevId, invalidated_reviews: result.invalidated_reviews, affected_scripts: result.affected_scripts.map(s => s.script_id) });
  return result;
}

module.exports = { applyRevisionImpact, latestRevisionId, effectiveRevisionId };
