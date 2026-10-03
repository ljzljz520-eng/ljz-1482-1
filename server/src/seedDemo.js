'use strict';
/** 演示数据：一份政策（5 条款）+ 一个 5 场脚本，全部陈述带条款引用。 */
const { now } = require('./db');

function seedDemo(db) {
  if (db.prepare('SELECT COUNT(*) c FROM policies').get().c > 0) return;
  const t = now();
  const pid = db.prepare('INSERT INTO policies(title, created_at) VALUES (?,?)')
    .run('城乡居民基本医疗保险参保登记办事指南', t).lastInsertRowid;
  const revId = db.prepare('INSERT INTO policy_revisions(policy_id, version_no, note, created_by, created_at) VALUES (?,?,?,?,?)')
    .run(pid, 1, '首次收录', 'u_admin', t).lastInsertRowid;
  const clauses = [
    ['第一条', 'other', '本指南适用于本县城乡居民基本医疗保险参保登记事项。'],
    ['第二条', 'condition', '具有本县户籍，或持有本县有效居住证的居民，可申请办理参保登记。'],
    ['第三条', 'material', '办理时需提供本人有效身份证原件及复印件一份。'],
    ['第四条', 'location', '办理地点：县政务服务中心二楼医保综合窗口。'],
    ['第五条', 'reminder', '集中参保缴费期为2025年9月1日至2025年12月31日，逾期将影响待遇享受。'],
  ];
  const ins = db.prepare('INSERT INTO clauses(revision_id, clause_key, para_index, kind, text) VALUES (?,?,?,?,?)');
  clauses.forEach(([k, kind, text], i) => ins.run(revId, k, i + 1, kind, text));

  const sid = db.prepare('INSERT INTO scripts(policy_id, title, created_at) VALUES (?,?,?)')
    .run(pid, '《医保参保登记60秒》', t).lastInsertRowid;
  db.prepare('INSERT INTO script_versions(script_id, version_no, status, created_at) VALUES (?,?,?,?)').run(sid, 1, 'draft', t);
  const scenes = [
    ['opening', '开场引入', '在咱们县，城乡居民医保参保登记这样办。', 'opening', '第一条', '字幕：医保参保登记怎么办？', '旁白：在咱们县，城乡居民医保参保登记这样办。', '镜头1：政务大厅外景推镜'],
    ['conditions', '办理条件', '本县户籍或持有本县有效居住证即可申请办理。', 'condition', '第二条', '字幕：本县户籍或持居住证可办', '旁白：本县户籍，或持有本县有效居住证，即可申请办理。', '镜头2：主持人出镜口播'],
    ['materials', '所需材料', '带上本人有效身份证原件及复印件一份。', 'material', '第三条', '字幕：身份证原件+复印件一份', '旁白：办理时请带上本人有效身份证原件和复印件一份。', '镜头3：材料特写'],
    ['location', '办理地点', '到县政务服务中心二楼医保综合窗口办理。', 'location', '第四条', '字幕：县政务服务中心二楼医保窗口', '旁白：办理地点在县政务服务中心二楼医保综合窗口。', '镜头4：窗口实拍'],
    ['reminder', '参保期提醒', '集中参保缴费期截至2025年12月31日，逾期影响待遇。', 'reminder', '第五条', '字幕：集中参保期截至2025年12月31日', '旁白：集中参保缴费期截至二零二五年十二月三十一日，逾期将影响待遇享受。', '镜头5：日历动画'],
  ];
  const insScene = db.prepare(`INSERT INTO scenes(script_id, scene_no, scene_type, title, pin_mode, subtitle, voiceover, shot_card, updated_at)
    VALUES (?,?,?,?, 'follow', ?,?,?,?)`);
  const insStmt = db.prepare('INSERT INTO scene_statements(scene_id, stmt_type, paraphrase, updated_at) VALUES (?,?,?,?)');
  const insCit = db.prepare('INSERT INTO statement_citations(statement_id, clause_key) VALUES (?,?)');
  scenes.forEach(([type, title, para, stype, key, sub, vo, shot], i) => {
    const sceneId = insScene.run(sid, i + 1, type, title, sub, vo, shot, t).lastInsertRowid;
    const stmtId = insStmt.run(sceneId, stype, para, t).lastInsertRowid;
    insCit.run(stmtId, key);
  });
}

module.exports = { seedDemo };
