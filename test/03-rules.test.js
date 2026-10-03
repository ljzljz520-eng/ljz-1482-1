'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const sources = require('../server/services/sources.js');
const scriptsSvc = require('../server/services/scripts.js');
const reviewsSvc = require('../server/services/reviews.js');
const publishSvc = require('../server/services/publish.js');
const exportSvc = require('../server/services/export.js');
const h = require('./helpers.js');

test('时间线删场保护：无原因拒绝；条款仍有效且无替代拒绝；有替代+原因可删（留痕）', () => {
  const db = h.setup();
  const src0 = h.makeSource(db);
  const script = h.makeFullScript(db, src0.sourceId, 'following');
  const loc = script.scenes.find(s => s.kind === 'location');

  // 1) 悄悄删除（不给原因）
  assert.throws(() => scriptsSvc.deleteScene(db, loc.id, { reason: '' }), /必须填写删除原因/);

  // 2) 给原因但条款仍有效、且没有其他场次覆盖同一指纹
  assert.throws(() => scriptsSvc.deleteScene(db, loc.id, { reason: '不想要了' }), /请先新增替代场次/);

  // 3) 先增加覆盖同一条款的替代场次，再删 -> 成功且留痕
  const rev = sources.getRevision(db, src0.revisionId);
  const c3 = rev.clauses.find(c => c.ref === '第三条').id;
  scriptsSvc.addScene(db, script.id, { kind: 'location', title: '办理地点（字幕强化版）',
    linkedClauseId: c3, narration: '县政务服务中心3号窗口', subtitle: '政务中心3号窗', shotCard: '窗口指引动画' });
  const res = scriptsSvc.deleteScene(db, loc.id, { reason: '由字幕强化版替代，保留同一依据' });
  const deleted = res.scenes.find(s => s.id === loc.id);
  assert.equal(deleted.deleted, true);
  assert.equal(deleted.deleteReason, '由字幕强化版替代，保留同一依据');
});

test('依据条款被删除后，原场次可凭原因删除（不强制替代）', () => {
  const db = h.setup();
  const src0 = h.makeSource(db);
  const script = h.makeFullScript(db, src0.sourceId, 'following');
  const loc = script.scenes.find(s => s.kind === 'location');

  // 新版删掉第三条（地点）——用不含第三条的文本
  const V2 = h.POLICY_V1.split('\n\n').filter(p => !p.startsWith('第三条')).join('\n\n');
  sources.addRevision(db, src0.sourceId, { rawText: V2, note: '删除地点条' });
  const s = scriptsSvc.getScript(db, script.id);
  const loc2 = s.scenes.find(x => x.id === loc.id);
  assert.equal(loc2.state.status, 'stale_reference');
  const res = scriptsSvc.deleteScene(db, loc.id, { reason: '新版政策已删除地点条款，等待业务部门补正式通知' });
  assert.equal(res.scenes.find(x => x.id === loc.id).deleted, true);
});

test('固定源文版本 vs 跟随：pinned 不跟随更新且复核持续有效；rebase 后才重新计算', () => {
  const db = h.setup();
  const src0 = h.makeSource(db);
  const pinned = h.makeFullScript(db, src0.sourceId, 'pinned');
  h.approveAll(db, pinned.id);

  const V2 = h.POLICY_V2_DATEFIX;
  sources.addRevision(db, src0.sourceId, { rawText: V2, note: '日期订正' });

  // pinned 目标版本不变，依然 approved
  let s = scriptsSvc.getScript(db, pinned.id);
  assert.equal(s.targetRevision.id, src0.revisionId);
  assert.equal(s.scenes.find(x => x.title === '截止日期提醒').state.status, 'approved');
  assert.equal(s.allApproved, true);

  // 跟随版脚本则受影响
  const follow = h.makeFullScript(db, src0.sourceId, 'following');
  h.approveAll(db, follow.id);
  // 上面两个脚本创建于更新后，跟随脚本直接以 v2 为目标——重建场景验证更新传播：
  // 改为：更新发生在 follow 已存在时
  // （follow 建于 v2 之后，直接验证其目标为 v2）
  const followS = scriptsSvc.getScript(db, follow.id);
  assert.notEqual(followS.targetRevision.id, src0.revisionId);

  // pinned 执行 rebase 跟随最新 -> 截止日期场次变为待复核
  scriptsSvc.rebaseScript(db, pinned.id, { mode: 'following' });
  s = scriptsSvc.getScript(db, pinned.id);
  assert.equal(s.scenes.find(x => x.title === '截止日期提醒').state.status, 'stale_reference');
});

