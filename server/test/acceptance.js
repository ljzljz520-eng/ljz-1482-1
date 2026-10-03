'use strict';
/**
 * 验收场景测试：
 *  1 来源段落重排 → 差异定位为 reorder，不触发复核失效
 *  2 日期订正 → date_change，follow 场次复核失效并记录原因；fixed 场次保留旧依据
 *  3 两人同时审核 → 一条成功，一条 409
 *  4 素材处理超时 → timeout，可重试成功
 *  5 发布时权限撤回 → 403（执行时校验）
 *  6 删场守卫 → 必要办理提醒不能悄悄删除
 *  7 导出校验 → 覆盖字幕/旁白/镜头卡/缺证据
 *  8 缺证据 → 网页数据可见，且复核被 422 拦截
 *  9 旧成果保留当时依据（发布快照冻结条款原文）
 * 10 无服务器页面经持久队列接入（claim/complete）
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../src/app');

const R1_TEXT = [
  '第一条 本指南适用于本县城乡居民基本医疗保险参保登记事项。',
  '[条件] 第二条 具有本县户籍，或持有本县有效居住证的居民，可申请办理参保登记。',
  '[材料] 第三条 办理时需提供本人有效身份证原件及复印件一份。',
  '[地点] 第四条 办理地点：县政务服务中心二楼医保综合窗口。',
  '[提醒] 第五条 集中参保缴费期为2025年9月1日至2025年12月31日，逾期将影响待遇享受。',
].join('\n');

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-studio-'));
  const { app, runWorkerOnce } = createApp({ dbPath: ':memory:', dataDir: tmp, worker: false, workerToken: 'test-token' });
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const api = async (method, url, { user = 'u_admin', body, headers = {} } = {}) => {
    const res = await fetch(base + url, {
      method,
      headers: { 'content-type': 'application/json', 'x-user-id': user, ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = null;
    try { json = await res.json(); } catch { /* empty */ }
    return { status: res.status, body: json };
  };

  let passed = 0;
  const ok = (name, cond, extra) => {
    assert.ok(cond, `FAILED: ${name}${extra ? ' — ' + JSON.stringify(extra) : ''}`);
    passed += 1;
    console.log(`  ✔ ${name}`);
  };

  // ---------- 准备：政策 + 修订R1 + 脚本 + 5场（含引用） ----------
  const policyId = (await api('POST', '/api/policies', { user: 'u_editor', body: { title: '医保参保登记指南（验收）' } })).body.policy.id;
  const rev1 = (await api('POST', `/api/policies/${policyId}/revisions`, { user: 'u_editor', body: { text: R1_TEXT, note: '首版' } })).body.revision;
  ok('创建首版修订 R1', !!rev1 && rev1.version_no === 1);

  const scriptId = (await api('POST', '/api/scripts', { user: 'u_editor', body: { policy_id: policyId, title: '《验收60秒》' } })).body.script.id;
  const mkScene = async (no, type, title, stmtType, para, clauseKey, pin) => {
    const sc = (await api('POST', `/api/scripts/${scriptId}/scenes`, {
      user: 'u_editor',
      body: { scene_no: no, scene_type: type, title, subtitle: `字幕${no}`, voiceover: `旁白${no}`, shot_card: `镜头卡${no}`, ...(pin || {}) },
    })).body.scene;
    const st = (await api('POST', `/api/scenes/${sc.id}/statements`, {
      user: 'u_editor', body: { stmt_type: stmtType, paraphrase: para, citations: clauseKey ? [clauseKey] : [] },
    })).body.statement;
    return { scene: sc, statement: st };
  };
  const S1 = await mkScene(1, 'opening', '开场', 'opening', '在本县参保登记这样办。', '第一条');
  const S2 = await mkScene(2, 'conditions', '条件', 'condition', '本县户籍或持居住证可办。', '第二条');
  const S3 = await mkScene(3, 'materials', '材料', 'material', '身份证原件及复印件一份。', '第三条');
  const S4 = await mkScene(4, 'location', '地点', 'location', '政务服务中心二楼医保窗口。', '第四条');
  const S5 = await mkScene(5, 'reminder', '参保期提醒', 'reminder', '集中参保期截至2025年12月31日。', '第五条');
  // 固定源文版本场（fixed）：钉在 R1
  const S6 = await mkScene(6, 'other', '政策依据说明（固定源文）', 'condition', '按首版指南第二条口径。', '第二条', { pin_mode: 'fixed', pinned_revision_id: rev1.id });

  // 全部复核通过（依据 R1）
  for (const s of [S1, S2, S3, S4, S5, S6]) {
    const r = await api('POST', `/api/scenes/${s.scene.id}/review`, { user: 'u_reviewer_a', body: { decision: 'approved', comment: '符合源文', expected_basis: rev1.id } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  }
  ok('6 场全部复核通过（依据 R1）', true);

  // 发布 v1（冻结当时依据）
  const v1 = (await api('GET', `/api/scripts/${scriptId}`)).body.script.versions[0];
  const pub1 = await api('POST', `/api/script-versions/${v1.id}/publish`, { user: 'u_publisher' });
  ok('发布 v1 成功', pub1.status === 200 && pub1.body.version.status === 'published', pub1.body);
  const snap1 = (await api('GET', `/api/script-versions/${v1.id}/snapshot`)).body.snapshot;
  ok('v1 快照冻结依据 R1 与条款原文', snap1.basis_revision_id === rev1.id &&
    snap1.scenes[1].statements[0].citations[0].excerpt.includes('有效居住证'));

  // ---------- 场景1：来源段落重排 ----------
  const reordered = [
    '[提醒] 第五条 集中参保缴费期为2025年9月1日至2025年12月31日，逾期将影响待遇享受。',
    '第一条 本指南适用于本县城乡居民基本医疗保险参保登记事项。',
    '[地点] 第四条 办理地点：县政务服务中心二楼医保综合窗口。',
    '[条件] 第二条 具有本县户籍，或持有本县有效居住证的居民，可申请办理参保登记。',
    '[材料] 第三条 办理时需提供本人有效身份证原件及复印件一份。',
  ].join('\n');
  const r2 = await api('POST', `/api/policies/${policyId}/revisions`, { user: 'u_editor', body: { text: reordered, note: '段落重排' } });
  ok('段落重排被差异定位为 reorder', r2.body.changes.length > 0 && r2.body.changes.every(c => c.change_type === 'reorder'), r2.body.changes);
  ok('段落重排不使任何复核失效', r2.body.impact.invalidated_reviews === 0 && r2.body.impact.affected_scripts.length === 0);
  let scriptView = (await api('GET', `/api/scripts/${scriptId}`)).body.script;
  ok('重排后场次的复核仍有效', scriptView.scenes.every(s => s.review.state === 'approved'));

  // ---------- 场景2：日期订正（follow 失效 / fixed 保留） ----------
  const rev2id = r2.body.revision.id;
  const dateFixed = [
    '第一条 本指南适用于本县城乡居民基本医疗保险参保登记事项。',
    '[条件] 第二条 具有本县户籍，或持有本县有效居住证的居民，可申请办理参保登记。',
    '[材料] 第三条 办理时需提供本人有效身份证原件及复印件一份。',
    '[地点] 第四条 办理地点：县政务服务中心二楼医保综合窗口。',
    '[提醒] 第五条 集中参保缴费期为2026年9月1日至2026年12月31日，逾期将影响待遇享受。',
  ].join('\n');
  const r3 = await api('POST', `/api/policies/${policyId}/revisions`, { user: 'u_editor', body: { text: dateFixed, note: '参保期日期订正' } });
  const dc = r3.body.changes.find(c => c.clause_key === '第五条');
  ok('日期订正被识别为 date_change', dc && dc.change_type === 'date_change', r3.body.changes);
  ok('影响计算命中引用第五条的脚本', r3.body.impact.affected_scripts.some(s => s.script_id === scriptId), r3.body.impact);
  scriptView = (await api('GET', `/api/scripts/${scriptId}`)).body.script;
  const s5view = scriptView.scenes.find(s => s.id === S5.scene.id);
  ok('follow 场次复核失效并给出待复核原因', s5view.review.state === 'invalidated' && /日期订正/.test(s5view.review.reason), s5view.review);
  const s1view = scriptView.scenes.find(s => s.id === S1.scene.id);
  ok('未引用变化条款的场次不受影响', s1view.review.state === 'approved');

  // 文本修订第二条 → fixed 场（S6）保留旧依据且不失效，follow 场（S2）失效
  const textChanged = dateFixed.replace('或持有本县有效居住证的居民，可申请办理参保登记', '且持有本县有效居住证满一年的居民，可申请办理参保登记');
  const r4 = await api('POST', `/api/policies/${policyId}/revisions`, { user: 'u_editor', body: { text: textChanged, note: '条件口径调整' } });
  ok('文本修订被识别为 text_change', r4.body.changes.some(c => c.clause_key === '第二条' && c.change_type === 'text_change'));
  scriptView = (await api('GET', `/api/scripts/${scriptId}`)).body.script;
  const s6view = scriptView.scenes.find(s => s.id === S6.scene.id);
  ok('fixed 场次复核保留（旧成果保留当时依据）', s6view.review.state === 'approved' && s6view.stale === true, s6view.review);
  const s2view = scriptView.scenes.find(s => s.id === S2.scene.id);
  ok('follow 场次（第二条）复核失效', s2view.review.state === 'invalidated' && /文本修订/.test(s2view.review.reason));
  const snap1b = (await api('GET', `/api/script-versions/${v1.id}/snapshot`)).body.snapshot;
  ok('v1 旧成果仍保留当时依据原文', snap1b.scenes[1].statements[0].citations[0].excerpt.includes('或持有本县有效居住证的居民，可申请'));

  // 只有相关场次重新复核通过后，才能发布新版本
  const v2id = (await api('POST', `/api/scripts/${scriptId}/versions`, { user: 'u_editor' })).body.version.id;
  const gate1 = await api('POST', `/api/script-versions/${v2id}/publish`, { user: 'u_publisher' });
  ok('存在失效复核时发布被门禁拦截', gate1.status === 422 && gate1.body.blockers.length >= 2, gate1.body);
  const rev4id = r4.body.revision.id;
  for (const sid of [S2.scene.id, S5.scene.id]) {
    const rr = await api('POST', `/api/scenes/${sid}/review`, { user: 'u_reviewer_b', body: { decision: 'approved', comment: '按新口径复核', expected_basis: rev4id } });
    assert.equal(rr.status, 201, JSON.stringify(rr.body));
  }
  const pub2 = await api('POST', `/api/script-versions/${v2id}/publish`, { user: 'u_publisher' });
  ok('相关场次重新复核通过后发布 v2 成功', pub2.status === 200 && pub2.body.version.basis_revision_id === rev4id, pub2.body);

  // ---------- 场景3：两人同时审核 ----------
  const S7 = await mkScene(7, 'other', '结尾提示', 'reminder', '请及时关注参保期。', '第五条');
  const [ra, rb] = await Promise.all([
    api('POST', `/api/scenes/${S7.scene.id}/review`, { user: 'u_reviewer_a', body: { decision: 'approved', comment: '甲通过', expected_basis: rev4id } }),
    api('POST', `/api/scenes/${S7.scene.id}/review`, { user: 'u_reviewer_b', body: { decision: 'approved', comment: '乙通过', expected_basis: rev4id } }),
  ]);
  const codes = [ra.status, rb.status].sort();
  ok('两人同时审核：一人成功一人 409 冲突', codes[0] === 201 && codes[1] === 409, { ra: ra.status, rb: rb.status });
  const stale = await api('POST', `/api/scenes/${S7.scene.id}/review`, { user: 'u_reviewer_b', body: { decision: 'approved', expected_basis: rev1.id } });
  ok('依据版本已变化时提交复核 → 409 basis_changed', stale.status === 409 && stale.body.error === 'basis_changed', stale.body);

  // ---------- 场景4：素材处理超时与重试 ----------
  const t1 = (await api('POST', '/api/tasks', { user: 'u_editor', body: { type: 'process_material', payload: { name: '片头动画.mp4', duration_ms: 600 }, timeout_ms: 120 } })).body.task;
  await runWorkerOnce();
  let t1v = (await api('GET', `/api/tasks`)).body.tasks.find(t => t.id === t1.id);
  ok('素材处理超时 → 任务标记 timeout', t1v.status === 'timeout' && /超时/.test(t1v.error), t1v);
  await api('POST', `/api/tasks/${t1.id}/retry`, { user: 'u_editor', body: { timeout_ms: 3000 } });
  await runWorkerOnce();
  t1v = (await api('GET', `/api/tasks`)).body.tasks.find(t => t.id === t1.id);
  ok('超时任务重试后完成', t1v.status === 'done' && t1v.result.processed === true, t1v);

  // ---------- 场景5：发布时权限撤回（执行时校验） ----------
  const v3id = (await api('POST', `/api/scripts/${scriptId}/versions`, { user: 'u_editor' })).body.version.id;
  await api('PUT', '/api/users/u_publisher', { user: 'u_admin', body: { permissions: ['task.run'] } }); // 撤回 publish
  const denied = await api('POST', `/api/script-versions/${v3id}/publish`, { user: 'u_publisher' });
  ok('发布时权限被撤回 → 403', denied.status === 403 && denied.body.error === 'forbidden', denied.body);
  await api('PUT', '/api/users/u_publisher', { user: 'u_admin', body: { permissions: ['publish', 'task.run'] } }); // 恢复
  const allowed = await api('POST', `/api/script-versions/${v3id}/publish`, { user: 'u_publisher' });
  ok('恢复权限后发布成功', allowed.status === 200, allowed.body);

  // ---------- 场景6：删场守卫（必要办理提醒不能悄悄删除） ----------
  const del1 = await api('DELETE', `/api/scenes/${S4.scene.id}`, { user: 'u_editor' });
  ok('唯一定位场次删除被拦截并说明原因', del1.status === 409 && del1.body.error === 'guarded_delete' && /办理地点/.test(JSON.stringify(del1.body.reasons)), del1.body);
  const del2 = await api('DELETE', `/api/scenes/${S4.scene.id}`, { user: 'u_editor', body: { ack: true, reason: '改版为字幕条呈现，已确认保留提醒' } });
  ok('显式确认+原因后可删除（留审计）', del2.status === 200 && del2.body.guarded === true);
  const audits = (await api('GET', '/api/audit')).body.audit;
  ok('守卫删除写入审计日志', audits.some(a => a.action === 'scene.delete' && a.detail.scene_id === S4.scene.id && a.detail.confirm_reason));
  // 恢复 S4 供后续校验
  const S4b = await mkScene(4, 'location', '地点', 'location', '政务服务中心二楼医保窗口。', '第四条');
  await api('POST', `/api/scenes/${S4b.scene.id}/review`, { user: 'u_reviewer_a', body: { decision: 'approved', expected_basis: rev4id } });

  // ---------- 场景7+8：导出校验与缺证据 ----------
  const bad = (await api('POST', `/api/scripts/${scriptId}/scenes`, {
    user: 'u_editor', body: { scene_no: 8, scene_type: 'materials', title: '空场', subtitle: '', voiceover: '', shot_card: '' },
  })).body.scene;
  await api('POST', `/api/scenes/${bad.id}/statements`, { user: 'u_editor', body: { stmt_type: 'material', paraphrase: '需要户口本。', citations: [] } });
  const v4id = (await api('POST', `/api/scripts/${scriptId}/versions`, { user: 'u_editor' })).body.version.id;
  const val = (await api('GET', `/api/script-versions/${v4id}/validate`)).body.validation;
  const fields = val.errors.map(e => e.field);
  ok('导出校验覆盖字幕/旁白/镜头卡', ['subtitle', 'voiceover', 'shot_card'].every(f => fields.includes(f)), val.errors);
  ok('导出校验覆盖缺证据', val.errors.some(e => e.field === 'evidence' && /缺少条款引用/.test(e.message)));
  scriptView = (await api('GET', `/api/scripts/${scriptId}`)).body.script;
  const badView = scriptView.scenes.find(s => s.id === bad.id);
  ok('网页数据展示缺证据与待复核原因', badView.missing_evidence.length > 0 && badView.review.state === 'none', badView.missing_evidence);
  const noEvidenceApprove = await api('POST', `/api/scenes/${bad.id}/review`, { user: 'u_reviewer_a', body: { decision: 'approved', expected_basis: rev4id } });
  ok('缺证据场次复核通过被 422 拦截（系统不补造条件）', noEvidenceApprove.status === 422 && noEvidenceApprove.body.error === 'missing_evidence');
  // 预览包任务因导出校验失败而失败
  const pv = (await api('POST', '/api/tasks', { user: 'u_editor', body: { type: 'generate_preview', payload: { script_version_id: v4id } } })).body.task;
  await runWorkerOnce();
  const pvv = (await api('GET', '/api/tasks')).body.tasks.find(t => t.id === pv.id);
  ok('导出校验未通过时预览包任务失败并给出原因', pvv.status === 'failed' && /导出校验未通过/.test(pvv.error), pvv.error);
  // 修复后预览包成功
  await api('PUT', `/api/scenes/${bad.id}`, { user: 'u_editor', body: { subtitle: '字幕8', voiceover: '旁白8', shot_card: '镜头卡8' } });
  const badStmt = (await api('GET', `/api/scripts/${scriptId}`)).body.script.scenes.find(s => s.id === bad.id).statements[0];
  await api('PUT', `/api/statements/${badStmt.id}`, { user: 'u_editor', body: { paraphrase: '身份证原件及复印件一份。', citations: ['第三条'] } });
  await api('POST', `/api/scenes/${bad.id}/review`, { user: 'u_reviewer_a', body: { decision: 'approved', expected_basis: rev4id } });
  const pv2 = (await api('POST', '/api/tasks', { user: 'u_editor', body: { type: 'generate_preview', payload: { script_version_id: v4id } } })).body.task;
  await runWorkerOnce();
  const pv2v = (await api('GET', '/api/tasks')).body.tasks.find(t => t.id === pv2.id);
  ok('修复后预览包生成成功（含 edit_list.json/preview.html/manifest.json）',
    pv2v.status === 'done' && pv2v.result.manifest.files.includes('preview.html'), pv2v);

  // ---------- 场景9：剪辑清单任务（本地 worker） ----------
  const el = (await api('POST', '/api/tasks', { user: 'u_editor', body: { type: 'generate_edit_list', payload: { script_version_id: v1.id } } })).body.task;
  await runWorkerOnce();
  const elv = (await api('GET', '/api/tasks')).body.tasks.find(t => t.id === el.id);
  ok('剪辑清单任务完成且内容来自引用条款', elv.status === 'done' &&
    elv.result.edit_list.items[1].statements[0].evidence[0].excerpt.includes('居住证'), elv.result && elv.result.edit_list.items[1]);

  // ---------- 场景10：无服务器页面经持久队列接入 ----------
  const tq = (await api('POST', '/api/tasks', { user: 'u_editor', body: { type: 'process_material', payload: { name: 'serverless-素材', duration_ms: 1 } } })).body.task;
  const badClaim = await api('POST', '/api/queue/claim', { headers: { 'x-worker-token': 'wrong' } });
  ok('无服务器接入需 worker 令牌', badClaim.status === 401);
  const claim = await api('POST', '/api/queue/claim', { headers: { 'x-worker-token': 'test-token' } });
  ok('无服务器 worker 认领持久队列任务', claim.status === 200 && claim.body.task && claim.body.task.id === tq.id, claim.body);
  const done = await api('POST', `/api/queue/${tq.id}/complete`, { headers: { 'x-worker-token': 'test-token' }, body: { result: { processed: true, by: 'serverless' } } });
  ok('无服务器 worker 回写任务结果', done.status === 200 && done.body.task.status === 'done');

  // 复核队列接口（网页待复核原因）
  const queueView = (await api('GET', '/api/review-queue')).body.queue;
  ok('复核队列接口可用', Array.isArray(queueView));

  console.log(`\n全部验收场景通过：${passed} 项断言`);
  server.close();
  process.exit(0);
}

main().catch(e => { console.error('验收失败:', e); process.exit(1); });
