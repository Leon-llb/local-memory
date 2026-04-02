# OpenClaw Local Memory v3

为 OpenClaw 设计的本地长期记忆系统。

这次升级不再是“单个向量库 + before_agent_start 注入”的薄层方案，而是改成了参考 Claude Code 本地记忆思路的分层模型：

- 跨会话项目知识保留
- 用户偏好持续积累
- 多层长期记忆
- 成本感知路由
- 自动沉淀与归档
- 三级隐私
- 可视化仪表盘
- 正式插件安装记录

## 核心变化

### 1. 分层记忆

系统现在把记忆拆成 5 层：

- `user_preference`
  用户偏好，例如“回复简洁”“不要自动提交”
- `project_knowledge`
  项目长期知识，例如技术栈、代码规范、命名约定、测试命令
- `summary`
  每次会话结束后的沉淀摘要
- `session_episode`
  当前/近期会话片段，默认私有，适合短期上下文
- `archive`
  旧会话经过压缩后的归档洞察

### 2. 三级隐私

- `private`
  仅当前 session 可见
- `project`
  同一项目跨会话可见
- `global`
  所有项目共享，适合用户级偏好

### 3. 记忆融入策略

不再直接把 recall 结果粗暴塞进上下文，而是走 `/context` 策略注入：

- `lean`
  低成本，优先偏好 + 核心项目知识
- `balanced`
  默认，适合大多数编码会话
- `deep`
  更重，注入更多摘要与历史片段
- `auto`
  根据 query 长度自动选择

### 4. 持续沉淀

插件在 `agent_end` 自动调用 `/reflect`：

- 抽取用户偏好
- 抽取项目知识
- 生成会话摘要
- 保存近期会话片段

另外可通过 `/mem-archive` 对旧摘要做压缩归档。

### 5. 默认归档策略

插件现在支持默认自动归档策略：

- `autoArchive: true`
- `archiveAfterDays: 14`
- `archiveCheckIntervalMinutes: 360`

默认会在 `agent_end` 之后按周期检查，把较旧的 `summary / session_episode` 压缩沉淀到 `archive` 层。

### 6. 可视化仪表盘

服务自带本地页面：

```bash
http://127.0.0.1:37888/dashboard
```

可查看：

- 各层记忆分布
- 隐私分布
- 注入路由使用情况
- 最近更新的记忆
- 项目级记忆分布
- 健康与统计 API 入口
- 常用命令与管理入口

## 架构

```text
OpenClaw plugin
  ├─ before_prompt_build -> POST /context
  ├─ tool_result_persist -> 缓存工具轨迹
  └─ agent_end -> POST /reflect

memory_service.py
  ├─ SQLite 持久化
  ├─ 可选 SentenceTransformer 向量检索
  ├─ 分层 recall / context routing
  ├─ reflect 自动沉淀
  ├─ archive 压缩归档
  └─ dashboard HTML
```

## 安装

### Python

最小运行只需要 Python 标准库。

如果你希望更强的语义检索和网页抓取，可以额外安装：

```bash
pip install sentence-transformers crawl4ai
```

### TypeScript

```bash
npm install
npm run build
```

## 启动服务

```bash
bash ./start.sh
```

自定义端口 / TTL / 数据库路径：

```bash
bash ./start.sh 37888 180 ./agent_memory
```

## OpenClaw 插件配置

```json
{
  "plugins": {
    "allow": ["local-memory"],
    "entries": {
      "local-memory": {
        "enabled": true,
        "config": {
          "serviceUrl": "http://127.0.0.1:37888",
          "autoStart": true,
          "autoInject": true,
          "autoReflect": true,
          "injectTopK": 8,
          "injectThreshold": 0.18,
          "injectStrategy": "auto",
          "defaultVisibility": "project",
          "ttlDays": 180,
          "autoArchive": true,
          "archiveAfterDays": 14,
          "archiveCheckIntervalMinutes": 360
        }
      }
    }
  }
}
```

## 命令

- `/mem-ingest <url> [--layer=project_knowledge] [--visibility=project]`
- `/mem-ingest-text <name>|<text> [--layer=project_knowledge] [--visibility=project]`
- `/mem-pref <text> [--visibility=global|project]`
- `/mem-recall <query>`
- `/mem-stats`
- `/mem-dashboard`
- `/mem-panel`
- `/mem-archive [--days=14]`
- `/mem-cleanup source=<name>`
- `/mem-health`
- `/mem-restart`

## HTTP API

### 基础

- `GET /health`
- `GET /stats`
- `GET /dashboard`

### 写入

- `POST /ingest/text`
- `POST /ingest/url`
- `POST /reflect`

### 检索

- `POST /recall`
- `POST /context`

### 维护

- `POST /archive/compact`
- `DELETE /cleanup`

## 本次升级解决的问题

### 跨会话项目知识保留

现在所有项目记忆都有 `project_id`，相同 workspace 会持续复用，不会再把不同项目的记忆混在一起。

### 用户偏好持续积累

`/reflect` 会从用户消息中自动提炼偏好；`/mem-pref` 可以手动补充。

### 多层长期记忆

偏好、项目知识、摘要、会话片段、归档被拆开管理，避免单层向量库越用越乱。

### 记忆融入策略

`/context` 会按层级和预算分配注入，而不是简单按相似度排序。

### 记忆持续沉淀与归档

会话结束自动沉淀；旧摘要可压缩到 `archive` 层。

### 成本感知路由

支持 `lean / balanced / deep / auto` 路由，按注入预算裁剪上下文。

### 三级隐私良好

支持 `private / project / global` 三档。

### 正式安装记录

仓库现在已补齐 OpenClaw 官方安装元数据，可直接通过以下命令生成 `plugins.installs` 记录：

```bash
openclaw plugins install --dangerously-force-unsafe-install /path/to/local-memory
```

`inspect` 中会显示 `Install: Source / Install path / Installed at` 等信息，不再把 `local-memory` 视为无 provenance 的手工插件目录。

### 可视化仪表盘

新增本地 dashboard，便于观察系统是否真的在积累和注入有效记忆。

## 验证

我已经在本地做过这些校验：

- `python3 -m py_compile memory_service.py`
- `npx -p typescript@5.9.3 tsc --noEmit`
- 启动服务后验证 `/health`
- 验证 `/ingest/text`
- 验证 `/reflect`
- 验证 `/context`
- 验证 `/stats`
- 验证 `/archive/compact`

## 兼容性说明

v3 与 v2 最大差异：

- 存储后端从“面向 Chroma 的单层块存储”改成“SQLite + 分层记忆”
- 自动注入改为 `/context` 策略注入
- 新增 `agent_end` 自动沉淀
- 新增 dashboard 和 archive 接口

如果你之前已经有旧数据目录，建议新开一个独立目录测试 v3。