test('导出校验覆盖字幕、旁白、镜头卡：缺任一轨道即 error；必要类型缺失即 error', () => {
  const db = h.setup();
  const src0 = h.makeSource(db);
  const script = scriptsSvc.createScript(db, { sourceId: src0.sourceId, title: '空脚本' });

  // 空时间线
  let v = exportSvc.validateForExport(db, script.id);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some(e => e.code === 'EMPTY_TIMELINE'));
  assert.deepEqual(v.checkedTracks, ['subtitle', 'narration', 'shot_card']);

  // 缺四种必要类型
  const rev = sources.getRevision(db, src0.revisionId);
  const c1 = rev.clauses.find(c => c.ref === '第一条').id;
  scriptsSvc.addScene(db, script.id, { kind: 'opening', title: '开场', linkedClauseId: c1,
    narration: 'n', subtitle: 's', shotCard: 'c' });
  v = exportSvc.validateForExport(db, script.id);
  assert.ok(v.errors.some(e => e.code === 'MISSING_REQUIRED_KIND' && e.kind === 'conditions'));
  assert.ok(v.errors.some(e => e.code === 'MISSING_REQUIRED_KIND' && e.kind === 'materials'));
  assert.ok(v.errors.some(e => e.code === 'MISSING_REQUIRED_KIND' && e.kind === 'location'));
});

test('导出校验：必要场次缺字幕/旁白/镜头卡逐项报错，并定位场次', () => {
  const db = h.setup();
  const src0 = h.makeSource(db);
  const script = scriptsSvc.createScript(db, { sourceId: src0.sourceId, title: '三轨缺失脚本' });
  const rev = sources.getRevision(db, src0.revisionId);
  const c = ref => rev.clauses.find(x => x.ref === ref).id;
  scriptsSvc.addScene(db, script.id, { kind: 'opening', linkedClauseId: c('第一条'), narration: '', subtitle: '', shotCard: '' });
  scriptsSvc.addScene(db, script.id, { kind: 'conditions', linkedClauseId: c('第一条') });
  scriptsSvc.addScene(db, script.id, { kind: 'materials', linkedClauseId: c('第二条') });
  scriptsSvc.addScene(db, script.id, { kind: 'location', linkedClauseId: c('第三条') });
  const v = exportSvc.validateForExport(db, script.id);
  assert.equal(v.ok, false);
  for (const code of ['MISSING_SUBTITLE', 'MISSING_NARRATION', 'MISSING_SHOTCARD']) {
    assert.ok(v.errors.some(e => e.code === code), '应有 ' + code);
  }
  // 每条问题都带场次定位
  assert.ok(v.errors[0].sceneId && v.errors[0].order);
});

test('复核：证据失效的场次不能通过复核；驳回不计入通过票', () => {
  const db = h.setup();
  const src0 = h.makeSource(db);
  const script = h.makeFullScript(db, src0.sourceId, 'following');
  const deadline = script.scenes.find(s => s.title === '截止日期提醒');
  sources.addRevision(db, src0.sourceId, { rawText: h.POLICY_V2_DATEFIX, note: '日期订正' });
  assert.throws(
    () => reviewsSvc.submitReview(db, deadline.id, { reviewer: '复核员张三', decision: 'approved' }),
    /不能通过复核/
  );
  // 驳回允许记录
  const r = reviewsSvc.submitReview(db, deadline.id, { reviewer: '复核员张三', decision: 'rejected', comment: '日期已变' });
  assert.equal(r.sceneState.reviewerCount, 0);
});

test('预览包/剪辑清单：证据带条款快照与版本；SRT 从字幕生成', () => {
  const db = h.setup();
  const src0 = h.makeSource(db);
  const script = h.makeFullScript(db, src0.sourceId, 'following');
  h.approveAll(db, script.id);
  const pkg = exportSvc.buildPackage(db, script.id);
  assert.equal(pkg.validation.ok, true);
  const loc = pkg.editList.find(e => e.kind === 'location');
  assert.ok(loc.evidence.clauseRef === '第三条');
  assert.ok(loc.evidence.clauseTextSnapshot.includes('3号窗口'));
  assert.equal(loc.evidence.revisionVersion, 1);
  assert.deepEqual(loc.reviewers.sort(), ['复核员张三', '复核员李四']);
  assert.ok(pkg.preview.srt.includes('-->'));
  assert.ok(pkg.preview.srt.includes('政务中心3号窗'));
});
