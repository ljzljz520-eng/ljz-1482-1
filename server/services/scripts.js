// 脚本与场次：溯源、时间线保护、双人复核状态计算
'use strict';
const crypto = require('crypto');
const { log, httpErr, getClauses } = require('./sources.js');

const uuid = () => crypto.randomUUID();
const now = () => new Date().toISOString();

// 四类必须能追到具体条款的"必要办理提醒"
const EVIDENCE_KINDS = ['opening', 'conditions', 'materials', 'location'];
const KIND_LABEL = {
  opening: '开场', conditions: '条件', materials: '材料',
  location: '办理地点', closing: '结尾', other: '其他',
};

function createScript(db, { sourceId, title, mode, actor }) {
  const source = db.prepare('SELECT * FROM sources WHERE id=?').get(sourceId);
  if (!source) throw httpErr(404, '来源不存在');
  if (!source.current_revision_id) throw httpErr(400, '该来源尚无修订版本');
  if (!title || !title.trim()) throw httpErr(400, '脚本标题不能为空');
  const m = mode === 'pinned' ? 'pinned' : 'following';
  const id = uuid(), ts = now();
  db.prepare(`INSERT INTO scripts
    (id,source_id,title,mode,base_revision_id,target_revision_id,status,published_version,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,0,?,?)`)
    .run(id, sourceId, title.trim(), m, source.current_revision_id, source.current_revision_id, 'draft', ts, ts);
  log(db, actor, 'script.create', 'script:' + id, { sourceId, mode: m });
  return getScript(db, id);
}

function addScene(db, scriptId, data, actor) {
  const script = mustScript(db, scriptId);
  const kind = data.kind && KIND_LABEL[data.kind] ? data.kind : 'other';
  const max = db.prepare('SELECT COALESCE(MAX(scene_order),0) m FROM scenes WHERE script_id=? AND deleted=0').get(scriptId).m;
  const id = uuid(), ts = now();
  // 关键约束：四类陈述必须绑定具体条款（录入时即校验，禁止"缺证据"内容进入）
  let linkedClauseId = null, linkedFp = null;
  if (data.linkedClauseId) {
    const c = db.prepare('SELECT * FROM clauses WHERE id=?').get(data.linkedClauseId);
    if (!c) throw httpErr(400, '引用条款不存在');
    linkedClauseId = c.id; linkedFp = c.fingerprint;
  } else if (EVIDENCE_KINDS.includes(kind)) {
    throw httpErr(400, `${KIND_LABEL[kind]}场次必须引用具体条款（开场/条件/材料/办理地点不得无证据）`);
  }
  db.prepare(`INSERT INTO scenes
    (id,script_id,scene_order,kind,title,narration,subtitle,shot_card,linked_clause_id,linked_fingerprint,content_version,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,1,?)`).run(
      id, scriptId, max + 1, kind,
      data.title || `${KIND_LABEL[kind]}场次`, data.narration || '', data.subtitle || '',
      data.shotCard || '', linkedClauseId, linkedFp, ts);
  log(db, actor, 'scene.add', 'scene:' + id, { scriptId, kind, linkedClauseId });
  return getScript(db, scriptId);
}

function updateScene(db, sceneId, data, actor) {
  const sc = db.prepare('SELECT * FROM scenes WHERE id=? AND deleted=0').get(sceneId);
  if (!sc) throw httpErr(404, '场次不存在');
  const ts = now();
  const fields = [];
  const vals = [];
  for (const [k, col] of [['title', 'title'], ['narration', 'narration'], ['subtitle', 'subtitle'], ['shotCard', 'shot_card']]) {
    if (data[k] !== undefined) { fields.push(`${col}=?`); vals.push(data[k]); }
  }
  let linkedClauseId = sc.linked_clause_id, linkedFp = sc.linked_fingerprint;
  if (data.linkedClauseId !== undefined) {
    if (data.linkedClauseId) {
      const c = db.prepare('SELECT * FROM clauses WHERE id=?').get(data.linkedClauseId);
      if (!c) throw httpErr(400, '引用条款不存在');
      linkedClauseId = c.id; linkedFp = c.fingerprint;
      fields.push('linked_clause_id=?', 'linked_fingerprint=?'); vals.push(c.id, c.fingerprint);
    } else if (EVIDENCE_KINDS.includes(sc.kind)) {
      throw httpErr(400, `${KIND_LABEL[sc.kind]}场次不能移除条款引用（必要办理提醒必须可溯源）`);
    } else {
      fields.push('linked_clause_id=NULL', 'linked_fingerprint=NULL');
    }
  }
  if (fields.length) {
    // 内容改动 -> 内容版本 +1，旧版本复核自然失效（读取时按版本过滤）
    const contentChanged = ['title', 'narration', 'subtitle', 'shotCard'].some(k => data[k] !== undefined);
    if (contentChanged) { fields.push('content_version = content_version + 1'); }
    fields.push('updated_at=?'); vals.push(ts);
    db.prepare(`UPDATE scenes SET ${fields.join(', ')} WHERE id=?`).run(...vals, sceneId);
    log(db, actor, 'scene.update', 'scene:' + sceneId,
      { contentChanged, contentVersion: contentChanged ? sc.content_version + 1 : sc.content_version });
  }
  return getScript(db, sc.script_id);
}

