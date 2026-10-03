// 条款解析 / 指纹 / 差异定位 —— 全栈编排台的核心溯源工具
'use strict';

// 去掉所有空白（段落重排、空格差异不改变指纹）
function normalizeText(t) {
  return String(t || '').replace(/\s+/g, '');
}

function fingerprint(text) {
  // 32 位 FNV-1a，足够标识条款版本
  const s = normalizeText(text);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return 'fp_' + h.toString(16).padStart(8, '0');
}

const DATE_RE = /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/g;

function extractDates(text) {
  const out = [];
  let m;
  DATE_RE.lastIndex = 0;
  while ((m = DATE_RE.exec(String(text || '')))) {
    out.push(`${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`);
  }
  return out;
}

/**
 * 将政策原文切分为条款。
 * 支持“第一条 / 一、 / 1. / （一）/ 第X条”等常见县域公文格式；
 * 无法识别标题时按非空段落切分。
 */
function parseClauses(rawText) {
  const text = String(rawText || '').replace(/\r\n/g, '\n');
  const blocks = text.split(/\n\s*\n/).map(s => s.trim()).filter(Boolean);
  const headRe = /^(第[0-9一二三四五六七八九十百]+条|[0-9０-９]+[.、)）]|[（(][0-9一二三四五六七八九十]+[)）]|[一二三四五六七八九十]+[、.])/;
  const clauses = [];
  let cur = null;
  for (const block of blocks) {
    const oneLine = !block.includes('\n');
    const firstLine = block.split('\n')[0];
    const hm = oneLine ? firstLine.match(headRe) : null;
    if (hm) {
      if (cur) clauses.push(cur);
      const ref = hm[0].trim();
      cur = { ref, title: firstLine.slice(0, Math.min(40, firstLine.length)), text: block };
    } else if (cur) {
      cur.text += '\n\n' + block;
    } else {
      cur = { ref: '段落' + (clauses.length + 1), title: block.slice(0, 30), text: block };
    }
  }
  if (cur) clauses.push(cur);
  clauses.forEach((c, i) => {
    c.order = i + 1;
    c.fingerprint = fingerprint(c.text);
    c.dates = extractDates(c.text);
  });
  return clauses;
}

/**
 * 差异定位：比较旧版条款集与新版条款集。
 * 分类：added / removed / changed / date_changed / reordered / unchanged
 * 日期文本变化额外标记 date_changed（“日期订正”）。
 * 段落重排不改变内容指纹，因此不导致审核失效。
 */
function diffClauses(oldClauses, newClauses) {
  const oldRef = new Map(oldClauses.map(c => [c.ref, c]));
  const newRef = new Map(newClauses.map(c => [c.ref, c]));
  const changes = [];
  const refs = new Set([...oldRef.keys(), ...newRef.keys()]);

  for (const ref of refs) {
    const o = oldRef.get(ref), n = newRef.get(ref);
    if (o && n) {
      if (o.fingerprint !== n.fingerprint) {
        const oldDates = extractDates(o.text), newDates = extractDates(n.text);
        const dateChanged = JSON.stringify([...oldDates].sort()) !== JSON.stringify([...newDates].sort());
        changes.push({
          type: dateChanged ? 'date_changed' : 'changed',
          ref, oldOrder: o.order, newOrder: n.order,
          oldFingerprint: o.fingerprint, newFingerprint: n.fingerprint,
          oldDates, newDates, oldText: o.text, newText: n.text,
        });
      } else if (o.order !== n.order) {
        changes.push({
          type: 'reordered', ref,
          oldOrder: o.order, newOrder: n.order, fingerprint: o.fingerprint,
        });
      } else {
        changes.push({
          type: 'unchanged', ref, oldOrder: o.order, newOrder: n.order, fingerprint: o.fingerprint,
        });
      }
    } else if (o && !n) {
      const moved = [...newClauses].find(c => c.fingerprint === o.fingerprint);
      changes.push({
        type: moved ? 'reordered' : 'removed', ref, oldOrder: o.order,
        newOrder: moved ? moved.order : null,
        fingerprint: o.fingerprint, oldText: o.text,
        newRef: moved ? moved.ref : null,
      });
    } else {
      const movedFrom = [...oldClauses].find(c => c.fingerprint === n.fingerprint);
      changes.push({
        type: movedFrom ? 'reordered' : 'added', ref, newOrder: n.order,
        oldOrder: movedFrom ? movedFrom.order : null,
        fingerprint: n.fingerprint, newText: n.text,
        oldRef: movedFrom ? movedFrom.ref : null,
      });
    }
  }

  const summary = {
    added: changes.filter(c => c.type === 'added').length,
    removed: changes.filter(c => c.type === 'removed').length,
    changed: changes.filter(c => c.type === 'changed').length,
    dateChanged: changes.filter(c => c.type === 'date_changed').length,
    reordered: changes.filter(c => c.type === 'reordered').length,
    unchanged: changes.filter(c => c.type === 'unchanged').length,
  };

  // 受影响指纹（审核失效的依据）：重排不失效（内容指纹一致）
  const invalidatedFingerprints = new Set();
  for (const c of changes) {
    if (c.type === 'removed') invalidatedFingerprints.add(c.fingerprint);
    if ((c.type === 'changed' || c.type === 'date_changed') && c.oldFingerprint) {
      invalidatedFingerprints.add(c.oldFingerprint);
    }
  }

  return {
    changes: changes.sort((a, b) => (a.newOrder ?? a.oldOrder ?? 0) - (b.newOrder ?? b.oldOrder ?? 0)),
    summary,
    invalidatedFingerprints: [...invalidatedFingerprints],
    reorderedOnly: summary.changed === 0 && summary.added === 0 && summary.removed === 0 && summary.reordered > 0,
  };
}

module.exports = {
  normalizeText, fingerprint, parseClauses, diffClauses, extractDates,
};
