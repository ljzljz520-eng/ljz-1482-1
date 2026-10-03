// 导出校验：覆盖字幕、旁白、镜头卡；生成剪辑清单与预览包
'use strict';
const crypto = require('crypto');
const { httpErr, getClauses } = require('./sources.js');
const { getScript, EVIDENCE_KINDS } = require('./scripts.js');

const uuid = () => crypto.randomUUID();
const now = () => new Date().toISOString();

/**
 * 导出前校验。错误分级：
 *  - error：阻断发布/导出（必要场缺字幕/旁白/镜头卡、缺证据、依据失效、双人复核不足）
 *  - warning：不阻断（非必要场次信息不全）
 * 每条问题都绑定到场次与具体条款引用。
 */
function validateForExport(db, scriptId) {
  const script = getScript(db, scriptId);
  const errors = [], warnings = [];
  const active = script.scenes.filter(s => !s.deleted);
  if (active.length === 0) errors.push({ code: 'EMPTY_TIMELINE', message: '时间线为空，无法导出' });

  const necessaryCount = { opening: 0, conditions: 0, materials: 0, location: 0 };
  for (const sc of active) {
    const tag = { sceneId: sc.id, order: sc.order, kind: sc.kind, kindLabel: sc.kindLabel, title: sc.title };
    // —— 三轨完整性：字幕、旁白、镜头卡 ——
    for (const [field, label] of [['subtitle', '字幕'], ['narration', '旁白'], ['shotCard', '镜头卡']]) {
      if (!String(sc[field] || '').trim()) {
        const item = { ...tag, code: `MISSING_${field.toUpperCase()}`, field,
          message: `第 ${sc.order} 场「${sc.title}」缺少${label}` };
        (EVIDENCE_KINDS.includes(sc.kind) ? errors : warnings).push(item);
      }
    }
    if (EVIDENCE_KINDS.includes(sc.kind)) {
      necessaryCount[sc.kind]++;
      // —— 溯源 ——
      if (sc.state.status === 'missing_evidence') {
        errors.push({ ...tag, code: 'MISSING_EVIDENCE', message: `${sc.kindLabel}场次缺少条款引用：${sc.state.reasons.join('；')}` });
      }
      if (sc.state.status === 'stale_reference') {
        errors.push({ ...tag, code: 'STALE_REFERENCE', message: `${sc.kindLabel}场次依据已失效：${sc.state.reasons.join('；')}` });
      }
      if (sc.state.status === 'needs_review') {
        errors.push({ ...tag, code: 'REVIEW_INCOMPLETE',
          message: `${sc.kindLabel}场次双人复核未完成：${sc.state.reasons.join('；')}` });
      }
      // 字幕/旁白中若出现地址类表述，必须能追溯到 location 条款（粗校验：地点场必须存在且有引用）
    }
  }
  for (const k of ['opening', 'conditions', 'materials', 'location']) {
    if (necessaryCount[k] === 0) {
      const label = { opening: '开场', conditions: '条件', materials: '材料', location: '办理地点' }[k];
      errors.push({ code: 'MISSING_REQUIRED_KIND', kind: k, message: `时间线缺少必要办理提醒类型：${label}` });
    }
  }
  return {
    ok: errors.length === 0,
    errors, warnings,
    checkedTracks: ['subtitle', 'narration', 'shot_card'],
    sceneCount: active.length,
  };
}

// SRT 字幕
function buildSrt(scenes) {
  const out = [];
  let cursor = 0; // 秒
  scenes.forEach((sc, i) => {
    const dur = Math.max(2, Math.ceil(String(sc.narration).length / 4)); // 约每秒4字
    const start = cursor, end = cursor + dur;
    cursor = end;
    out.push(String(i + 1));
    out.push(`${fmtSrtTime(start)} --> ${fmtSrtTime(end)}`);
    out.push(sc.subtitle || sc.narration || '');
    out.push('');
  });
  return out.join('\n');
}
function fmtSrtTime(sec) {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},000`;
}

/**
 * 剪辑清单 + 预览包。引用快照固定到具体条款文本——
 * 发布/导出后即使源文再更新，旧成果保留当时依据。
 */
function buildPackage(db, scriptId) {
  const script = getScript(db, scriptId);
  const validation = validateForExport(db, scriptId);
  const scenes = script.scenes.filter(s => !s.deleted);
  const clauses = getClauses(db, script.targetRevision.id);
  const evidenceIndex = new Map(clauses.map(c => [c.fingerprint, c]));

  const editList = scenes.map(sc => ({
    order: sc.order,
    kind: sc.kind, kindLabel: sc.kindLabel, title: sc.title,
    tracks: { subtitle: sc.subtitle, narration: sc.narration, shotCard: sc.shotCard },
    evidence: sc.linkedFingerprint ? {
      clauseRef: sc.linkedRef,
      clauseFingerprint: sc.linkedFingerprint,
      clauseTextSnapshot: evidenceIndex.get(sc.linkedFingerprint)?.text || sc.linkedClauseText || null,
      revisionId: script.targetRevision.id,
      revisionVersion: script.targetRevision.version,
    } : null,
    reviewers: sc.state?.reviews.map(r => r.reviewer) || [],
    contentVersion: sc.contentVersion,
  }));

  const preview = {
    meta: {
      packageId: uuid(),
      generatedAt: now(),
      scriptId: script.id, scriptTitle: script.title,
      sourceTitle: script.source.title,
      mode: script.mode,
      basedOnRevision: { id: script.targetRevision.id, version: script.targetRevision.version },
    },
    timeline: scenes.map(sc => ({
      order: sc.order, title: sc.title, kindLabel: sc.kindLabel,
      subtitle: sc.subtitle, narration: sc.narration,
      evidenceBadge: sc.linkedRef ? `依据：${sc.linkedRef}` : '无引用',
    })),
    srt: buildSrt(scenes),
  };

  return { validation, editList, preview };
}

// 发布快照（旧成果保留当时依据：条款文本全量固化）
function buildReleaseSnapshot(db, scriptId, bundle) {
  const script = getScript(db, scriptId);
  const clauses = getClauses(db, script.targetRevision.id);
  return {
    releasedAt: now(),
    script: { id: script.id, title: script.title, mode: script.mode },
    source: script.source,
    basisRevision: {
      id: script.targetRevision.id,
      version: script.targetRevision.version,
      createdAt: script.targetRevision.created_at,
      clauses, // 当时依据的完整条款文本
    },
    editList: bundle.editList,
    preview: bundle.preview,
    validation: bundle.validation,
  };
}

module.exports = { validateForExport, buildPackage, buildReleaseSnapshot, buildSrt, httpErr };
