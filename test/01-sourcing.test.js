'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseClauses, diffClauses } = require('../shared/clauses.js');
const { createDb } = require('../server/db.js');
const sources = require('../server/services/sources.js');
const scriptsSvc = require('../server/services/scripts.js');
const reviewsSvc = require('../server/services/reviews.js');
const h = require('./helpers.js');

test('录入即溯源：开场/条件/材料/地点无条款引用不能建场，结尾可以', () => {
  const db = h.setup();
  const src = h.makeSource(db);
  const script = scriptsSvc.createScript(db, { sourceId: src.sourceId, title: 't' });
  for (const kind of ['opening', 'conditions', 'materials', 'location']) {
    assert.throws(() => scriptsSvc.addScene(db, script.id, { kind, title: kind }),
      /必须引用具体条款/);
  }
  const created = scriptsSvc.addScene(db, script.id, { kind: 'closing', title: '结尾', narration: '再见' });
  assert.equal(created.scenes.filter(x => !x.deleted).length, 1);
});

test('条款解析与指纹：同文本指纹相同（忽略空白差异）', () => {
  const a = parseClauses(h.POLICY_V1);
  const b = parseClauses(h.POLICY_V1.replace(/。/g, '。 '));
  assert.equal(a.length, 5);
  assert.deepEqual(a.map(c => c.fingerprint), b.map(c => c.fingerprint));
  assert.deepEqual(a.map(c => c.ref), ['第一条', '第二条', '第三条', '第四条', '第五条']);
});

test('日期提取正确', () => {
  const r = parseClauses(h.POLICY_V1);
  assert.deepEqual(r[3].dates, ['2025-06-01']);
});

test('差异定位：段落重排 = reorderedOnly，不失效任何指纹', () => {
  const d = diffClauses(parseClauses(h.POLICY_V1), parseClauses(h.POLICY_V2_REORDER));
  assert.equal(d.summary.reordered, 2);
  assert.equal(d.summary.changed + d.summary.dateChanged + d.summary.added + d.summary.removed, 0);
  assert.equal(d.reorderedOnly, true);
  assert.equal(d.invalidatedFingerprints.length, 0);
});

test('差异定位：日期订正被识别，且旧指纹进入失效集合', () => {
  const d = diffClauses(parseClauses(h.POLICY_V1), parseClauses(h.POLICY_V2_DATEFIX));
  assert.equal(d.summary.dateChanged, 1);
  assert.equal(d.invalidatedFingerprints.length, 1);
  const changed = d.changes.find(c => c.type === 'date_changed');
  assert.deepEqual(changed.oldDates, ['2025-06-01']);
  assert.deepEqual(changed.newDates, ['2025-07-15']);
});
