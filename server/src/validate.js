'use strict';
/**
 * 校验：
 * 1) 证据链：开场/条件/材料/办理地点 四类陈述必须引用具体条款，且条款在生效依据版本中存在；
 *    缺证据只标记、不补造（系统不得自行补造条件或地址）。
 * 2) 导出校验：覆盖字幕、旁白、镜头卡 + 证据链。
 * 3) 删场守卫：时间线删场不能悄悄删除必要办理提醒（材料/地点/提醒类的最后承载场次）。
 */
const { effectiveRevisionId } = require('./impact');

const EVIDENCE_TYPES = ['opening', 'condition', 'material', 'location'];
// 发布门禁要求复核的陈述类型：四类必追溯陈述 + 必要办理提醒
const REVIEW_TYPES = [...EVIDENCE_TYPES, 'reminder'];
const STMT_LABEL = { opening: '开场', condition: '条件', material: '材料', location: '办理地点', reminder: '必要办理提醒', other: '其他' };
const SCENE_TYPE_LABEL = { opening: '开场', conditions: '条件', materials: '材料', location: '办理地点', reminder: '必要办理提醒', other: '其他' };

function sceneStatements(db, sceneId) {
  const stmts = db.prepare('SELECT * FROM scene_statements WHERE scene_id=? ORDER BY id').all(sceneId);
  for (const s of stmts) {
    s.citations = db.prepare('SELECT clause_key FROM statement_citations WHERE statement_id=? ORDER BY clause_key').all(s.id).map(r => r.clause_key);
  }
  return stmts;
}

/** 缺证据问题列表 */
function sceneEvidenceIssues(db, scene, effRevId) {
  const issues = [];
  for (const s of sceneStatements(db, scene.id)) {
    if (!EVIDENCE_TYPES.includes(s.stmt_type)) continue;
    if (s.citations.length === 0) {
      issues.push({ statement_id: s.id, stmt_type: s.stmt_type, issue: 'no_citation', message: `「${STMT_LABEL[s.stmt_type]}」陈述缺少条款引用（缺证据）` });
      continue;
    }
    for (const key of s.citations) {
      const cl = db.prepare('SELECT id FROM clauses WHERE revision_id=? AND clause_key=?').get(effRevId, key);
      if (!cl) issues.push({ statement_id: s.id, stmt_type: s.stmt_type, issue: 'clause_missing', message: `引用条款 ${key} 在生效依据版本中不存在（缺证据）` });
    }
  }
  return issues;
}

/** 生效复核（approved 且未失效） */
function activeApproval(db, sceneId) {
  return db.prepare(`SELECT * FROM reviews WHERE scene_id=? AND decision='approved' AND invalidated_at IS NULL
    ORDER BY id DESC LIMIT 1`).get(sceneId);
}

function latestInvalidated(db, sceneId) {
  return db.prepare(`SELECT * FROM reviews WHERE scene_id=? AND invalidated_at IS NOT NULL
    ORDER BY id DESC LIMIT 1`).get(sceneId);
}

