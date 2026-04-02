# Changelog

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