/**
 * 时间线删场保护：必要办理提醒不能"悄悄删除"。
 * 规则：
 *  1) 四类必要场次删除时必须填写 deleteReason；
 *  2) 若其引用条款在脚本目标版本中仍然有效，必须先存在另一场次覆盖同一内容指纹，
 *     否则拒绝删除（防止办理提醒丢失）；
 *  3) 条款已删除/变更导致引用失效的场次允许删除，但仍需写明原因。
 */
function deleteScene(db, sceneId, { reason, actor }) {
  const sc = db.prepare('SELECT * FROM scenes WHERE id=? AND deleted=0').get(sceneId);
  if (!sc) throw httpErr(404, '场次不存在');
  const necessary = EVIDENCE_KINDS.includes(sc.kind);
  if (necessary && (!reason || !String(reason).trim())) {
    throw httpErr(409, `删除${KIND_LABEL[sc.kind]}场次必须填写删除原因（不能悄悄删除必要办理提醒）`);
  }
  if (necessary) {
    const script = mustScript(db, sc.script_id);
    const clauseAlive = clauseAliveInTarget(db, sc.linked_clause_id, sc.linked_fingerprint, script.target_revision_id);
    if (clauseAlive === true) {
      const cover = db.prepare(`SELECT COUNT(*) c FROM scenes
        WHERE script_id=? AND deleted=0 AND id<>? AND linked_fingerprint=?`).get(sc.script_id, sceneId, sc.linked_fingerprint).c;
      if (cover === 0) {
        throw httpErr(409, `该${KIND_LABEL[sc.kind]}提醒所依据的条款仍然有效，且没有其他场次覆盖；` +
          `请先新增替代场次（引用同一/对应条款），再删除本场次。`);
      }
    }
  }
  db.prepare('UPDATE scenes SET deleted=1, delete_reason=?, deleted_at=?, updated_at=? WHERE id=?')
    .run(reason || null, now(), now(), sceneId);
  log(db, actor, 'scene.delete', 'scene:' + sceneId, { reason: reason || null, kind: sc.kind });
  return getScript(db, sc.script_id);
}

function moveScene(db, sceneId, { dir, actor }) {
  const sc = db.prepare('SELECT * FROM scenes WHERE id=? AND deleted=0').get(sceneId);
  if (!sc) throw httpErr(404, '场次不存在');
  const d = dir === 'up' ? -1 : dir === 'down' ? 1 : 0;
  if (!d) throw httpErr(400, 'dir 必须是 up/down');
  const target = db.prepare('SELECT * FROM scenes WHERE script_id=? AND deleted=0 AND scene_order=?')
    .get(sc.script_id, sc.scene_order + d);
  if (!target) return getScript(db, sc.script_id);
  const ts = now();
  const tx = db.transaction(() => {
    db.prepare('UPDATE scenes SET scene_order=?, updated_at=? WHERE id=?').run(target.scene_order, ts, sc.id);
    db.prepare('UPDATE scenes SET scene_order=?, updated_at=? WHERE id=?').run(sc.scene_order, ts, target.id);
  });
  tx();
  log(db, actor, 'scene.move', 'scene:' + sceneId, { dir });
  return getScript(db, sc.script_id);
}

// 固定版本 -> 跟随新版本（一次性 rebase，迁移到新版并重新计算复核状态）
function rebaseScript(db, scriptId, { mode, actor }) {
  const script = mustScript(db, scriptId);
  const source = db.prepare('SELECT * FROM sources WHERE id=?').get(script.source_id);
  const ts = now();
  const tx = db.transaction(() => {
    if (mode === 'following') {
      db.prepare("UPDATE scripts SET mode='following', target_revision_id=?, updated_at=? WHERE id=?")
        .run(source.current_revision_id, ts, scriptId);
    } else {
      // pin：跟随 -> 固定当前最新
      db.prepare("UPDATE scripts SET mode='pinned', target_revision_id=COALESCE(target_revision_id, ?), base_revision_id=COALESCE(base_revision_id, ?), updated_at=? WHERE id=?")
        .run(source.current_revision_id, source.current_revision_id, ts, scriptId);
    }
  });
  tx();
  log(db, actor, 'script.rebase', 'script:' + scriptId, { mode, target: source.current_revision_id });
  return getScript(db, scriptId);
}

