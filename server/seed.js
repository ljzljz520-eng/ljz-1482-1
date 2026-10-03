// 演示数据：一个县补贴政策 + 两个脚本（跟随版/固定版），便于本地启动后直接体验
'use strict';
const { getDb } = require('./db.js');
const sources = require('./services/sources.js');
const scriptsSvc = require('./services/scripts.js');
const reviewsSvc = require('./services/reviews.js');

const POLICY = `第一条 为支持粮食生产，本县种植面积50亩以上的种粮农户可申请种粮补贴。

第二条 申请时应当提交以下材料：（一）身份证复印件；（二）土地承包合同；（三）银行卡号。

第三条 办理地点为县政务服务中心3号窗口，办理时间为工作日上午9点至12点。

第四条 申请截止日期为2025年6月1日，逾期不予受理。

第五条 补贴标准为每亩100元，由乡镇政府初审后报县农业农村局复核。`;

function run(db) {
  db = db || getDb();
  if (db.prepare('SELECT COUNT(*) c FROM sources').get().c > 0) {
    console.log('数据库已有数据，跳过 seed。');
    return;
  }
  reviewsSvc.ensureUser(db, '复核员张三', 'reviewer');
  reviewsSvc.ensureUser(db, '复核员李四', 'reviewer');
  reviewsSvc.ensureUser(db, '发布员王五', 'publisher');

  const rev = sources.createSource(db, {
    title: '某县种粮补贴申领政策（演示）', issuer: '某县人民政府', docNo: '某政发〔2025〕1号',
    rawText: POLICY, note: '初版录入',
  });
  const sourceId = db.prepare('SELECT id FROM sources WHERE current_revision_id=?').get(rev.id).id;
  const clauses = sources.getRevision(db, rev.id).clauses;
  const c = ref => clauses.find(x => x.ref === ref).id;

  const scenes = [
    ['opening', '开场', '第一条', '种粮农户看过来，补贴开始申报啦', '种粮补贴开始申报', '稻田航拍+主标题'],
    ['conditions', '申领条件', '第一条', '种植面积50亩以上即可申请', '条件：种植50亩以上', '条件文字卡'],
    ['materials', '申报材料', '第二条', '请带好身份证、承包合同和银行卡号', '材料：身份证/承包合同/银行卡号', '材料清单三件套'],
    ['location', '办理地点', '第三条', '到县政务服务中心3号窗口办理', '地点：政务中心3号窗', '窗口实景'],
    ['conditions', '截止日期提醒', '第四条', '申请6月1日截止，逾期不候', '截止：2025年6月1日', '日历动画卡'],
    ['closing', '结尾', null, '抓紧申报，别错过时间', '请及时申报', '片尾定版'],
  ];

  for (const mode of ['following', 'pinned']) {
    const s = scriptsSvc.createScript(db, { sourceId, title: `补贴政策60秒（${mode === 'pinned' ? '固定版' : '跟随版'}）`, mode });
    for (const [kind, title, ref, n, sub, shot] of scenes) {
      scriptsSvc.addScene(db, s.id, {
        kind, title, linkedClauseId: ref ? c(ref) : null, narration: n, subtitle: sub, shotCard: shot,
      });
    }
    const full = scriptsSvc.getScript(db, s.id);
    for (const sc of full.scenes.filter(x => !x.deleted && x.state.required)) {
      reviewsSvc.submitReview(db, sc.id, { reviewer: '复核员张三', decision: 'approved' });
      if (mode === 'following') reviewsSvc.submitReview(db, sc.id, { reviewer: '复核员李四', decision: 'approved' });
    }
  }
  console.log('seed 完成：1 个来源（5 条款）+ 2 个脚本（跟随版已双审通过，固定版差一票待复核）');
}

if (require.main === module) run();
module.exports = { run };
