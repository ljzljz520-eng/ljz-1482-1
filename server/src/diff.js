'use strict';
/**
 * 条款差异定位：按稳定条款号比对两个修订，
 * 区分 新增/删除/文本修订/日期订正/段落重排。
 * 段落重排只定位、不视为内容变化（不触发复核失效）。
 */

const DATE_RE = /(\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日|\d{4}\s*年\s*\d{1,2}\s*月|\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}\s*月\s*\d{1,2}\s*日)/g;

const CHANGE_LABEL = {
  added: '新增条款',
  removed: '删除条款',
  text_change: '文本修订',
  date_change: '日期订正',
  reorder: '段落重排',
};
// 影响复核效力的内容型变化（reorder 不在其中）
const CONTENT_CHANGE_TYPES = ['added', 'removed', 'text_change', 'date_change'];

function stripDates(t) { return String(t).replace(DATE_RE, '<日期>'); }

/**
 * oldClauses/newClauses: [{clause_key, para_index, text}]
 * 返回变化列表（差异定位到 clause_key 与段落号）。
 */
function diffClauses(oldClauses, newClauses) {
  const changes = [];
  const oldMap = new Map(oldClauses.map(c => [c.clause_key, c]));
  const newMap = new Map(newClauses.map(c => [c.clause_key, c]));
  for (const [key, o] of oldMap) {
    if (!newMap.has(key)) {
      changes.push({ clause_key: key, change_type: 'removed', old_text: o.text, new_text: null, old_index: o.para_index, new_index: null });
    }
  }
  for (const [key, n] of newMap) {
    const o = oldMap.get(key);
    if (!o) {
      changes.push({ clause_key: key, change_type: 'added', old_text: null, new_text: n.text, old_index: null, new_index: n.para_index });
      continue;
    }
    if (o.text !== n.text) {
      const type = stripDates(o.text) === stripDates(n.text) ? 'date_change' : 'text_change';
      changes.push({ clause_key: key, change_type: type, old_text: o.text, new_text: n.text, old_index: o.para_index, new_index: n.para_index });
    } else if (o.para_index !== n.para_index) {
      changes.push({ clause_key: key, change_type: 'reorder', old_text: o.text, new_text: n.text, old_index: o.para_index, new_index: n.para_index });
    }
  }
  return changes;
}

const KIND_LABEL = { condition: '条件', material: '材料', location: '地点', reminder: '提醒', opening: '开场', other: '其他' };

/** 解析粘贴的来源文本：每行一条；支持「[材料] 第三条 ……」前缀；自动识别条款号与类别。 */
function parseClauseInput(text) {
  const lines = String(text).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  return lines.map((line, i) => {
    let kind = null;
    const m = line.match(/^\[([^\]]{1,6})\]\s*/);
    let body = line;
    if (m) {
      const label = m[1];
      kind = Object.keys(KIND_LABEL).find(k => KIND_LABEL[k] === label) || 'other';
      body = line.slice(m[0].length);
    }
    // 条款号仅在行首时作为稳定条款号，并从正文剥离（避免与库中纯内容条款比对时误判文本修订）
    const km = body.match(/^第\s*([0-9一二三四五六七八九十百]+)\s*条\s*[:：]?\s*/);
    const clause_key = km ? `第${km[1]}条` : `P${i + 1}`;
    if (km) body = body.slice(km[0].length);
    if (!kind) kind = detectKind(body);
    return { clause_key, para_index: i + 1, kind, text: body };
  });
}

function detectKind(text) {
  if (/条件|资格|对象|范围/.test(text)) return 'condition';
  if (/材料|证明|证件|复印件|原件/.test(text)) return 'material';
  if (/地点|地址|窗口|大厅|服务中心/.test(text)) return 'location';
  if (/截止|期限|提醒|逾期/.test(text)) return 'reminder';
  return 'other';
}

module.exports = { diffClauses, parseClauseInput, detectKind, stripDates, CHANGE_LABEL, CONTENT_CHANGE_TYPES, KIND_LABEL };
