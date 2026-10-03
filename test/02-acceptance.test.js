'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const sources = require('../server/services/sources.js');
const scriptsSvc = require('../server/services/scripts.js');
const reviewsSvc = require('../server/services/reviews.js');
const publishSvc = require('../server/services/publish.js');
const exportSvc = require('../server/services/export.js');
const queue = require('../server/services/queue.js');
const handlers = require('../server/services/handlers.js');
const h = require('./helpers.js');

// ——————————————————————————————————————————————
// 验收1：来源段落重排 —— 引用按指纹对齐，已通过复核不失效
// ——————————————————————————————————————————————
test('验收① 段落重排：内容指纹不变，双人复核继续有效，可直接发布新版本', () => {
  const db = h.setup();
  const src0 = h.makeSource(db);
  const script = h.makeFullScript(db, src0.sourceId, 'following');
  const approved = h.approveAll(db, script.id);
  assert.equal(approved.allApproved, true);
  const locScene = approved.scenes.find(s => s.kind === 'location');

  // 源文更新：仅段落重排
  const v2 = sources.addRevision(db, src0.sourceId, { rawText: h.POLICY_V2_REORDER, note: '排版调整' });
  assert.equal(v2.diff.reorderedOnly, true);

  const after = scriptsSvc.getScript(db, script.id);
  // 目标版本已跟随到 v2
  assert.equal(after.targetRevision.id, v2.id);
  const locAfter = after.scenes.find(s => s.kind === 'location');
  // 旧条款 id 在新版本中已变化，但按指纹仍然有效；双人审核结果保留
  assert.equal(locAfter.state.status, 'approved');
  assert.ok(locAfter.state.reasons.some(r => r.includes('段落重排')));
  assert.equal(after.allApproved, true);

  // 可以发布（不要求重新复核）
  const intent = publishSvc.createPublishIntent(db, script.id, { publisher: '发布员王五' });
  const rel = publishSvc.publish(db, script.id, { publisher: '发布员王五', permissionToken: intent.permissionToken });
  assert.equal(rel.version, 1);
});

// ——————————————————————————————————————————————
// 验收2：日期订正 —— 只有相关场次（引用第四条）失效，其它场次不受影响
// ——————————————————————————————————————————————
test('验收② 日期订正：仅引用变化条款的场次进入待复核，重新双审通过后才可发布；旧版成果保留', () => {
  const db = h.setup();
  const src0 = h.makeSource(db);
  const script = h.makeFullScript(db, src0.sourceId, 'following');
  h.approveAll(db, script.id);
  const first = scriptsSvc.getScript(db, script.id);
  assert.equal(first.allApproved, true);

  // 先发布 v1（旧成果）
  let intent = publishSvc.createPublishIntent(db, script.id, { publisher: '发布员王五' });
  const rel1 = publishSvc.publish(db, script.id, { publisher: '发布员王五', permissionToken: intent.permissionToken });
  assert.equal(rel1.version, 1);

  // 源文日期订正：第四条 6月1日 -> 7月15日
  const v2 = sources.addRevision(db, src0.sourceId, { rawText: h.POLICY_V2_DATEFIX, note: '日期订正' });
  assert.equal(v2.diff.summary.dateChanged, 1);

  let s = scriptsSvc.getScript(db, script.id);
  const deadline = s.scenes.find(x => x.title === '截止日期提醒');
  // 只有引用第四条的场次失效
  assert.equal(deadline.state.status, 'stale_reference');
  assert.ok(deadline.state.reasons.some(r => r.includes('更新') || r.includes('删除或改写')));
  assert.equal(s.scenes.find(x => x.kind === 'location').state.status, 'approved');
  assert.equal(s.scenes.find(x => x.kind === 'materials').state.status, 'approved');
  assert.equal(s.allApproved, false);

  // 未复核通过前不能发布新版本
  assert.throws(() => publishSvc.createPublishIntent(db, script.id, { publisher: '发布员王五' }), /未通过发布校验/);

  // 人工改引到新条款（系统不自行补造日期），改内容后重新双审
  const rev2 = sources.getRevision(db, v2.id);
  const c4v2 = rev2.clauses.find(c => c.ref === '第四条').id;
  scriptsSvc.updateScene(db, deadline.id, {
    linkedClauseId: c4v2, narration: '申请7月15日截止，逾期不候', subtitle: '截止：2025年7月15日',
  });
  s = scriptsSvc.getScript(db, script.id);
  const dl2 = s.scenes.find(x => x.title === '截止日期提醒');
  assert.equal(dl2.state.status, 'needs_review'); // 内容版本变化，旧复核失效
  reviewsSvc.submitReview(db, dl2.id, { reviewer: '复核员张三', decision: 'approved' });
  reviewsSvc.submitReview(db, dl2.id, { reviewer: '复核员李四', decision: 'approved' });
  s = scriptsSvc.getScript(db, script.id);
  assert.equal(s.allApproved, true);

  // 发布 v2
  intent = publishSvc.createPublishIntent(db, script.id, { publisher: '发布员王五' });
  const rel2 = publishSvc.publish(db, script.id, { publisher: '发布员王五', permissionToken: intent.permissionToken });
  assert.equal(rel2.version, 2);

  // 旧成果保留当时依据
  const old = publishSvc.getRelease(db, script.id, 1);
  const neu = publishSvc.getRelease(db, script.id, 2);
  const v1c4 = old.snapshot.basisRevision.clauses.find(c => c.ref === '第四条');
  const v2c4 = neu.snapshot.basisRevision.clauses.find(c => c.ref === '第四条');
  assert.ok(v1c4.text.includes('2025年6月1日'));
  assert.ok(v2c4.text.includes('2025年7月15日'));
});

