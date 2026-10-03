// 测试夹具：内存 SQLite + 固定县补贴政策两版文本
'use strict';
const { createDb } = require('../server/db.js');
const sources = require('../server/services/sources.js');
const scriptsSvc = require('../server/services/scripts.js');
const reviewsSvc = require('../server/services/reviews.js');

const POLICY_V1 = `第一条 为支持粮食生产，本县种植面积50亩以上的种粮农户可申请种粮补贴。

第二条 申请时应当提交以下材料：（一）身份证复印件；（二）土地承包合同；（三）银行卡号。

第三条 办理地点为县政务服务中心3号窗口，办理时间为工作日上午9点至12点。

第四条 申请截止日期为2025年6月1日，逾期不予受理。

第五条 补贴标准为每亩100元，由乡镇政府初审后报县农业农村局复核。`;

// 段落重排版：仅调换第三、四条顺序，文本内容逐字不变
const POLICY_V2_REORDER = `第一条 为支持粮食生产，本县种植面积50亩以上的种粮农户可申请种粮补贴。

第二条 申请时应当提交以下材料：（一）身份证复印件；（二）土地承包合同；（三）银行卡号。

第四条 申请截止日期为2025年6月1日，逾期不予受理。

第三条 办理地点为县政务服务中心3号窗口，办理时间为工作日上午9点至12点。

第五条 补贴标准为每亩100元，由乡镇政府初审后报县农业农村局复核。`;

// 日期订正版：第四条日期 6月1日 -> 7月15日
const POLICY_V2_DATEFIX = POLICY_V1.replace('2025年6月1日', '2025年7月15日');

// 改写地点版：第三条地址变化（系统不得自行补造，需人工重新引用+复核）
const POLICY_V2_LOCATION = POLICY_V1.replace('县政务服务中心3号窗口', '县政务服务中心2号窗口');

function setup() {
  const db = createDb();
  reviewsSvc.ensureUser(db, '复核员张三', 'reviewer');
  reviewsSvc.ensureUser(db, '复核员李四', 'reviewer');
  reviewsSvc.ensureUser(db, '发布员王五', 'publisher');
  return db;
}

// 返回 { sourceId, revisionId, version, diff }
function makeSource(db, rawText = POLICY_V1) {
  const rev = sources.createSource(db, { title: '某县种粮补贴政策', issuer: '某县人民政府', docNo: '某政发〔2025〕1号', rawText });
  const row = db.prepare('SELECT id FROM sources WHERE current_revision_id=?').get(rev.id);
  return { sourceId: row.id, revisionId: rev.id, version: rev.version, diff: rev.diff };
}

// 建一个含完整必要场次且绑定条款的脚本（默认跟随）
function makeFullScript(db, sourceId, mode = 'following') {
  const src = sources.getSource(db, sourceId);
  const rev = sources.getRevision(db, src.current_revision_id);
  const script = scriptsSvc.createScript(db, { sourceId, title: '补贴政策60秒短视频', mode });
  const clauseByRef = ref => rev.clauses.find(c => c.ref === ref).id;
  scriptsSvc.addScene(db, script.id, { kind: 'opening', title: '开场', linkedClauseId: clauseByRef('第一条'),
    narration: '种粮农户看过来，补贴开始申报啦', subtitle: '种粮补贴开始申报', shotCard: '稻田航拍+主标题' });
  scriptsSvc.addScene(db, script.id, { kind: 'conditions', title: '申领条件', linkedClauseId: clauseByRef('第一条'),
    narration: '种植面积50亩以上即可申请', subtitle: '条件：种植50亩以上', shotCard: '条件文字卡' });
  scriptsSvc.addScene(db, script.id, { kind: 'materials', title: '申报材料', linkedClauseId: clauseByRef('第二条'),
    narration: '请带好身份证、承包合同和银行卡号', subtitle: '材料：身份证/承包合同/银行卡号', shotCard: '材料清单三件套' });
  scriptsSvc.addScene(db, script.id, { kind: 'location', title: '办理地点', linkedClauseId: clauseByRef('第三条'),
    narration: '到县政务服务中心3号窗口办理', subtitle: '地点：政务中心3号窗', shotCard: '窗口实景' });
  scriptsSvc.addScene(db, script.id, { kind: 'conditions', title: '截止日期提醒', linkedClauseId: clauseByRef('第四条'),
    narration: '申请6月1日截止，逾期不候', subtitle: '截止：2025年6月1日', shotCard: '日历动画卡' });
  scriptsSvc.addScene(db, script.id, { kind: 'closing', title: '结尾',
    narration: '抓紧申报，别错过时间', subtitle: '请及时申报', shotCard: '片尾定版' });
  return scriptsSvc.getScript(db, script.id);
}

// 双审通过所有必要场次
function approveAll(db, scriptId) {
  const s = scriptsSvc.getScript(db, scriptId);
  for (const sc of s.scenes.filter(x => !x.deleted && x.state.required)) {
    reviewsSvc.submitReview(db, sc.id, { reviewer: '复核员张三', decision: 'approved' });
    reviewsSvc.submitReview(db, sc.id, { reviewer: '复核员李四', decision: 'approved' });
  }
  return scriptsSvc.getScript(db, scriptId);
}

module.exports = {
  POLICY_V1, POLICY_V2_REORDER, POLICY_V2_DATEFIX, POLICY_V2_LOCATION,
  setup, makeSource, makeFullScript, approveAll,
};
