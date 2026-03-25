# OpenClaw Local Memory

> 让你的 AI Agent 拥有持久记忆，记住每一次对话中学到的知识

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Python 3.10+](https://img.shields.io/badge/python-3.10+-blue.svg)](https://www.python.org/downloads/)
[![TypeScript](https://img.shields.io/badge/typescript-5.0+-blue.svg)](https://www.typescriptlang.org/)

---

## 目录

- [为什么需要这个项目](#为什么需要这个项目)
- [它能解决什么问题](#它能解决什么问题)
- [工作原理](#工作原理)
- [核心规则](#核心规则)
- [功能特性](#功能特性)
- [快速开始](#快速开始)
- [使用指南](#使用指南)
- [API 文档](#api-文档)
- [配置说明](#配置说明)
- [故障排除](#故障排除)
- [技术架构](#技术架构)
- [贡献指南](#贡献指南)

---

## 为什么需要这个项目

在使用 OpenClaw（或任何 AI Agent 框架）时，我发现一个核心痛点：

> **每次对话都像"失忆"了一样**

Agent 无法记住：
- 昨天学过的项目规范
- 上周讨论的技术决策
- 刚才查过的文档内容

市面上的解决方案要么：
- **依赖云端服务** → 数据隐私担忧，网络延迟
- **配置复杂** → 需要搭建向量数据库、配置 embedding 服务
- **不够智能** → 简单的关键词匹配，无法理解语义

于是我想做一个：
- **完全本地运行** - 数据不出本机，无需联网
- **开箱即用** - 一个命令启动，零配置
- **真正智能** - 语义检索 + 智能重排序，精准召回

---

## 它能解决什么问题

| 问题 | 传统方案 | Local Memory 方案 |
|------|----------|-------------------|
| Agent 每次对话都"失忆" | 手动复制粘贴上下文 | 自动检索相关记忆注入 |
| 知识分散在各个对话中 | 无法复用 | 统一存储，随时调用 |
| 重复学习相同内容 | 每次都要重新解释 | 去重机制，只存一份 |
| 知识过时 | 旧信息持续干扰 | TTL 自动过期 |
| 检索结果不准确 | 关键词匹配 | 向量语义 + Re-rank |
| 服务崩溃 | 手动重启 | 自动健康检查 + 恢复 |

---

## 工作原理

### 整体架构

```
用户输入
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│                    OpenClaw Gateway                          │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐  │
│  │              before_agent_start 钩子                  │  │
│  │                                                       │  │
│  │   用户问题 ──────▶ 检索相关记忆 ──────▶ 注入上下文    │  │
│  │                        │                              │  │
│  └────────────────────────┼──────────────────────────────┘  │
│                           │                                  │
│                           ▼                                  │
│  ┌──────────────────────────────────────────────────────┐  │
│  │                    Agent 执行                         │  │
│  │                                                       │  │
│  │   系统提示词 + 历史记忆 + 用户问题 ──▶ LLM           │  │
│  │                                                       │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                              │
└──────────────────────────────────────────────────────────────┘
                            │
                            │ HTTP API
                            ▼
┌───────────────────────────────────────────────────────────────┐
│              LocalMemoryService (Python)                      │
│                        :37888                                 │
│                                                               │
│  ┌─────────────┐  ┌─────────────┐  ┌──────────────────────┐ │
│  │ crawl4ai    │  │ BGE 模型    │  │ ChromaDB             │ │
│  │ 网页抓取    │  │ 向量化      │  │ 向量存储             │ │
│  └─────────────┘  └─────────────┘  └──────────────────────┘ │
│                                                               │
│  ┌─────────────┐  ┌─────────────┐  ┌──────────────────────┐ │
│  │ 语义切块    │  │ 去重管理    │  │ 重排序器             │ │
│  │ Chunker     │  │ DedupMgr    │  │ ReRanker             │ │
│  └─────────────┘  └─────────────┘  └──────────────────────┘ │
└───────────────────────────────────────────────────────────────┘
                            │
                            ▼
                    ┌───────────────┐
                    │   agent_memory │
                    │   ChromaDB     │
                    │   持久化存储    │
                    └───────────────┘
```

### 数据流程

#### 1. 入库流程 (Ingest)

```
URL / 文本
    │
    ▼
┌─────────────────┐
│ 1. 抓取内容     │  ← crawl4ai (如果是 URL)
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ 2. 去重检查     │  ← URL hash + 内容 hash
└────────┬────────┘
         │ 不存在
         ▼
┌─────────────────┐
│ 3. 语义切块     │  ← 按段落/句子边界分割
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ 4. 向量化       │  ← BGE-small-zh 模型
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ 5. 存入 ChromaDB │ ← 附带元数据 + TTL
└─────────────────┘
```

#### 2. 检索流程 (Recall)

```
用户查询
    │
    ▼
┌─────────────────┐
│ 1. 向量化查询   │  ← BGE 模型
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ 2. 向量检索     │  ← ChromaDB 余弦相似度
└────────┬────────┘
         │ top_k × 3
         ▼
┌─────────────────┐
│ 3. Re-rank      │  ← 综合评分排序
└────────┬────────┘
         │ top_k
         ▼
┌─────────────────┐
│ 4. 返回结果     │  ← 内容 + 元数据 + 分数
└─────────────────┘
```

#### 3. 自动注入流程 (Auto-Inject)

```
Agent 启动 (before_agent_start)
    │
    ▼
获取用户 prompt
    │
    ▼
调用 /recall API
    │
    ▼
过滤低分结果 (threshold)
    │
    ▼
格式化为 <local-memory> 标签
    │
    ▼
注入到 Agent 上下文
    │
    ▼
Agent 执行 (带着相关记忆)
```

---

## 核心规则

### 1. 语义切块规则 (Semantic Chunking)

**问题**：固定长度切块会把句子、代码截断，导致语义不完整。

**解决方案**：

```
输入文本
    │
    ▼
┌─────────────────────────────┐
│ Step 1: 保护代码块          │
│ 识别 ```...``` 并标记保护    │
└────────────┬────────────────┘
             │
             ▼
┌─────────────────────────────┐
│ Step 2: 按段落分割          │
│ 以 \n\n 为边界切分          │
└────────────┬────────────────┘
             │
             ▼
┌─────────────────────────────┐
│ Step 3: 检查每个段落大小     │
│                             │
│  小于 500 字符 → 保留        │
│  大于 500 字符 → 按句子切分  │
└────────────┬────────────────┘
             │
             ▼
┌─────────────────────────────┐
│ Step 4: 添加重叠             │
│ 每块末尾添加 50 字符重叠      │
│ 提高检索连续性               │
└─────────────────────────────┘
```

**示例**：

```markdown
# 原始文本
OpenClaw 是一个强大的 AI Agent 网关框架。

它支持多种消息渠道：Telegram、Discord、Slack。

## 代码示例

```typescript
api.on("before_agent_start", () => {
  console.log("agent starting");
});
```

# 切块结果
[块1] OpenClaw 是一个强大的 AI Agent 网关框架。
[块2] 它支持多种消息渠道：Telegram、Discord、Slack。
[块3] ## 代码示例\n\n```typescript\napi.on("before_agent_start", () => {\n  console.log("agent starting");\n});\n```
```

### 2. 去重规则 (Deduplication)

**URL 去重**：
```
URL → MD5 hash (16位) → 查询数据库 → 存在则跳过
```

**内容去重**：
```
内容 → 标准化(去空白+小写) → SHA256 hash (16位) → 存在则跳过
```

**强制覆盖**：
```
POST /ingest/url  { "url": "...", "force": true }
                      ↑ 跳过去重检查，直接入库
```

### 3. Re-rank 规则 (Re-ranking)

**为什么需要 Re-rank？**
- 纯向量检索可能遗漏关键词精确匹配
- 旧内容可能比新内容分数更高（时效性问题）

**评分公式**：

```
final_score = vector_score × 0.6      # 向量语义相似度
            + keyword_score × 0.3     # 关键词命中比例
            + recency_score × 0.1     # 时效性

其中:
- vector_score: ChromaDB 返回的余弦相似度 (0-1)
- keyword_score: 查询词在文档中出现的比例 (0-1)
- recency_score: 1 - (天数 / 365)，一年后归零
```

**示例**：

| 记忆 | vector_score | keyword_score | recency_score | final_score |
|------|--------------|---------------|---------------|-------------|
| A (新, 精确匹配) | 0.7 | 0.8 | 1.0 | 0.77 |
| B (旧, 语义相关) | 0.9 | 0.2 | 0.3 | 0.65 |
| C (新, 语义相关) | 0.6 | 0.6 | 1.0 | 0.66 |

结果: A > C > B (Re-rank 后)

### 4. TTL 过期规则 (Time-To-Live)

**默认**: 90 天

**存储**：
```json
{
  "content": "...",
  "metadata": {
    "ingested_at": "2026-03-25T10:00:00",
    "expire_at": "2026-06-23T10:00:00"  // 90天后
  }
}
```

**清理时机**：
- 服务启动时自动清理
- 手动调用 `/cleanup`

**清理条件**：
```
当前时间 > expire_at → 删除
```

### 5. 自动注入规则 (Auto-Inject)

**触发时机**: `before_agent_start` 事件

**流程**：
```
1. 获取用户 prompt
2. 调用 /recall?query=<prompt>&top_k=<injectTopK>&rerank=true
3. 过滤: rerank_score >= injectThreshold
4. 格式化:
   <local-memory>
   以下是与你当前任务相关的历史记忆：

   [1] (来源, 相关度: 0.75)
   记忆内容...

   [2] (来源, 相关度: 0.68)
   记忆内容...
   </local-memory>
5. 注入到 Agent 上下文
```

**配置项**：
- `injectTopK`: 注入条数 (默认 3)
- `injectThreshold`: 相似度阈值 (默认 0.5)

### 6. 健康检查规则 (Health Check)

**检查间隔**: 60 秒

**检查方式**: `GET /health`

**失败处理**：
```
连续失败次数 < 3 → 自动重启
连续失败次数 >= 3 → 停止重启，等待手动干预
```

**自动重启流程**：
```
健康检查失败
    │
    ▼
标记 serviceReady = false
    │
    ▼
kill(SIGTERM) 旧进程
    │
    ▼
等待 2 秒
    │
    ▼
spawn 新进程
    │
    ▼
等待 "服务启动" 输出
    │
    ▼
标记 serviceReady = true
```

### 7. 生命周期绑定规则

**设计原则**: Python 服务依附于 OpenClaw 主进程

**实现**：
```typescript
spawn('bash', [scriptPath], {
  detached: false  // 关键: 子进程不独立
})
```

**效果**：
```
OpenClaw 启动 → Python 服务启动
OpenClaw 正常退出 → Python 服务收到 SIGTERM → 优雅关闭
OpenClaw 崩溃 → Python 服务收到 SIGHUP → 跟随终止
```

---

## 功能特性

| 特性 | 说明 | 状态 |
|------|------|------|
| 🧠 **语义切块** | 按段落/句子边界分割，保护代码块完整性 | ✅ |
| 🔄 **智能去重** | URL hash + 内容 hash 双重检查 | ✅ |
| ⏰ **TTL 过期** | 默认 90 天自动过期 | ✅ |
| 🎯 **Re-rank** | 向量相似度 + 关键词匹配 + 时效性综合排序 | ✅ |
| 💉 **自动注入** | Agent 启动时自动检索相关记忆注入上下文 | ✅ |
| 🔄 **自动重启** | 健康检查 + 异常自动恢复 (最多 3 次) | ✅ |
| 📦 **生命周期绑定** | 随 OpenClaw 启动/关闭 | ✅ |
| 🌐 **网页入库** | 支持抓取网页内容自动入库 | ✅ |
| 📝 **文本入库** | 支持直接入库文本内容 | ✅ |
| 🔍 **语义检索** | 基于向量相似度的语义搜索 | ✅ |

---

## 快速开始

### 前置要求

- Python 3.10+
- Node.js 18+
- OpenClaw (可选，如果作为插件使用)

### 1. 安装依赖

```bash
# Python 依赖
pip install crawl4ai sentence-transformers chromadb

# 克隆项目
git clone https://github.com/YOUR_USERNAME/openclaw-local-memory.git
cd openclaw-local-memory
```

### 2. 启动服务

```bash
./start.sh
# 或指定参数
python3 memory_service.py --port 37888 --ttl-days 90
```

首次启动会自动下载 BGE 模型 (~100MB)。

### 3. 验证服务

```bash
curl http://127.0.0.1:37888/health
# {"status": "ok", "service": "local-memory", "version": "2.0"}
```

### 4. 安装 OpenClaw 插件 (可选)

```bash
# 复制到 OpenClaw 扩展目录
mkdir -p ~/.openclaw/extensions/local-memory
cp index.ts openclaw.plugin.json package.json tsconfig.json ~/.openclaw/extensions/local-memory/

# 编译
cd ~/.openclaw/extensions/local-memory
npm install typescript @types/node
npx tsc

# 配置 OpenClaw
# 编辑 ~/.openclaw/openclaw.json，添加:
# "plugins": {
#   "allow": ["local-memory"],
#   "entries": {
#     "local-memory": {
#       "enabled": true,
#       "config": {
#         "serviceUrl": "http://127.0.0.1:37888",
#         "autoStart": true,
#         "autoInject": true
#       }
#     }
#   }
# }

# 重启 OpenClaw
openclaw restart
```

---

## 使用指南

### 命令列表

| 命令 | 说明 |
|------|------|
| `/mem-ingest <url>` | 入库网页内容 |
| `/mem-ingest <url> --force` | 强制重新入库（跳过去重） |
| `/mem-ingest-text 名称|文本` | 入库文本内容 |
| `/mem-recall <查询>` | 检索相关记忆 |
| `/mem-recall <查询> --no-rerank` | 跳过重排序 |
| `/mem-stats` | 查看统计信息 |
| `/mem-health` | 手动健康检查 |
| `/mem-cleanup source=名称` | 清理指定来源的记忆 |
| `/mem-cleanup before=日期` | 清理指定日期前的记忆 |
| `/mem-restart` | 重启 Python 服务 |

### 使用示例

#### 入库网页

```
/mem-ingest https://docs.python.org/3/library/asyncio.html

# 响应:
✅ 入库成功!
来源: https://docs.python.org/3/library/asyncio.html
存储块数: 15
```

#### 入库文本

```
/mem-ingest-text 项目规范|这个项目使用 TypeScript + Bun 运行时。
代码风格: 函数式，避免 class。
命名: 小驼峰变量，大驼峰组件。

# 响应:
✅ 入库成功!
名称: 项目规范
存储块数: 1
```

#### 检索记忆

```
/mem-recall 如何处理异步任务

# 响应:
🔍 检索结果 (3 条, 已重排序):

[1] (相关度: 0.82) 来源: Python异步文档
    asyncio 是 Python 的异步编程框架...
    使用 async/await 语法...

[2] (相关度: 0.71) 来源: 项目规范
    这个项目使用 TypeScript + Bun 运行时...

[3] (相关度: 0.65) 来源: Node.js文档
    Promise 和 async/await 是处理异步的主要方式...
```

#### 查看统计

```
/mem-stats

# 响应:
📊 本地记忆系统状态 v2
服务地址: http://127.0.0.1:37888
进程状态: 运行中
总记忆块数: 128
唯一来源数: 15
TTL (天): 90

来源分布 (Top 5):
  - Python文档: 25 条
  - 项目规范: 18 条
  - API文档: 15 条
  ...
```

---

## API 文档

### 基础端点

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/health` | 健康检查 |
| GET | `/stats` | 统计信息 |

### 入库端点

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/ingest/url` | 入库网页 |
| POST | `/ingest/text` | 入库文本 |

#### POST /ingest/url

**请求体**:
```json
{
  "url": "https://example.com/doc",
  "source_name": "示例文档",
  "force": false
}
```

**响应**:
```json
{
  "success": true,
  "chunks_stored": 5,
  "source": "示例文档"
}
```

#### POST /ingest/text

**请求体**:
```json
{
  "text": "这是一段需要记忆的文本内容...",
  "source_name": "手动输入",
  "metadata": {
    "category": "项目规范"
  },
  "force": false
}
```

### 检索端点

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/recall` | 检索记忆 |
| POST | `/recall` | 检索记忆 (POST) |

#### GET /recall

**参数**:
- `query` (必需): 查询文本
- `top_k` (可选): 返回条数，默认 5
- `rerank` (可选): 是否重排序，默认 true

**示例**:
```
GET /recall?query=异步任务&top_k=3&rerank=true
```

**响应**:
```json
{
  "success": true,
  "query": "异步任务",
  "results": [
    {
      "content": "asyncio 是 Python 的异步编程框架...",
      "metadata": {
        "source": "Python文档",
        "ingested_at": "2026-03-25T10:00:00"
      },
      "score": 0.75,
      "rerank_score": 0.82
    }
  ]
}
```

### 清理端点

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/cleanup` | 清理记忆 |
| DELETE | `/cleanup` | 清理记忆 (DELETE) |

**参数**:
- `source` (可选): 按来源清理
- `before` (可选): 按日期清理 (ISO 格式)

**示例**:
```
DELETE /cleanup?source=旧文档
DELETE /cleanup?before=2024-01-01
```

---

## 配置说明

### Python 服务配置

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `--port` | 37888 | HTTP 服务端口 |
| `--db-path` | ./agent_memory | ChromaDB 数据目录 |
| `--ttl-days` | 90 | 记忆过期天数 |

### OpenClaw 插件配置

```json
{
  "serviceUrl": "http://127.0.0.1:37888",
  "autoStart": true,
  "autoInject": true,
  "injectTopK": 3,
  "injectThreshold": 0.5,
  "healthCheckInterval": 60000,
  "scriptPath": "/path/to/start.sh"
}
```

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `serviceUrl` | string | `http://127.0.0.1:37888` | Python 服务地址 |
| `autoStart` | boolean | `true` | 是否自动启动 Python 服务 |
| `autoInject` | boolean | `true` | 是否在 agent 启动时自动注入相关记忆 |
| `injectTopK` | number | `3` | 自动注入时检索的条数 |
| `injectThreshold` | number | `0.5` | 相似度阈值，低于此值不注入 |
| `healthCheckInterval` | number | `60000` | 健康检查间隔 (ms) |
| `scriptPath` | string | - | Python 启动脚本路径 |

---

## 故障排除

### 常见问题

| 问题 | 原因 | 解决方案 |
|------|------|----------|
| 服务启动超时 | 模型下载慢 | 等待或设置 HF_TOKEN 加速 |
| 检索结果为空 | 阈值过高 | 降低 injectThreshold |
| 重复入库 | 去重未生效 | 使用 `--force` 强制入库 |
| 服务频繁重启 | 端口冲突 | 更换端口或关闭占用进程 |
| 内存占用高 | ChromaDB 索引 | 正常现象，向量索引需要内存 |

### 日志级别

Python 服务日志：
- `ℹ️` Info - 正常操作
- `✅` Success - 操作成功
- `⚠️` Warning - 警告（可忽略）
- `❌` Error - 错误（需关注）

### 健康检查

```bash
# 手动检查
curl http://127.0.0.1:37888/health

# 预期响应
{"status": "ok", "service": "local-memory", "version": "2.0"}
```

---

## 技术架构

### 技术栈

| 组件 | 技术 | 说明 |
|------|------|------|
| HTTP 服务 | Python + http.server | 轻量级 HTTP 服务 |
| 网页抓取 | crawl4ai | 支持动态渲染的网页抓取 |
| 向量模型 | BAAI/bge-small-zh-v1.5 | 中文向量模型 (~100MB) |
| 向量数据库 | ChromaDB | 本地嵌入式向量数据库 |
| OpenClaw 插件 | TypeScript | OpenClaw 原生插件 |

### 目录结构

```
openclaw-local-memory/
├── memory_service.py      # Python HTTP 服务 (核心)
├── index.ts               # OpenClaw TypeScript 插件
├── openclaw.plugin.json   # OpenClaw 插件配置
├── start.sh               # 启动脚本
├── package.json           # Node.js 配置
├── tsconfig.json          # TypeScript 配置
├── README.md              # 文档
├── LICENSE                # MIT 协议
└── .gitignore             # Git 忽略规则
```

### 数据存储

```
agent_memory/
├── chroma.sqlite3         # ChromaDB 元数据
└── <uuid>/                # 向量索引文件
```

---

## 贡献指南

欢迎 Issue 和 PR！

### 开发流程

1. Fork 本仓库
2. 创建特性分支 (`git checkout -b feature/amazing-feature`)
3. 提交更改 (`git commit -m 'Add amazing feature'`)
4. 推送到分支 (`git push origin feature/amazing-feature`)
5. 创建 Pull Request

### 代码规范

- Python: PEP 8
- TypeScript: ESLint + Prettier
- 提交信息: Conventional Commits

---

## 致谢

- [BGE](https://huggingface.co/BAAI/bge-small-zh-v1.5) - 北京智源研究院的中文向量模型
- [ChromaDB](https://www.trychroma.com/) - 开源向量数据库
- [crawl4ai](https://github.com/unclecode/crawl4ai) - LLM 友好的网页抓取库
- [OpenClaw](https://github.com/openclaw) - AI Agent 网关框架

---

## License

[MIT License](LICENSE) © 2026 Leon

---

<p align="center">
  如果这个项目对你有帮助，请给一个 ⭐️ Star！
</p>
