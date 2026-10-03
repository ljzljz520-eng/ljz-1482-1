// 发布：意图令牌（发布前取权限）+ 真正发布时再次校验权限（支持发布时权限撤回）
// 且只有相关场次重新复核通过后才能发布新版本；旧版本快照不可变。
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { log, httpErr } = require('./sources.js');
const { getScript } = require('./scripts.js');
const { validateForExport, buildPackage, buildReleaseSnapshot } = require('./export.js');

const uuid = () => crypto.randomUUID();
const now = () => new Date().toISOString();

function getUserByName(db, name) {
  return db.prepare('SELECT * FROM users WHERE name=?').get(String(name || ''));
}

// 发布前：校验可发布性 + 颁发一次性意图令牌（绑定发布人与目标版本）
function createPublishIntent(db, scriptId, { publisher }) {
  const script = getScript(db, scriptId);
  const user = getUserByName(db, publisher);
  if (!user) throw httpErr(403, `发布人「${publisher}」不存在`);
  if (!user.active) throw httpErr(403, `发布人「${publisher}」已被停用`);
  if (!['publisher', 'admin'].includes(user.role)) {
    throw httpErr(403, `「${publisher}」角色为 ${user.role}，无发布权限`);
  }
  const validation = validateForExport(db, scriptId);
  if (!validation.ok) {
    throw Object.assign(httpErr(409, '当前脚本未通过发布校验'), { details: validation.errors });
  }
  const token = crypto.randomBytes(24).toString('hex');
  const id = uuid(), ts = now();
  db.prepare(`INSERT INTO publish_intents (id,script_id,target_revision_id,permission_token,created_at,expires_at,consumed)
              VALUES (?,?,?,?,?,?,0)`)
    .run(id, scriptId, script.targetRevision.id, token, ts,
      new Date(Date.now() + 10 * 60 * 1000).toISOString());
  log(db, user.name, 'publish.intent', 'script:' + scriptId,
    { target: script.targetRevision.id, intentId: id });
  return {
    intentId: id, permissionToken: token,
    targetRevisionId: script.targetRevision.id,
    expiresInSec: 600,
    validation,
  };
}

/**
 * 真正发布：此处重新检查权限（而不是信任意图时的状态）。
 * 验收点"发布时权限撤回"：意图创建后发布人被停用/降级 -> 拒绝发布。
 */
function publish(db, scriptId, { publisher, permissionToken }) {
  const script = getScript(db, scriptId);
  const intent = db.prepare(`SELECT * FROM publish_intents
    WHERE script_id=? ORDER BY created_at DESC LIMIT 1`).get(scriptId);
  if (!intent) throw httpErr(400, '未找到发布意图，请先申请发布');
  if (intent.consumed) throw httpErr(409, '发布意图已使用，请重新申请');
  if (!permissionToken || permissionToken !== intent.permission_token) {
    throw httpErr(403, '发布令牌无效');
  }
  if (new Date(intent.expires_at).getTime() < Date.now()) throw httpErr(410, '发布意图已过期，请重新申请');

  // —— 发布时权限复核（关键）——
  const user = getUserByName(db, publisher);
  if (!user) throw httpErr(403, `发布人「${publisher}」不存在，发布被拒绝`);
  if (!user.active) throw httpErr(403, `发布权限已在申请后被撤回（发布人「${publisher}」已停用），发布被拒绝`);
  if (!['publisher', 'admin'].includes(user.role)) {
    throw httpErr(403, `发布权限已在申请后被撤回（角色变更为 ${user.role}），发布被拒绝`);
  }
  if (intent.target_revision_id !== script.targetRevision.id) {
    throw httpErr(409, '申请后脚本目标版本发生变化，请重新走复核与发布流程');
  }

  // 相关场次必须重新复核通过（validateForExport 强制）
  const validation = validateForExport(db, scriptId);
  if (!validation.ok) throw Object.assign(httpErr(409, '存在未通过复核或溯源问题的场次，不能发布新版本'), { details: validation.errors });

  const bundle = buildPackage(db, scriptId);
  const snapshot = buildReleaseSnapshot(db, scriptId, bundle);
  const version = (db.prepare('SELECT COALESCE(MAX(version),0) v FROM releases WHERE script_id=?').get(scriptId).v) + 1;
  const releaseId = uuid(), ts = now();

  const outDir = path.join(__dirname, '..', '..', 'output', scriptId);
  fs.mkdirSync(outDir, { recursive: true });
  const bundlePath = path.join(outDir, `v${version}.json`);
  const srtPath = path.join(outDir, `v${version}.srt`);
  fs.writeFileSync(bundlePath, JSON.stringify({ ...snapshot, editList: bundle.editList, preview: bundle.preview }, null, 2));
  fs.writeFileSync(srtPath, snapshot.preview.srt);

  const tx = db.transaction(() => {
    db.prepare(`INSERT INTO releases (id,script_id,version,revision_id,snapshot,export_bundle_path,published_by,created_at)
                VALUES (?,?,?,?,?,?,?,?)`)
      .run(releaseId, scriptId, version, script.targetRevision.id,
        JSON.stringify(snapshot), bundlePath, user.name, ts);
    db.prepare('UPDATE publish_intents SET consumed=1 WHERE id=?').run(intent.id);
    db.prepare('UPDATE scripts SET published_version=?, status=?, updated_at=? WHERE id=?')
      .run(validation.ok ? version : 0, 'published', ts, scriptId);
  });
  tx();
  log(db, user.name, 'publish.release', 'script:' + scriptId, { version, releaseId });
  return {
    releaseId, version, bundlePath, srtPath,
    basisRevision: snapshot.basisRevision.id,
    snapshotRetained: true,
  };
}

function getRelease(db, scriptId, version) {
  const row = db.prepare('SELECT * FROM releases WHERE script_id=? AND version=?').get(scriptId, version);
  if (!row) throw httpErr(404, '该版本不存在');
  return { ...row, snapshot: JSON.parse(row.snapshot) };
}

module.exports = { createPublishIntent, publish, getRelease, httpErr };
