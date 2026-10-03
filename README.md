# 县域政策短视频全栈编排台

React 网页录入政策材料，Express + SQLite 后台保存**来源修订、脚本场次、复核意见**，
异步任务（持久队列）生成**剪辑清单**与**预览包**。核心原则：

- **可追溯**：开场 / 条件 / 材料 / 办理地点 四类陈述必须引用具体条款；改写不是法律判断；
- **不补造**：系统不得自行补造条件或地址，缺引用只标记「缺证据」并阻断复核通过与导出；
- **可重算**：政策更新后按引用关系计算受影响脚本，只有相关场次重新复核通过才可发布新版本，旧成果保留当时依据。

## 本地启动

```bash
npm start          # API + 静态前端 + 本地 worker：http://localhost:8377
npm run dev:web    # 可选：Vite 开发服务器（:5173，代理 /api → :8377）
npm test           # 验收场景测试（37 项断言，内存库独立运行）
```

首次启动自动写入演示数据（医保参保登记政策 R1 + 5 场脚本）。数据落在 `data/`（SQLite + 预览包）。

演示身份（网页右上角切换，请求头 `x-user-id`）：
`u_admin` 管理员 ｜ `u_editor` 编辑（policy.write/script.write/task.run）｜
`u_reviewer_a/b` 复核员（review）｜ `u_publisher` 发布员（publish/task.run）

## 关键机制

### 1. 固定源文版本 vs 跟随更新草稿
每个场次可选 `pin_mode`：
- **follow（跟随更新）**：生效依据 = 政策最新修订；引用条款内容变化时，生效复核**失效**并记录原因；
- **fixed（固定源文版本）**：钉在指定修订；政策更新不失效，仅标记「源文已有新版本」，旧成果保留当时依据。

### 2. 差异定位与审核失效规则
新修订按稳定条款号（第X条）比对，区分五类：
`added 新增` / `removed 删除` / `text_change 文本修订` / `date_change 日期订正`（仅日期变化）/ `reorder 段落重排`。
- 内容型变化（前四类）→ 按 `statement_citations` 引用关系计算受影响脚本与场次，follow 场次的生效复核失效（原因写入 `invalidation_reason`，网页「待复核原因」可见）；
- **段落重排只定位、不失效**（内容未变）；
- 改写文本在复核后被修改 → 该场复核同样失效。

### 3. 删场守卫
删除「材料 / 办理地点 / 必要办理提醒」类的**最后承载场次**时返回 409 及原因，
必须显式确认并填写原因（写入审计日志）——时间线删场不能悄悄删除必要办理提醒。

### 4. 导出校验与发布门禁
- 导出校验覆盖**字幕、旁白、镜头卡**三类制作字段 + 四类陈述的证据链；
- 发布门禁：导出校验通过 **且** 所有含四类陈述/提醒的场次均有生效复核；
- 发布时**执行时重新校验权限**（权限被撤回 → 403）；
- 发布即冻结快照（含条款原文与依据修订号），旧版本成果永久保留当时依据。

### 5. 持久队列与无服务器接入
任务表即队列（`generate_edit_list` / `generate_preview` / `process_material`），
本地 worker 轮询执行；任务带 `timeout_ms`，素材处理超时 → `timeout`，可重试（看门狗兜底卡死任务）。
无服务器页面可经 HTTP 接入同一持久队列：

```bash
curl -X POST :8377/api/queue/claim    -H 'x-worker-token: dev-worker-token'   # 认领
curl -X POST :8377/api/queue/:id/complete -H 'x-worker-token: ...' -d '{"result":{...}}'
curl -X POST :8377/api/queue/:id/fail     -H 'x-worker-token: ...' -d '{"error":"..."}'
```

令牌由环境变量 `WORKER_TOKEN` 配置（默认 `dev-worker-token`）。

## 验收场景对照（server/test/acceptance.js）

| 场景 | 验证点 |
|---|---|
| 来源段落重排 | 差异全部定位 `reorder`，0 条复核失效 |
| 日期订正 | 识别 `date_change`，follow 场复核失效并给出原因，fixed 场保留旧依据 |
| 两人同时审核 | 并发提交一人 201 一人 409；依据版本过期提交 409 `basis_changed` |
| 素材处理超时 | 任务 `timeout` → 调整超时重试 → `done` |
| 发布时权限撤回 | 撤回 publish 权限后发布 → 403（执行时校验） |
| 删场守卫 | 唯一定位场删除 409 → 确认+原因后删除并留审计 |
| 导出校验 | 缺字幕/旁白/镜头卡/缺证据逐场报错；预览包任务在校验失败时失败 |
| 缺证据 | 网页数据可见，复核通过被 422 拦截（系统不补造） |
| 旧成果保留依据 | v1 快照在政策更新后仍含当时条款原文 |
| 无服务器接入 | 错误令牌 401；claim/complete 走通持久队列 |

## API 摘要

```
POST /api/policies                        新建政策
POST /api/policies/:id/revisions          录入修订（自动差异定位+影响计算）
GET  /api/policies/:id/diff?from=&to=     任意两版差异定位
POST /api/scripts                         新建脚本（自动建 v1 草稿）
POST /api/scripts/:id/scenes              新增场次
POST /api/scenes/:id/statements           新增陈述（附条款引用）
PUT  /api/statements/:id                  修改陈述（触发复核失效）
DELETE /api/scenes/:id                    删场（守卫：ack+reason）
POST /api/scenes/:id/review               复核（expected_basis 乐观并发）
GET  /api/review-queue                    待复核队列（缺证据/待复核原因）
POST /api/scripts/:id/versions            新建草稿版本
GET  /api/script-versions/:id/validate    导出校验
POST /api/script-versions/:id/publish     发布（门禁+权限执行时校验+快照）
GET  /api/script-versions/:id/snapshot    发布快照（冻结依据）
POST /api/tasks                           异步任务入队
POST /api/tasks/:id/retry                 超时/失败重试
POST /api/queue/claim|complete|fail       无服务器 worker 接入
GET  /api/artifacts                       剪辑清单/预览包产物
GET  /api/audit                           审计日志
```

## 目录结构

```
server/src/
  db.js        SQLite schema（含 reviews 部分唯一索引：同场同依据仅一条生效通过）
  diff.js      条款解析与差异定位（日期订正/段落重排识别）
  impact.js    影响计算与审核失效规则（follow 失效 / fixed 保留）
  validate.js  证据链、导出校验、删场守卫、发布门禁
  editlist.js  剪辑清单 / 发布快照 / 预览包渲染（只用引用条款，不补造）
  queue.js     持久队列、本地 worker、超时看门狗
  routes.js    REST API（权限执行时校验）
web/src/pages/ 概览 / 政策来源 / 脚本编辑器 / 复核中心 / 异步任务 / 发布与导出
```