/** 导出校验：字幕、旁白、镜头卡 + 证据链。返回 {ok, errors[]} */
function validateExport(db, scriptVersionId) {
  const v = db.prepare('SELECT * FROM script_versions WHERE id=?').get(scriptVersionId);
  if (!v) return { ok: false, errors: [{ message: '版本不存在' }] };
  const script = db.prepare('SELECT * FROM scripts WHERE id=?').get(v.script_id);
  const scenes = db.prepare('SELECT * FROM scenes WHERE script_id=? AND deleted_at IS NULL ORDER BY scene_no').all(script.id);
  const errors = [];
  for (const scene of scenes) {
    const eff = effectiveRevisionId(db, scene, script.policy_id);
    const label = `第${scene.scene_no}场`;
    if (!scene.subtitle || !scene.subtitle.trim()) errors.push({ scene_id: scene.id, scene_no: scene.scene_no, field: 'subtitle', message: `${label} 缺少字幕` });
    if (!scene.voiceover || !scene.voiceover.trim()) errors.push({ scene_id: scene.id, scene_no: scene.scene_no, field: 'voiceover', message: `${label} 缺少旁白` });
    if (!scene.shot_card || !scene.shot_card.trim()) errors.push({ scene_id: scene.id, scene_no: scene.scene_no, field: 'shot_card', message: `${label} 缺少镜头卡` });
    for (const iss of sceneEvidenceIssues(db, scene, eff)) {
      errors.push({ scene_id: scene.id, scene_no: scene.scene_no, field: 'evidence', message: `${label} ${iss.message}` });
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * 删场守卫：若该场是全片某类「必要办理提醒」（材料/办理地点/提醒）的最后承载场次，
 * 删除必须显式确认并记录原因，不能悄悄删除。
 */
function deletionGuard(db, sceneId) {
  const scene = db.prepare('SELECT * FROM scenes WHERE id=? AND deleted_at IS NULL').get(sceneId);
  if (!scene) return { guarded: false, reasons: [] };
  const reasons = [];
  const GUARD_TYPES = ['material', 'location', 'reminder'];
  const stmts = sceneStatements(db, sceneId).filter(s => GUARD_TYPES.includes(s.stmt_type));
  const myTypes = new Set(stmts.map(s => s.stmt_type));
  if (['materials', 'location', 'reminder'].includes(scene.scene_type)) {
    const t = scene.scene_type === 'materials' ? 'material' : scene.scene_type === 'location' ? 'location' : 'reminder';
    myTypes.add(t);
  }
  for (const t of myTypes) {
    const others = db.prepare(`
      SELECT COUNT(DISTINCT sc.id) AS c FROM scenes sc
      JOIN scene_statements st ON st.scene_id = sc.id
      WHERE sc.script_id=? AND sc.id<>? AND sc.deleted_at IS NULL AND st.stmt_type=?
    `).get(scene.script_id, sceneId, t).c;
    if (others === 0) {
      reasons.push(`该场是全片唯一的「${STMT_LABEL[t]}」类必要办理提醒承载场次，删除将丢失必要办理提醒`);
    }
  }
  return { guarded: reasons.length > 0, reasons };
}

/** 发布门禁：导出校验通过 + 所有含四类陈述的场次均有生效复核 */
function publishGate(db, scriptVersionId) {
  const v = db.prepare('SELECT * FROM script_versions WHERE id=?').get(scriptVersionId);
  if (!v) return { ok: false, blockers: [{ message: '版本不存在' }] };
  const script = db.prepare('SELECT * FROM scripts WHERE id=?').get(v.script_id);
  const scenes = db.prepare('SELECT * FROM scenes WHERE script_id=? AND deleted_at IS NULL ORDER BY scene_no').all(script.id);
  const blockers = [];
  const val = validateExport(db, scriptVersionId);
  for (const e of val.errors) blockers.push({ scene_id: e.scene_id, reason: e.message });
  for (const scene of scenes) {
    const stmts = sceneStatements(db, scene.id);
    const needReview = stmts.some(s => REVIEW_TYPES.includes(s.stmt_type));
    if (!needReview) continue;
    if (!activeApproval(db, scene.id)) {
      const inv = latestInvalidated(db, scene.id);
      const reason = inv ? `复核已失效：${inv.invalidation_reason}` : '尚未复核通过';
      blockers.push({ scene_id: scene.id, scene_no: scene.scene_no, reason: `第${scene.scene_no}场 ${reason}` });
    }
  }
  return { ok: blockers.length === 0, blockers };
}

module.exports = {
  EVIDENCE_TYPES, REVIEW_TYPES, STMT_LABEL, SCENE_TYPE_LABEL,
  sceneStatements, sceneEvidenceIssues, activeApproval, latestInvalidated,
  validateExport, deletionGuard, publishGate,
};