test('验收③ 两人同时审核：并发下同一复核人只计一票，满两票才通过', () => {
  const db = h.setup();
  const src0 = h.makeSource(db);
  const script = h.makeFullScript(db, src0.sourceId, 'following');
  const loc = script.scenes.find(s => s.kind === 'location');

  // 同一人并发提交两次"通过"
  const worker = require('node:worker_threads');
  const results = [];
  // 直接在事务层并发模拟：better-sqlite3 同步执行，用两个交错调用 + 唯一约束
  reviewsSvc.submitReview(db, loc.id, { reviewer: '复核员张三', decision: 'approved' });
  const r1 = scriptsSvc.getScript(db, script.id).scenes.find(s => s.id === loc.id);
  assert.equal(r1.state.reviewerCount, 1);
  assert.equal(r1.state.status, 'needs_review');
  // 张三再来一次（重复），upsert 后仍然只有 1 个不同复核人
  reviewsSvc.submitReview(db, loc.id, { reviewer: '复核员张三', decision: 'approved', comment: '再确认' });
  const r2 = scriptsSvc.getScript(db, script.id).scenes.find(s => s.id === loc.id);
  assert.equal(r2.state.reviewerCount, 1);
  assert.equal(r2.state.status, 'needs_review');
  // 李四第二票
  reviewsSvc.submitReview(db, loc.id, { reviewer: '复核员李四', decision: 'approved' });
  const r3 = scriptsSvc.getScript(db, script.id).scenes.find(s => s.id === loc.id);
  assert.equal(r3.state.reviewerCount, 2);
  assert.equal(r3.state.status, 'approved');
});

// ——————————————————————————————————————————————
// 验收4：素材处理超时 —— 任务退避重试，超次数 dead；成功路径 ready
// ——————————————————————————————————————————————
test('验收④ 素材处理超时：标记 timeout，队列重试 3 次后置 dead', async t => {
  const db = h.setup();
  const asset = handlers.registerAsset(db, { name: '窗口实拍素材.mp4', timeoutMs: 300 });
  queue.enqueue(db, 'process_asset', { assetId: asset.id, forceTimeout: true }, { maxAttempts: 3 });

  // 第1次处理：超时失败 -> 回到 queued，attempts=1
  let done = await handlers.processOne(db, 'test');
  assert.equal(done.status, 'queued');
  assert.equal(done.attempts, 1);
  assert.ok(done.error.code === 'ASSET_TIMEOUT');
  assert.equal(handlers.getAsset(db, asset.id).status, 'timeout');

  // 退避时间到之前不会被领取
  const leasedNow = queue.lease(db, 'test2');
  assert.equal(leasedNow, null);
  // 手动把 available_at 提前（模拟等待退避结束）
  db.prepare("UPDATE jobs SET available_at=? WHERE id=?").run(new Date().toISOString(), done.id);

  await handlers.processOne(db, 'test');
  db.prepare("UPDATE jobs SET available_at=? WHERE id=?").run(new Date().toISOString(), done.id);
  const final = await handlers.processOne(db, 'test');
  assert.equal(final.status, 'dead');
  assert.equal(final.attempts, 3);
  assert.equal(final.error.reason, 'max_attempts_exceeded');
});

test('素材正常处理：ready + job succeeded', async () => {
  const db = h.setup();
  const asset = handlers.registerAsset(db, { name: 'ok.mp4', timeoutMs: 3000 });
  queue.enqueue(db, 'process_asset', { assetId: asset.id, forceTimeout: false });
  const done = await handlers.processOne(db, 'test');
  assert.equal(done.status, 'succeeded');
  assert.equal(done.result.status, 'ready');
});

// ——————————————————————————————————————————————
// 验收5：发布时权限撤回 —— 意图之后停用发布人，发布瞬间拒绝
// ——————————————————————————————————————————————
test('验收⑤ 发布时权限撤回：取得令牌后权限被撤回，发布被拒绝；恢复后可发布', () => {
  const db = h.setup();
  const src0 = h.makeSource(db);
  const script = h.makeFullScript(db, src0.sourceId, 'following');
  h.approveAll(db, script.id);

  const intent = publishSvc.createPublishIntent(db, script.id, { publisher: '发布员王五' });
  assert.ok(intent.permissionToken);

  // 在点"发布"之前，发布权限被撤回（停用）
  const u = db.prepare("SELECT id FROM users WHERE name='发布员王五'").get();
  reviewsSvc.setUserActive(db, u.id, false);
  assert.throws(
    () => publishSvc.publish(db, script.id, { publisher: '发布员王五', permissionToken: intent.permissionToken }),
    /权限已在申请后被撤回/
  );

  // 令牌仍未被消费；恢复权限后同一令牌可以完成发布
  reviewsSvc.setUserActive(db, u.id, true);
  const rel = publishSvc.publish(db, script.id, { publisher: '发布员王五', permissionToken: intent.permissionToken });
  assert.equal(rel.version, 1);

  // 令牌一次性：再次使用被拒绝
  assert.throws(
    () => publishSvc.publish(db, script.id, { publisher: '发布员王五', permissionToken: intent.permissionToken }),
    /已使用/
  );
});