/**
 * 场次状态（核心计算）：
 *  - missing_evidence：必要场次未引用条款，或引用条款不在目标版本中
 *  - stale_reference：引用指纹在目标版本中已变化/删除（待复核原因：依据条款已更新）
 *  - needs_review：证据有效，但当前目标版本 + 当前内容版本上不足两名不同复核人
 *  - approved：两名不同复核人均通过，且版本/指纹全部对得上
 */
function computeSceneState(db, scene, script, targetClauses) {
  const reasons = [];
  const isNecessary = EVIDENCE_KINDS.includes(scene.kind);
  const targetFps = new Set(targetClauses.map(c => c.fingerprint));
  const clauseById = new Map(targetClauses.map(c => [c.id, c]));

  let evidenceStatus = 'ok';
  if (!scene.linked_clause_id || !scene.linked_fingerprint) {
    if (isNecessary) { evidenceStatus = 'missing'; reasons.push('缺少条款引用，无法溯源'); }
  } else {
    const direct = clauseById.get(scene.linked_clause_id);
    if (direct) {
      if (direct.fingerprint !== scene.linked_fingerprint) {
        evidenceStatus = 'stale';
        reasons.push('引用条款内容已更新（版本修订），需重新确认引用');
      }
    } else if (targetFps.has(scene.linked_fingerprint)) {
      evidenceStatus = 'ok'; // 段落重排：条款 id 变了但内容指纹一致，引用仍有效
      reasons.push('条款在新版本中位置调整（段落重排），内容未变');
    } else {
      evidenceStatus = 'stale';
      reasons.push('引用条款在目标版本中已删除或改写，原依据失效');
    }
  }

  // 复核匹配：正常按"场次+目标版本+内容版本"；
  // 段落重排时条款 id 与版本号都变了，但内容指纹一致——
  // 同一内容版本上、针对同一指纹的复核意见延续有效（审核失效以指纹为准，不以版本号为准）。
  let reviewRevisionId = script.target_revision_id;
  let reviews = db.prepare(`SELECT * FROM reviews
    WHERE scene_id=? AND target_revision_id=? AND content_version=? AND decision='approved'`
  ).all(scene.id, script.target_revision_id, scene.content_version);
  if (reviews.length === 0 && evidenceStatus === 'ok' && scene.linked_fingerprint
      && !clauseById.has(scene.linked_clause_id) && targetFps.has(scene.linked_fingerprint)) {
    // 段落重排延续：取该场次该内容版本上、针对相同条款指纹的历史复核
    reviews = db.prepare(`SELECT * FROM reviews
      WHERE scene_id=? AND content_version=? AND linked_fingerprint=? AND decision='approved'
      ORDER BY created_at DESC`).all(scene.id, scene.content_version, scene.linked_fingerprint);
    if (reviews.length) reviewRevisionId = reviews[0].target_revision_id;
  }
  const reviewers = [...new Set(reviews.map(r => r.reviewer))];

  let status;
  if (evidenceStatus === 'missing') status = 'missing_evidence';
  else if (evidenceStatus === 'stale') status = 'stale_reference';
  else if (reviewers.length >= 2) status = 'approved';
  else status = 'needs_review';

  if (status === 'needs_review') {
    const need = 2 - reviewers.length;
    reasons.push(`目标版本上需 2 名不同复核人通过，当前 ${reviewers.length} 名（还差 ${need} 名）`);
  }
  if (evidenceStatus === 'ok' && status === 'approved') {
    reasons.push(reviewRevisionId === script.target_revision_id
      ? '双人复核通过，依据有效'
      : '双人复核通过；段落重排后依据指纹一致，原复核延续有效');
  }

  return {
    status, reasons,
    evidenceStatus,
    required: isNecessary,
    reviews: reviews.map(r => ({ reviewer: r.reviewer, at: r.created_at, comment: r.comment })),
    reviewerCount: reviewers.length,
  };
}

function clauseAliveInTarget(db, clauseId, fp, targetRevisionId) {
  if (!clauseId && !fp) return false;
  const clauses = getClauses(db, targetRevisionId);
  if (clauseId) {
    const direct = clauses.find(c => c.id === clauseId);
    if (direct) return direct.fingerprint === fp ? true : 'changed';
  }
  return clauses.some(c => c.fingerprint === fp) ? true : false;
}

