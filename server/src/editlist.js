'use strict';
/**
 * 剪辑清单与发布快照：内容只来自场次改写文本与其引用的条款原文，
 * 系统不得自行补造条件或地址；缺引用的陈述标记 missing_evidence。
 */
const { effectiveRevisionId } = require('./impact');
const { sceneStatements, EVIDENCE_TYPES } = require('./validate');
const { now } = require('./db');

function resolveCitations(db, revisionId, keys) {
  return keys.map(key => {
    const cl = db.prepare('SELECT clause_key, text, kind, para_index FROM clauses WHERE revision_id=? AND clause_key=?').get(revisionId, key);
    return cl
      ? { clause_key: key, revision_id: revisionId, excerpt: cl.text, kind: cl.kind, para_index: cl.para_index }
      : { clause_key: key, revision_id: revisionId, missing: true };
  });
}

/** 当前（草稿）场次数据，引用解析到各场生效依据版本 */
function liveScenesData(db, scriptId, policyId) {
  const scenes = db.prepare('SELECT * FROM scenes WHERE script_id=? AND deleted_at IS NULL ORDER BY scene_no').all(scriptId);
  return scenes.map(scene => {
    const eff = effectiveRevisionId(db, scene, policyId);
    const statements = sceneStatements(db, scene.id).map(s => {
      const citations = resolveCitations(db, eff, s.citations);
      return {
        stmt_type: s.stmt_type,
        paraphrase: s.paraphrase,
        citations,
        missing_evidence: EVIDENCE_TYPES.includes(s.stmt_type) &&
          (s.citations.length === 0 || citations.some(c => c.missing)),
      };
    });
    return {
      scene_id: scene.id, scene_no: scene.scene_no, scene_type: scene.scene_type, title: scene.title,
      pin_mode: scene.pin_mode, effective_revision_id: eff,
      subtitle: scene.subtitle, voiceover: scene.voiceover, shot_card: scene.shot_card,
      statements,
    };
  });
}

/** 发布快照：冻结当时依据（条款原文随快照保存） */
function buildSnapshot(db, scriptVersionId) {
  const v = db.prepare('SELECT * FROM script_versions WHERE id=?').get(scriptVersionId);
  const script = db.prepare('SELECT * FROM scripts WHERE id=?').get(v.script_id);
  return {
    script_id: script.id, script_title: script.title,
    script_version_id: v.id, version_no: v.version_no,
    basis_revision_id: v.basis_revision_id,
    published_at: v.published_at, published_by: v.published_by,
    scenes: liveScenesData(db, script.id, script.policy_id),
    snapshot_at: now(),
  };
}

/** 剪辑清单：已发布版本读快照（旧成果保留当时依据），草稿读当前场次 */
function buildEditList(db, scriptVersionId) {
  const v = db.prepare('SELECT * FROM script_versions WHERE id=?').get(scriptVersionId);
  if (!v) throw new Error('script_version not found');
  const script = db.prepare('SELECT * FROM scripts WHERE id=?').get(v.script_id);
  let scenesData, basis;
  if (v.status === 'published') {
    const snap = db.prepare('SELECT snapshot_json FROM published_snapshots WHERE script_version_id=? ORDER BY id DESC LIMIT 1').get(v.id);
    scenesData = snap ? JSON.parse(snap.snapshot_json).scenes : [];
    basis = v.basis_revision_id;
  } else {
    scenesData = liveScenesData(db, script.id, script.policy_id);
    basis = effectiveRevisionId(db, { pin_mode: 'follow' }, script.policy_id);
  }
  const items = scenesData.map(sc => ({
    scene_no: sc.scene_no, scene_type: sc.scene_type, title: sc.title,
    shot_card: sc.shot_card, subtitle: sc.subtitle, voiceover: sc.voiceover,
    basis_revision_id: sc.effective_revision_id || basis,
    statements: sc.statements.map(s => ({
      stmt_type: s.stmt_type, paraphrase: s.paraphrase,
      evidence: s.citations, missing_evidence: !!s.missing_evidence,
    })),
  }));
  return { script_version_id: v.id, version_no: v.version_no, script_title: script.title, basis_revision_id: basis, generated_at: now(), items };
}

/** 预览包 HTML（仅渲染已有内容与引用条款，不生成新事实） */
function renderPreviewHtml(editList, validation) {
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const rows = editList.items.map(it => `
    <section class="scene">
      <h2>第${it.scene_no}场 · ${esc(it.title)} <small>${esc(it.scene_type)}</small></h2>
      <p><b>镜头卡：</b>${esc(it.shot_card)}</p>
      <p><b>字幕：</b>${esc(it.subtitle)}</p>
      <p><b>旁白：</b>${esc(it.voiceover)}</p>
      <ul>${it.statements.map(s => `
        <li>[${esc(s.stmt_type)}] ${esc(s.paraphrase)}
          ${s.missing_evidence ? '<b class="miss">（缺证据）</b>' : ''}
          <ul>${s.evidence.map(e => `<li>依据 ${esc(e.clause_key)}@R${e.revision_id}：${esc(e.excerpt || '（条款缺失）')}</li>`).join('')}</ul>
        </li>`).join('')}
      </ul>
    </section>`).join('\n');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>预览包 v${editList.version_no}</title>
<style>body{font-family:system-ui,sans-serif;max-width:860px;margin:2rem auto;padding:0 1rem}section{border:1px solid #ddd;border-radius:8px;padding:1rem;margin:1rem 0}.miss{color:#c00}</style>
</head><body>
<h1>${esc(editList.script_title)} · 版本 v${editList.version_no} 预览包</h1>
<p>依据修订：R${editList.basis_revision_id} ｜ 生成时间：${esc(editList.generated_at)} ｜ 导出校验：${validation.ok ? '通过' : '未通过'}</p>
${rows}
</body></html>`;
}

module.exports = { liveScenesData, buildSnapshot, buildEditList, renderPreviewHtml };
