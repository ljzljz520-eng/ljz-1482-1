'use strict';
/**
 * REST API：来源修订 / 脚本场次 / 复核意见 / 异步任务 / 发布导出。
 * 权限在执行时实时校验（如发布时权限被撤回 → 403）。
 */
const { getUser, hasPerm, audit, now } = require('./db');
const { diffClauses, parseClauseInput, CHANGE_LABEL } = require('./diff');
const { applyRevisionImpact, latestRevisionId, effectiveRevisionId } = require('./impact');
const V = require('./validate');
const { buildSnapshot, buildEditList } = require('./editlist');
const Q = require('./queue');

function registerRoutes(app, ctx) {
  const { db } = ctx;

  // ---- 鉴权中间件：x-user-id ----
  app.use('/api', (req, res, next) => {
    req.user = getUser(db, req.get('x-user-id'));
    next();
  });
  const requirePerm = perm => (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'unauthenticated', message: '缺少 x-user-id' });
    if (!hasPerm(req.user, perm)) return res.status(403).json({ error: 'forbidden', message: `无 ${perm} 权限（执行时校验）`, user: req.user.id });
    next();
  };
  const workerAuth = (req, res, next) => {
    if (req.get('x-worker-token') !== ctx.workerToken) return res.status(401).json({ error: 'bad_worker_token' });
    next();
  };
  const get = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);

  // ---- 基础 ----
  app.get('/api/health', (req, res) => res.json({ ok: true, time: now() }));
  app.get('/api/me', (req, res) => res.json({ user: req.user }));
  app.get('/api/users', requirePerm('admin'), (req, res) => {
    res.json({ users: all('SELECT * FROM users ORDER BY id').map(u => ({ ...u, permissions: JSON.parse(u.permissions) })) });
  });
  app.put('/api/users/:id', requirePerm('admin'), (req, res) => {
    const u = get('SELECT * FROM users WHERE id=?', req.params.id);
    if (!u) return res.status(404).json({ error: 'not_found' });
    db.prepare('UPDATE users SET permissions=? WHERE id=?').run(JSON.stringify(req.body.permissions || []), u.id);
    audit(db, req.user.id, 'user.permissions.update', { target: u.id, permissions: req.body.permissions });
    res.json({ user: getUser(db, u.id) });
  });
  app.get('/api/overview', (req, res) => {
    res.json({
      policies: get('SELECT COUNT(*) c FROM policies').c,
      scripts: get('SELECT COUNT(*) c FROM scripts').c,
      revisions: get('SELECT COUNT(*) c FROM policy_revisions').c,
      tasks: all('SELECT status, COUNT(*) c FROM tasks GROUP BY status'),
      pending_review: all(`SELECT COUNT(DISTINCT sc.id) c FROM scenes sc WHERE sc.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM reviews r WHERE r.scene_id=sc.id AND r.decision='approved' AND r.invalidated_at IS NULL)`)[0].c,
      audit: all('SELECT * FROM audit_log ORDER BY id DESC LIMIT 20').map(a => ({ ...a, detail: JSON.parse(a.detail) })),
    });
  });
  app.get('/api/audit', (req, res) => {
    res.json({ audit: all('SELECT * FROM audit_log ORDER BY id DESC LIMIT 100').map(a => ({ ...a, detail: JSON.parse(a.detail) })) });
  });

  // ---- 政策与来源修订 ----
  app.post('/api/policies', requirePerm('policy.write'), (req, res) => {
    const r = db.prepare('INSERT INTO policies(title, created_at) VALUES (?,?)').run(String(req.body.title || '未命名政策'), now());
    audit(db, req.user.id, 'policy.create', { policy_id: r.lastInsertRowid });
    res.status(201).json({ policy: get('SELECT * FROM policies WHERE id=?', r.lastInsertRowid) });
  });
  app.get('/api/policies', (req, res) => {
    const rows = all('SELECT * FROM policies ORDER BY id DESC').map(p => ({
      ...p,
      latest_revision: get('SELECT id, version_no, created_at, note FROM policy_revisions WHERE policy_id=? ORDER BY version_no DESC LIMIT 1', p.id) || null,
      scripts: get('SELECT COUNT(*) c FROM scripts WHERE policy_id=?', p.id).c,
    }));
    res.json({ policies: rows });
  });
  app.get('/api/policies/:id', (req, res) => {
    const p = get('SELECT * FROM policies WHERE id=?', req.params.id);
    if (!p) return res.status(404).json({ error: 'not_found' });
    res.json({
      policy: p,
      revisions: all('SELECT * FROM policy_revisions WHERE policy_id=? ORDER BY version_no DESC', p.id)
        .map(r => ({ ...r, clauses: get('SELECT COUNT(*) c FROM clauses WHERE revision_id=?', r.id).c })),
      scripts: all('SELECT id, title FROM scripts WHERE policy_id=?', p.id),
    });
  });

  /** 新增来源修订：解析条款 → 差异定位 → 影响计算与失效规则（事务） */
  app.post('/api/policies/:id/revisions', requirePerm('policy.write'), (req, res) => {
    const policy = get('SELECT * FROM policies WHERE id=?', req.params.id);
    if (!policy) return res.status(404).json({ error: 'not_found' });
    const clausesInput = Array.isArray(req.body.clauses) ? req.body.clauses : parseClauseInput(req.body.text || '');
    if (clausesInput.length === 0) return res.status(422).json({ error: 'empty_revision', message: '修订内容为空' });
    try {
      const out = db.transaction(() => {
        const prev = get('SELECT * FROM policy_revisions WHERE policy_id=? ORDER BY version_no DESC LIMIT 1', policy.id);
        const versionNo = prev ? prev.version_no + 1 : 1;
        const revId = db.prepare('INSERT INTO policy_revisions(policy_id, version_no, note, created_by, created_at) VALUES (?,?,?,?,?)')
          .run(policy.id, versionNo, String(req.body.note || ''), req.user.id, now()).lastInsertRowid;
        const ins = db.prepare('INSERT INTO clauses(revision_id, clause_key, para_index, kind, text) VALUES (?,?,?,?,?)');
        clausesInput.forEach((c, i) => ins.run(revId, c.clause_key || `P${i + 1}`, c.para_index || i + 1, c.kind || 'other', c.text));
        const newClauses = all('SELECT * FROM clauses WHERE revision_id=?', revId);
        let changes = [], impact = { changes: [], affected_scripts: [], invalidated_reviews: 0 };
        if (prev) {
          const oldClauses = all('SELECT * FROM clauses WHERE revision_id=?', prev.id);
          changes = diffClauses(oldClauses, newClauses);
          impact = applyRevisionImpact(db, policy.id, prev.id, revId, changes, req.user.id);
        }
        audit(db, req.user.id, 'policy.revision.create', { policy_id: policy.id, revision_id: revId, version_no: versionNo, changes: changes.length });
        return { revision: get('SELECT * FROM policy_revisions WHERE id=?', revId), changes, impact };
      })();
      res.status(201).json(out);
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'duplicate_clause_key', message: '同一修订内条款号重复' });
      throw e;
    }
  });

  /** 差异定位：任意两个修订之间 */
  app.get('/api/policies/:id/diff', (req, res) => {
    const from = get('SELECT * FROM policy_revisions WHERE id=? AND policy_id=?', req.query.from, req.params.id);
    const to = get('SELECT * FROM policy_revisions WHERE id=? AND policy_id=?', req.query.to, req.params.id);
    if (!from || !to) return res.status(404).json({ error: 'revision_not_found' });
    const changes = diffClauses(all('SELECT * FROM clauses WHERE revision_id=?', from.id), all('SELECT * FROM clauses WHERE revision_id=?', to.id));
    res.json({ from, to, changes: changes.map(c => ({ ...c, label: CHANGE_LABEL[c.change_type] })) });
  });

  app.get('/api/revisions/:id/clauses', (req, res) => {
    res.json({ clauses: all('SELECT * FROM clauses WHERE revision_id=? ORDER BY para_index', req.params.id) });
  });

  // ---- 脚本与场次 ----
  app.post('/api/scripts', requirePerm('script.write'), (req, res) => {
    const policy = get('SELECT * FROM policies WHERE id=?', req.body.policy_id);
    if (!policy) return res.status(404).json({ error: 'policy_not_found' });
    const out = db.transaction(() => {
      const sid = db.prepare('INSERT INTO scripts(policy_id, title, created_at) VALUES (?,?,?)')
        .run(policy.id, String(req.body.title || '未命名脚本'), now()).lastInsertRowid;
      db.prepare('INSERT INTO script_versions(script_id, version_no, status, created_at) VALUES (?,?,?,?)')
        .run(sid, 1, 'draft', now());
      audit(db, req.user.id, 'script.create', { script_id: sid });
      return sid;
    })();
    res.status(201).json({ script: scriptView(out) });
  });
  app.get('/api/scripts', (req, res) => {
    const rows = req.query.policy_id
      ? all('SELECT * FROM scripts WHERE policy_id=? ORDER BY id DESC', req.query.policy_id)
      : all('SELECT * FROM scripts ORDER BY id DESC');
    res.json({ scripts: rows.map(s => ({ ...s, policy: get('SELECT id,title FROM policies WHERE id=?', s.policy_id) })) });
  });

  function sceneView(scene, policyId, latestRevId) {
    const eff = effectiveRevisionId(db, scene, policyId);
    const statements = V.sceneStatements(db, scene.id).map(s => ({
      ...s,
      citations: s.citations.map(key => {
        const cl = get('SELECT text FROM clauses WHERE revision_id=? AND clause_key=?', eff, key);
        return { clause_key: key, exists: !!cl, excerpt: cl ? cl.text : null };
      }),
    }));
    const approval = V.activeApproval(db, scene.id);
    const invalidated = V.latestInvalidated(db, scene.id);
    const missing = V.sceneEvidenceIssues(db, scene, eff);
    const revNo = rid => { const r = get('SELECT version_no FROM policy_revisions WHERE id=?', rid); return r ? r.version_no : null; };
    const review = approval
      ? { state: 'approved', reviewer_id: approval.reviewer_id, basis_revision_id: approval.basis_revision_id, basis_revision_no: revNo(approval.basis_revision_id), comment: approval.comment, at: approval.created_at }
      : invalidated
        ? { state: 'invalidated', reason: invalidated.invalidation_reason, at: invalidated.invalidated_at }
        : { state: 'none', reason: '尚未复核' };
    return {
      ...scene, statements, effective_revision_id: eff, effective_revision_no: revNo(eff),
      stale: scene.pin_mode === 'fixed' && !!scene.pinned_revision_id && scene.pinned_revision_id !== latestRevId,
      missing_evidence: missing, review,
    };
  }
  function scriptView(scriptId) {
    const script = get('SELECT * FROM scripts WHERE id=?', scriptId);
    if (!script) return null;
    const latestRevId = latestRevisionId(db, script.policy_id);
    const scenes = all('SELECT * FROM scenes WHERE script_id=? AND deleted_at IS NULL ORDER BY scene_no', script.id)
      .map(sc => sceneView(sc, script.policy_id, latestRevId));
    const revNo = rid => { const r = get('SELECT version_no FROM policy_revisions WHERE id=?', rid); return r ? r.version_no : null; };
    return {
      ...script,
      policy: get('SELECT id, title FROM policies WHERE id=?', script.policy_id),
      latest_revision_id: latestRevId,
      latest_revision_no: revNo(latestRevId),
      revisions: all('SELECT id, version_no, note, created_at FROM policy_revisions WHERE policy_id=? ORDER BY version_no DESC', script.policy_id),
      scenes,
      versions: all('SELECT * FROM script_versions WHERE script_id=? ORDER BY version_no DESC', script.id)
        .map(v => ({ ...v, basis_revision_no: revNo(v.basis_revision_id) })),
    };
  }
  app.get('/api/scripts/:id', (req, res) => {
    const v = scriptView(Number(req.params.id));
    if (!v) return res.status(404).json({ error: 'not_found' });
    res.json({ script: v });
  });

  app.post('/api/scripts/:id/scenes', requirePerm('script.write'), (req, res) => {
    const script = get('SELECT * FROM scripts WHERE id=?', req.params.id);
    if (!script) return res.status(404).json({ error: 'not_found' });
    const maxNo = get('SELECT COALESCE(MAX(scene_no),0) m FROM scenes WHERE script_id=?', script.id).m;
    const id = db.prepare(`INSERT INTO scenes(script_id, scene_no, scene_type, title, pin_mode, pinned_revision_id, subtitle, voiceover, shot_card, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(script.id, req.body.scene_no || maxNo + 1, req.body.scene_type || 'other', String(req.body.title || ''),
        req.body.pin_mode === 'fixed' ? 'fixed' : 'follow', req.body.pinned_revision_id || null,
        String(req.body.subtitle || ''), String(req.body.voiceover || ''), String(req.body.shot_card || ''), now()).lastInsertRowid;
    audit(db, req.user.id, 'scene.create', { scene_id: id, script_id: script.id });
    res.status(201).json({ scene: get('SELECT * FROM scenes WHERE id=?', id) });
  });

  app.put('/api/scenes/:id', requirePerm('script.write'), (req, res) => {
    const scene = get('SELECT * FROM scenes WHERE id=? AND deleted_at IS NULL', req.params.id);
    if (!scene) return res.status(404).json({ error: 'not_found' });
    const f = ['scene_no', 'scene_type', 'title', 'pin_mode', 'pinned_revision_id', 'subtitle', 'voiceover', 'shot_card'];
    const sets = [], vals = [];
    for (const k of f) if (k in req.body) { sets.push(`${k}=?`); vals.push(req.body[k]); }
    if (sets.length) {
      db.prepare(`UPDATE scenes SET ${sets.join(',')}, updated_at=? WHERE id=?`).run(...vals, now(), scene.id);
      audit(db, req.user.id, 'scene.update', { scene_id: scene.id, fields: Object.keys(req.body) });
    }
    res.json({ scene: get('SELECT * FROM scenes WHERE id=?', scene.id) });
  });

  /** 删场：必要办理提醒守卫，不能悄悄删除 */
  app.delete('/api/scenes/:id', requirePerm('script.write'), (req, res) => {
    const scene = get('SELECT * FROM scenes WHERE id=? AND deleted_at IS NULL', req.params.id);
    if (!scene) return res.status(404).json({ error: 'not_found' });
    const guard = V.deletionGuard(db, scene.id);
    const ack = req.body && req.body.ack === true;
    const reason = req.body && req.body.reason;
    if (guard.guarded && !(ack && reason)) {
      return res.status(409).json({ error: 'guarded_delete', message: '该场承载必要办理提醒，需显式确认并填写原因', reasons: guard.reasons });
    }
    db.prepare('UPDATE scenes SET deleted_at=? WHERE id=?').run(now(), scene.id);
    audit(db, req.user.id, 'scene.delete', { scene_id: scene.id, guarded: guard.guarded, guard_reasons: guard.reasons, confirm_reason: reason || null });
    res.json({ deleted: true, guarded: guard.guarded });
  });

  // ---- 陈述与引用（改写不是法律判断，必须引用条款） ----
  app.post('/api/scenes/:id/statements', requirePerm('script.write'), (req, res) => {
    const scene = get('SELECT * FROM scenes WHERE id=? AND deleted_at IS NULL', req.params.id);
    if (!scene) return res.status(404).json({ error: 'not_found' });
    const out = db.transaction(() => {
      const sid = db.prepare('INSERT INTO scene_statements(scene_id, stmt_type, paraphrase, updated_at) VALUES (?,?,?,?)')
        .run(scene.id, req.body.stmt_type || 'other', String(req.body.paraphrase || ''), now()).lastInsertRowid;
      const ins = db.prepare('INSERT OR IGNORE INTO statement_citations(statement_id, clause_key) VALUES (?,?)');
      for (const k of req.body.citations || []) ins.run(sid, String(k));
      invalidateApprovals(scene.id, '陈述内容在复核后被修改，需重新复核');
      return sid;
    })();
    audit(db, req.user.id, 'statement.create', { statement_id: out, scene_id: scene.id });
    res.status(201).json({ statement: get('SELECT * FROM scene_statements WHERE id=?', out) });
  });

  app.put('/api/statements/:id', requirePerm('script.write'), (req, res) => {
    const st = get('SELECT * FROM scene_statements WHERE id=?', req.params.id);
    if (!st) return res.status(404).json({ error: 'not_found' });
    db.transaction(() => {
      if ('paraphrase' in req.body) db.prepare('UPDATE scene_statements SET paraphrase=?, updated_at=? WHERE id=?').run(String(req.body.paraphrase), now(), st.id);
      if (Array.isArray(req.body.citations)) {
        db.prepare('DELETE FROM statement_citations WHERE statement_id=?').run(st.id);
        const ins = db.prepare('INSERT OR IGNORE INTO statement_citations(statement_id, clause_key) VALUES (?,?)');
        for (const k of req.body.citations) ins.run(st.id, String(k));
      }
      invalidateApprovals(st.scene_id, '改写内容在复核后被修改，需重新复核');
    })();
    audit(db, req.user.id, 'statement.update', { statement_id: st.id });
    res.json({ statement: get('SELECT * FROM scene_statements WHERE id=?', st.id) });
  });

  app.delete('/api/statements/:id', requirePerm('script.write'), (req, res) => {
    const st = get('SELECT * FROM scene_statements WHERE id=?', req.params.id);
    if (!st) return res.status(404).json({ error: 'not_found' });
    db.transaction(() => {
      db.prepare('DELETE FROM statement_citations WHERE statement_id=?').run(st.id);
      db.prepare('DELETE FROM scene_statements WHERE id=?').run(st.id);
      invalidateApprovals(st.scene_id, '陈述在复核后被删除，需重新复核');
    })();
    audit(db, req.user.id, 'statement.delete', { statement_id: st.id, scene_id: st.scene_id });
    res.json({ deleted: true });
  });

  function invalidateApprovals(sceneId, reason) {
    db.prepare(`UPDATE reviews SET invalidated_at=?, invalidation_reason=? WHERE scene_id=? AND decision='approved' AND invalidated_at IS NULL`)
      .run(now(), reason, sceneId);
  }

  // ---- 复核（两人同时审核 → 冲突 409） ----
  app.post('/api/scenes/:id/review', requirePerm('review'), (req, res) => {
    const scene = get('SELECT * FROM scenes WHERE id=? AND deleted_at IS NULL', req.params.id);
    if (!scene) return res.status(404).json({ error: 'not_found' });
    const script = get('SELECT * FROM scripts WHERE id=?', scene.script_id);
    const eff = effectiveRevisionId(db, scene, script.policy_id);
    const decision = req.body.decision === 'rejected' ? 'rejected' : 'approved';
    if (req.body.expected_basis && Number(req.body.expected_basis) !== eff) {
      return res.status(409).json({ error: 'basis_changed', message: '依据版本已变化，请刷新后重新复核', effective_revision_id: eff });
    }
    if (decision === 'approved') {
      const issues = V.sceneEvidenceIssues(db, scene, eff);
      if (issues.length) return res.status(422).json({ error: 'missing_evidence', message: '存在缺证据陈述，不能复核通过', issues });
      const existing = V.activeApproval(db, scene.id);
      if (existing) return res.status(409).json({ error: 'already_reviewed', message: `该场已由 ${existing.reviewer_id} 复核通过`, review: existing });
    }
    try {
      const id = db.prepare('INSERT INTO reviews(scene_id, reviewer_id, basis_revision_id, decision, comment, created_at) VALUES (?,?,?,?,?,?)')
        .run(scene.id, req.user.id, eff, decision, String(req.body.comment || ''), now()).lastInsertRowid;
      audit(db, req.user.id, 'review.submit', { review_id: id, scene_id: scene.id, decision, basis: eff });
      res.status(201).json({ review: get('SELECT * FROM reviews WHERE id=?', id) });
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) {
        return res.status(409).json({ error: 'already_reviewed', message: '他人已提交通过意见（并发冲突），请刷新' });
      }
      throw e;
    }
  });

  /** 待复核队列：网页显示缺证据与待复核原因 */
  app.get('/api/review-queue', (req, res) => {
    const scripts = all('SELECT * FROM scripts ORDER BY id');
    const items = [];
    for (const script of scripts) {
      const latestRevId = latestRevisionId(db, script.policy_id);
      const policy = get('SELECT id, title FROM policies WHERE id=?', script.policy_id);
      for (const scene of all('SELECT * FROM scenes WHERE script_id=? AND deleted_at IS NULL ORDER BY scene_no', script.id)) {
        const view = sceneView(scene, script.policy_id, latestRevId);
        const reasons = [];
        for (const iss of view.missing_evidence) reasons.push(iss.message);
        if (view.review.state === 'none') reasons.push('尚未复核');
        if (view.review.state === 'invalidated') reasons.push(`复核已失效：${view.review.reason}`);
        if (view.stale) reasons.push('固定源文场次：源文已有新版本（旧成果仍有效）');
        if (reasons.length) {
          items.push({
            scene_id: scene.id, scene_no: scene.scene_no, title: scene.title, scene_type: scene.scene_type,
            script_id: script.id, script_title: script.title, policy_title: policy.title,
            review_state: view.review.state, missing_evidence: view.missing_evidence,
            reasons, effective_revision_id: view.effective_revision_id,
            effective_revision_no: view.effective_revision_no, stale: view.stale,
          });
        }
      }
    }
    res.json({ queue: items });
  });

  // ---- 版本与发布 ----
  app.post('/api/scripts/:id/versions', requirePerm('script.write'), (req, res) => {
    const script = get('SELECT * FROM scripts WHERE id=?', req.params.id);
    if (!script) return res.status(404).json({ error: 'not_found' });
    const maxV = get('SELECT COALESCE(MAX(version_no),0) m FROM script_versions WHERE script_id=?', script.id).m;
    const id = db.prepare('INSERT INTO script_versions(script_id, version_no, status, created_at) VALUES (?,?,?,?)')
      .run(script.id, maxV + 1, 'draft', now()).lastInsertRowid;
    audit(db, req.user.id, 'script.version.create', { script_id: script.id, version_id: id });
    res.status(201).json({ version: get('SELECT * FROM script_versions WHERE id=?', id) });
  });

  app.get('/api/script-versions/:id', (req, res) => {
    const v = get('SELECT * FROM script_versions WHERE id=?', req.params.id);
    if (!v) return res.status(404).json({ error: 'not_found' });
    res.json({ version: v, validation: V.validateExport(db, v.id), gate: V.publishGate(db, v.id) });
  });

  /** 发布：执行时重新校验权限 + 门禁（受影响场次须重新复核通过） + 冻结依据快照 */
  /** 导出校验（字幕/旁白/镜头卡/证据链） */
  app.get('/api/script-versions/:id/validate', (req, res) => {
    const v = get('SELECT * FROM script_versions WHERE id=?', req.params.id);
    if (!v) return res.status(404).json({ error: 'not_found' });
    res.json({ validation: V.validateExport(db, v.id), gate: V.publishGate(db, v.id) });
  });

  app.post('/api/script-versions/:id/publish', requirePerm('publish'), (req, res) => {
    const v = get('SELECT * FROM script_versions WHERE id=?', req.params.id);
    if (!v) return res.status(404).json({ error: 'not_found' });
    if (v.status === 'published') return res.status(409).json({ error: 'already_published' });
    try {
      const out = db.transaction(() => {
        const freshUser = getUser(db, req.user.id); // 执行时权限校验：撤回即失败
        if (!hasPerm(freshUser, 'publish')) {
          const err = new Error('publish permission revoked'); err.status = 403;
          err.body = { error: 'forbidden', message: '发布权限已被撤回（执行时校验）' };
          throw err;
        }
        const gate = V.publishGate(db, v.id);
        if (!gate.ok) {
          const err = new Error('publish gate blocked'); err.status = 422;
          err.body = { error: 'gate_blocked', message: '发布门禁未通过', blockers: gate.blockers };
          throw err;
        }
        const script = get('SELECT * FROM scripts WHERE id=?', v.script_id);
        const basis = latestRevisionId(db, script.policy_id);
        db.prepare(`UPDATE script_versions SET status='published', basis_revision_id=?, published_at=?, published_by=? WHERE id=?`)
          .run(basis, now(), req.user.id, v.id);
        const snapshot = buildSnapshot(db, v.id);
        const snapId = db.prepare('INSERT INTO published_snapshots(script_version_id, snapshot_json, created_at) VALUES (?,?,?)')
          .run(v.id, JSON.stringify(snapshot), now()).lastInsertRowid;
        audit(db, req.user.id, 'script.version.publish', { version_id: v.id, basis_revision_id: basis });
        const ver = get('SELECT * FROM script_versions WHERE id=?', v.id);
        ver.basis_revision_no = get('SELECT version_no FROM policy_revisions WHERE id=?', basis).version_no;
        return { version: ver, snapshot_id: snapId };
      })();
      res.json(out);
    } catch (e) {
      if (e.status) return res.status(e.status).json(e.body);
      throw e;
    }
  });

  app.get('/api/script-versions/:id/snapshot', (req, res) => {
    const snap = get('SELECT * FROM published_snapshots WHERE script_version_id=? ORDER BY id DESC LIMIT 1', req.params.id);
    if (!snap) return res.status(404).json({ error: 'no_snapshot' });
    res.json({ snapshot: JSON.parse(snap.snapshot_json), created_at: snap.created_at });
  });

  /** 剪辑清单（同步预览用；正式产物走异步任务） */
  app.get('/api/script-versions/:id/edit-list', (req, res) => {
    try { res.json({ edit_list: buildEditList(db, Number(req.params.id)) }); }
    catch (e) { res.status(404).json({ error: e.message }); }
  });

  // ---- 异步任务（持久队列） ----
  app.post('/api/tasks', requirePerm('task.run'), (req, res) => {
    const allowed = ['generate_edit_list', 'generate_preview', 'process_material'];
    if (!allowed.includes(req.body.type)) return res.status(422).json({ error: 'bad_type', allowed });
    const t = Q.enqueue(db, req.body.type, req.body.payload || {}, { timeoutMs: req.body.timeout_ms, maxAttempts: req.body.max_attempts });
    audit(db, req.user.id, 'task.enqueue', { task_id: t.id, type: t.type });
    res.status(201).json({ task: t });
  });
  app.get('/api/tasks', (req, res) => {
    const rows = req.query.status ? all('SELECT * FROM tasks WHERE status=? ORDER BY id DESC LIMIT 100', req.query.status)
      : all('SELECT * FROM tasks ORDER BY id DESC LIMIT 100');
    res.json({ tasks: rows.map(t => ({ ...t, payload: JSON.parse(t.payload), result: t.result ? JSON.parse(t.result) : null })) });
  });
  app.post('/api/tasks/:id/retry', requirePerm('task.run'), (req, res) => {
    const t = Q.retry(db, Number(req.params.id), { timeoutMs: req.body && req.body.timeout_ms, actor: req.user.id });
    if (!t) return res.status(404).json({ error: 'not_found' });
    res.json({ task: t });
  });

  // ---- 无服务器页面接入：同一持久队列 ----
  app.post('/api/queue/claim', workerAuth, (req, res) => {
    const t = Q.claimNext(db, req.get('x-worker-id') || 'serverless-worker');
    if (!t) return res.json({ task: null });
    res.json({ task: { ...t, payload: JSON.parse(t.payload) } });
  });
  app.post('/api/queue/:id/complete', workerAuth, (req, res) => {
    res.json({ task: Q.complete(db, Number(req.params.id), req.body.result) });
  });
  app.post('/api/queue/:id/fail', workerAuth, (req, res) => {
    res.json({ task: Q.fail(db, Number(req.params.id), req.body.error || 'failed') });
  });

  // ---- 产物 ----
  app.get('/api/artifacts', (req, res) => {
    const cond = [], args = [];
    if (req.query.script_version_id) { cond.push('script_version_id=?'); args.push(req.query.script_version_id); }
    if (req.query.kind) { cond.push('kind=?'); args.push(req.query.kind); }
    const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
    const rows = all(`SELECT * FROM artifacts ${where} ORDER BY id DESC LIMIT 50`, ...args);
    res.json({ artifacts: rows.map(a => ({ ...a, json: a.json ? JSON.parse(a.json) : null })) });
  });
}

module.exports = { registerRoutes };
