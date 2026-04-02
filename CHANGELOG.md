# Changelog

## 3.2.0 - 2026-04-03

本次版本把原先只停留在协议层的 workflow gate，补成了真正可运行、可回归、可去重的自动化层。

### Added

- `/delegate`、`/advisor`、`/verify` 三个显式 slash command
- 黑板产物生成：`task-spec.md`、`advisor-check.md`、`qa-gate.md`
- workflow gate 风险判定与 route 建议
- session 级 gate 去重，避免重复注入同一类 workflow 提示
- Node 回归覆盖 workflow 判定、去重和命令产物

### Changed

- `before_prompt_build` 从轻量 workflow hints 升级为保守自动化 workflow gates
- gate 注入同时补入 system policy，要求只写 delta evidence，不重放整段聊天
- `agent_end` 清理工具轨迹缓存，避免关闭自动沉淀时残留 session 垃圾
- 健康巡检增加并发闸门，避免重启风暴，并且重启后继续巡检
- 自动归档改成后台周期任务，支持跨项目扫描和压缩归档
- Python 服务改为线程化 HTTP server，慢请求不再阻塞 `/health`

### Verified

- `npm run test`
- 6 个 Node 测试全部通过
- 2 个 Python 测试全部通过

## 3.0.0 - 2026-04-02

本次版本将项目从单层向量记忆插件升级为分层长期记忆系统，重点参考了 Claude Code 的本地记忆设计思路。

### Added

- 跨会话 `project_id` 项目知识保留
- `user_preference / project_knowledge / summary / session_episode / archive` 五层记忆结构
- `private / project / global` 三级隐私
- `/context` 成本感知注入路由：`lean / balanced / deep / auto`
- `agent_end -> /reflect` 自动沉淀
- `/archive/compact` 归档压缩
- `/dashboard` 可视化仪表盘
- `/mem-panel` 完整管理入口
- `/mem-pref`、`/mem-dashboard`、`/mem-archive` 等新命令

### Changed

- 持久化后端改为 SQLite 分层存储
- 注入 Hook 从旧兼容路径切换为 `before_prompt_build`
- 启动脚本支持 `PORT TTL_DAYS DB_PATH`
- OpenClaw 配置项扩展为 `autoReflect`、`injectStrategy`、`defaultVisibility`、`dbPath`
- 插件包补齐 `openclaw.extensions`，支持正式 install record

### Improved

- 自动从会话中提炼用户偏好和项目知识
- 按查询长度和注入预算裁剪上下文
- 去重与层间过滤，减少重复记忆注入
- 本地部署联调通过，可直接运行在 OpenClaw
- 默认自动归档策略：14 天阈值 / 360 分钟检查周期