function getScript(db, id) {
  const script = db.prepare('SELECT * FROM scripts WHERE id=?').get(id);
  if (!script) throw httpErr(404, '脚本不存在');
  return hydrateScript(db, script);
}

function hydrateScript(db, script) {
  const source = db.prepare('SELECT id,title,issuer,doc_no FROM sources WHERE id=?').get(script.source_id);
  const targetRevision = db.prepare('SELECT id,version,created_at FROM revisions WHERE id=?').get(script.target_revision_id);
  const baseRevision = script.base_revision_id
    ? db.prepare('SELECT id,version,created_at FROM revisions WHERE id=?').get(script.base_revision_id) : null;
  const clauses = getClauses(db, script.target_revision_id);
  const clauseMap = new Map(clauses.map(c => [c.id, c]));

  const sceneRows = db.prepare('SELECT * FROM scenes WHERE script_id=? ORDER BY scene_order').all(script.id);
  const scenes = sceneRows.map(sc => {
    const state = sc.deleted ? null : computeSceneState(db, sc, script, clauses);
    const clause = sc.linked_clause_id ? clauseMap.get(sc.linked_clause_id) : null;
    return {
      id: sc.id, order: sc.scene_order, kind: sc.kind, kindLabel: KIND_LABEL[sc.kind],
      title: sc.title, narration: sc.narration, subtitle: sc.subtitle, shotCard: sc.shot_card,
      contentVersion: sc.content_version,
      linkedClauseId: sc.linked_clause_id, linkedFingerprint: sc.linked_fingerprint,
      linkedRef: clause ? clause.ref : null,
      linkedClauseText: clause ? clause.text : null,
      deleted: !!sc.deleted, deleteReason: sc.delete_reason, deletedAt: sc.deleted_at,
      state,
    };
  });

  const active = scenes.filter(s => !s.deleted);
  const requiredActive = active.filter(s => s.state && s.state.required);
  const missing = active.filter(s => s.state?.status === 'missing_evidence');
  const stale = active.filter(s => s.state?.status === 'stale_reference');
  const needsReview = active.filter(s => s.state?.status === 'needs_review');
  // 发布门槛只针对必要办理提醒场次（开场/条件/材料/地点）；非必要场次不阻断
  const allApproved = requiredActive.length > 0
    && missing.length === 0 && stale.length === 0
    && requiredActive.every(s => s.state.status === 'approved');

  // 受影响场次（政策更新后按引用关系计算）
  const affectedScenes = stale.map(s => s.id);

  // 待复核原因聚合
  const pendingReasons = [];
  for (const s of [...missing, ...stale, ...needsReview]) {
    pendingReasons.push({ sceneId: s.id, kind: s.kindLabel, title: s.title,
      status: s.state.status, reasons: s.state.reasons });
  }

  let status = 'draft';
  if (allApproved) status = 'ready';
  else if (stale.length || missing.length) status = 'evidence_issue';
  else if (needsReview.length) status = 'in_review';

  const releases = db.prepare('SELECT id,version,revision_id,published_by,created_at FROM releases WHERE script_id=? ORDER BY version DESC').all(script.id);

  return {
    id: script.id, title: script.title, mode: script.mode,
    source, targetRevision, baseRevision,
    status, statusLabel: { draft: '草稿', in_review: '复核中', evidence_issue: '依据问题', ready: '可发布' }[status],
    allApproved, affectedSceneIds: affectedScenes, pendingReasons,
    scenes, releases, publishedVersion: script.published_version,
    createdAt: script.created_at, updatedAt: script.updated_at,
  };
}

function listScripts(db) {
  return db.prepare('SELECT * FROM scripts ORDER BY updated_at DESC').all().map(s => {
    const h = hydrateScript(db, s);
    return (({ id, title, mode, status, statusLabel, targetRevision, allApproved, affectedSceneIds, pendingReasons, publishedVersion, updatedAt }) =>
      ({ id, title, mode, status, statusLabel, targetRevision, allApproved, affectedSceneIds, pendingReasons, publishedVersion, updatedAt }))(h);
  });
}

function mustScript(db, id) {
  const s = db.prepare('SELECT * FROM scripts WHERE id=?').get(id);
  if (!s) throw httpErr(404, '脚本不存在');
  return s;
}

module.exports = {
  EVIDENCE_KINDS, KIND_LABEL,
  createScript, addScene, updateScene, deleteScene, moveScene, rebaseScript,
  getScript, listScripts, computeSceneState, mustScript, clauseAliveInTarget,
  log, httpErr,
};
