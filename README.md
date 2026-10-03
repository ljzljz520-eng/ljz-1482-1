# 县域政策短视频全栈编排台

把县域政策材料（通知/办法/办事指南）编排成合规短视频的全栈工作台：
React 网页录入政策材料，Express API + SQLite 保存**来源修订、脚本场次、复核意见**，
异步任务生成**剪辑清单与预览包**。核心约束：

> **开场、条件、材料、办理地点中的每一句陈述都必须能追溯到具体条款；
> 改写不是法律判断，系统不会自行补造条件或地址。**

---

## 本地启动

要求 Node ≥ 18（已在 Node 20 验证）。依赖已安装时：

```bash
# 1) 初始化演示数据（可选，约 10 秒看完所有状态）
node server/seed.js

# 2) 一键启动 API(4000) + React 开发服(5173) + 内置队列 worker
npm run dev
# 打开 http://localhost:5173

# 其它方式
npm run dev:api      # 仅 API（默认内置 worker，DISABLE_BUILTIN_WORKER=1 可关）
npm run dev:worker   # 独立常驻 worker 进程
npm run build && npm start   # 生产模式（API 同时托管 dist/）

# 无服务器静态页（纯静态，跨域调 4000 的 /api）
npm run serverless:page      # http://localhost:8080

npm test             # 19 项 node:test 验收/规则测试
```

演示数据含：1 个政策来源（5 条款）、两个脚本——
**跟随版**（已双人复核通过，可直接发布）与**固定版**（各必要场仅 1 票，处于待复核）。

---

## 功能与验收对照

| 需求 | 实现位置 |
|---|---|
| React 网页录入政策材料 | 标签页① `src/tabs/SourcesTab.jsx`，条款解析 `shared/clauses.js` |
| API 与数据库保存来源修订/脚本场次/复核意见 | `server/index.js` + SQLite 表 `sources/revisions/clauses/scripts/scenes/reviews` |
| 异步任务生成剪辑清单及预览包 | 持久队列表 `jobs`，处理器 `server/services/handlers.js`（`export_bundle` 产出 editlist.json + preview.srt） |
| 开场/条件/材料/地点必须追到具体条款 | `scripts.addScene/updateScene` 强制 `linkedClauseId`；前端四类型新建时必须选条款 |
| 改写不是法律判断，不得补造条件或地址 | 政策更新后系统只做**差异定位与失效标记**；改引新条款、改写文案均由人工完成 |
| 政策更新后按引用关系计算受影响脚本 | `revision_diffs.invalidated_fingerprints` → `computeSceneState` 按指纹逐场计算 |
| 只有相关场次重新复核通过才发布新版本 | `export.validateForExport` 对 stale/incomplete 场次判 error，`publish` 前再次强制校验 |
| 旧成果保留当时依据 | 每次发布把当时修订版**全量条款文本**固化进 `releases.snapshot` 与 output/vN.json |
| 固定源文版本 vs 跟随更新草稿 | `scripts.mode=pinned/following`；跟随版目标版本自动前移，固定版不动，可手工 rebase |
| 差异定位 | `shared/clauses.js diffClauses`：added/removed/changed/**date_changed**/reordered/unchanged |
| 审核失效规则 | 内容指纹失效（改写/日期订正/删除）→ 复核失效；**纯段落重排指纹不变 → 复核延续有效**；场次内容改版 → content_version+1 旧票失效 |
| 时间线删场不能悄悄删除必要提醒 | 必要场删除必须填原因；条款仍有效且无替代场次时拒绝删除；删除留痕（软删 + delete_reason） |
| 导出校验覆盖字幕/旁白/镜头卡 | `validateForExport`：三轨缺失逐项报错并定位场次（`MISSING_SUBTITLE/NARRATION/SHOTCARD`） |
| 段落重排验收 | `test/02` 验收①：重排后 location 仍 approved 且可发布 |
| 日期订正验收 | `test/02` 验收②：仅引用第四条的"截止日期提醒"失效，双审后发布 v2，v1 快照仍是 6月1日 |
| 两人同时审核验收 | `test/02` 验收③：唯一约束 + upsert，同一人多次只计 1 票，满 2 名不同复核人才通过 |
| 素材处理超时验收 | `test/02` 验收④：标记 timeout，指数退避重试 3 次后 job=dead |
| 发布时权限撤回验收 | `test/02` 验收⑤：一次性发布令牌创建后停用发布人 → 发布瞬间 403；恢复后同令牌可用 |
| 网页显示缺证据/待复核原因 | 场次卡状态徽章（缺证据/待复核/依据已更新）+ 脚本页顶部聚合"缺证据/待复核原因"清单 |
| 持久队列接入无服务器页面 | `POST /api/serverless/tick`；静态页 `serverless/public/index.html`；函数示例 `serverless/function-example.js` |

### 网页四个标签页

1. **政策来源与修订**：录入原文 → 预览条款切分（第一条/一、/1.）→ 提交新版本看差异（日期订正红色、重排蓝色）。
2. **脚本与复核**：选跟随/固定机制 → 时间线四必要场必须绑定条款 → 逐场双审 → 导出校验 → 申请发布令牌 → 发布。
3. **异步任务/素材**：查看队列状态、登记素材（一键"模拟超时"）、用户与角色管理（一键停用=撤回权限）。
4. **无服务器页面**：在浏览器里手动/自动 tick 驱动持久队列；另有独立静态页 :8080。

---

## 领域模型要点

- **条款指纹**：条款文本去空白后的 FNV-1a。同一内容跨版本指纹相同；段落重排仅顺序变化。
- **场次证据** `scenes.linked_clause_id + linked_fingerprint`：
  - 条款 id 在目标版存在且指纹一致 → 证据有效；
  - id 不存在但指纹存在 → 段落重排，证据与复核延续（页面注明"位置调整，内容未变"）；
  - 指纹消失 → `stale_reference`，必须人工改引并重新双审。
- **复核**：`UNIQUE(scene_id,target_revision_id,content_version,reviewer)`，
  状态在读取时按"目标版本 + 内容版本 + 指纹"实时计算，历史意见永不删除。
- **发布**：`publish-intent` 颁发 10 分钟一次性令牌；`publish` 时**重新**核验发布人角色与在职状态、
  目标版本是否变化、导出校验是否仍通过；任何一条不符即拒绝。
- **队列**：`queued → leased → succeeded/dead`；心跳 `heartbeat_at` + 租约超时回收，
  失败指数退避（1s/2s/4s…，上限 30s），超过 max_attempts 判 dead。无服务器 tick 每次驱动一个任务。

## 目录

```
shared/clauses.js            条款解析/指纹/差异（前后端可共用的纯函数）
server/db.js                 SQLite schema
server/services/sources.js   来源/修订/差异/受影响计算
server/services/scripts.js   脚本/场次/状态计算/删场保护/rebase
server/services/reviews.js   双人复核（并发安全）
server/services/export.js    三轨导出校验 + 剪辑清单 + SRT 预览包
server/services/publish.js   发布意图令牌 + 发布时权限复核 + 不可变快照
server/services/queue.js     持久队列（租约/心跳/退避/回收）
server/services/handlers.js  export_bundle / process_asset（含超时）
server/worker.js             独立 worker
serverless/public/           可托管到任意静态空间的驱动页
test/                        19 项验收与规则测试
```
