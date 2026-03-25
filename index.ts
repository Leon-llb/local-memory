/**
 * OpenClaw LocalMemory 插件 v2
 *
 * 改进版: 健康检查 + 自动重启 + 清理命令 + Re-rank
 *
 * 配置示例:
 * {
 *   "plugins": {
 *     "local-memory": {
 *       "enabled": true,
 *       "config": {
 *         "serviceUrl": "http://127.0.0.1:37888",
 *         "autoStart": true,
 *         "autoInject": true,
 *         "injectTopK": 3,
 *         "injectThreshold": 0.5,
 *         "healthCheckInterval": 60000,
 *         "ttlDays": 90
 *       }
 *     }
 *   }
 * }
 */

import { spawn, ChildProcess } from 'child_process';

// ============================================================================
// 类型定义
// ============================================================================

interface PluginLogger {
  debug?: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

interface PluginServiceContext {
  config: Record<string, unknown>;
  workspaceDir?: string;
  stateDir: string;
  logger: PluginLogger;
}

interface PluginCommandContext {
  senderId?: string;
  channel: string;
  isAuthorizedSender: boolean;
  args?: string;
  commandBody: string;
  config: Record<string, unknown>;
}

type PluginCommandResult = string | { text: string } | { text: string; format?: string };

interface BeforeAgentStartEvent {
  prompt?: string;
}

interface ToolResultPersistEvent {
  toolName?: string;
  params?: Record<string, unknown>;
  message?: {
    content?: Array<{ type: string; text?: string }>;
  };
}

interface AgentEndEvent {
  messages?: Array<{
    role: string;
    content: string | Array<{ type: string; text?: string }>;
  }>;
}

interface EventContext {
  sessionKey?: string;
  workspaceDir?: string;
  agentId?: string;
}

interface OpenClawPluginApi {
  id: string;
  name: string;
  version?: string;
  source: string;
  config: Record<string, unknown>;
  pluginConfig?: Record<string, unknown>;
  logger: PluginLogger;
  registerService: (service: {
    id: string;
    start: (ctx: PluginServiceContext) => void | Promise<void>;
    stop?: (ctx: PluginServiceContext) => void | Promise<void>;
  }) => void;
  registerCommand: (command: {
    name: string;
    description: string;
    acceptsArgs?: boolean;
    requireAuth?: boolean;
    handler: (ctx: PluginCommandContext) => PluginCommandResult | Promise<PluginCommandResult>;
  }) => void;
  on: ((event: "before_agent_start", callback: (event: BeforeAgentStartEvent, ctx: EventContext) => void | Promise<void>) => void) &
      ((event: "tool_result_persist", callback: (event: ToolResultPersistEvent, ctx: EventContext) => void | Promise<void>) => void) &
      ((event: "agent_end", callback: (event: AgentEndEvent, ctx: EventContext) => void | Promise<void>) => void);
  injectContext?: (ctx: EventContext, content: string) => Promise<void>;
}

// ============================================================================
// 配置类型
// ============================================================================

interface LocalMemoryConfig {
  serviceUrl?: string;
  autoStart?: boolean;
  autoInject?: boolean;
  injectTopK?: number;
  injectThreshold?: number;
  scriptPath?: string;
  healthCheckInterval?: number;  // 健康检查间隔 (ms)
  ttlDays?: number;              // Python 端 TTL
}

// ============================================================================
// Python 服务进程管理 (改进版)
// ============================================================================

let memoryServiceProcess: ChildProcess | null = null;
let serviceReady = false;
let healthCheckTimer: ReturnType<typeof setInterval> | null = null;
let consecutiveFailures = 0;
const MAX_FAILURES = 3;

function startLocalMemory(config: LocalMemoryConfig, logger: PluginLogger): Promise<boolean> {
  return new Promise((resolve) => {
    const scriptPath = config.scriptPath || '/Users/leon/openclaw-local-memory/start.sh';
    const cwdPath = scriptPath.replace('/start.sh', '');

    logger.info(`[local-memory] 🧠 正在启动 Python 记忆服务 v2...`);

    memoryServiceProcess = spawn('bash', [scriptPath], {
      cwd: cwdPath,
      detached: false,
      env: { ...process.env, PYTHONUNBUFFERED: '1' }
    });

    memoryServiceProcess.stdout?.on('data', (data) => {
      const output = data.toString().trim();
      if (output.includes('服务启动:')) {
        serviceReady = true;
        consecutiveFailures = 0;
        logger.info(`[local-memory] ✅ Python 服务已就绪`);
        resolve(true);
      }
      logger.info(`[记忆服务]: ${output}`);
    });

    memoryServiceProcess.stderr?.on('data', (data) => {
      const output = data.toString().trim();
      if (output.includes('Warning') || output.includes('Deprecation')) {
        logger.warn(`[记忆服务-警告]: ${output}`);
      } else {
        logger.error(`[记忆服务-错误]: ${output}`);
      }
    });

    memoryServiceProcess.on('error', (err) => {
      logger.error(`[local-memory] ❌ 启动失败: ${err.message}`);
      resolve(false);
    });

    memoryServiceProcess.on('exit', (code, signal) => {
      serviceReady = false;
      memoryServiceProcess = null;

      if (signal) {
        logger.info(`[local-memory] 💤 Python 服务已停止 (信号: ${signal})`);
      } else if (code !== 0) {
        logger.warn(`[local-memory] ⚠️ Python 服务异常退出 (code: ${code})`);
        // 异常退出时考虑自动重启
        if (consecutiveFailures < MAX_FAILURES) {
          logger.info(`[local-memory] 🔄 尝试自动重启 (${consecutiveFailures + 1}/${MAX_FAILURES})...`);
          consecutiveFailures++;
          setTimeout(() => startLocalMemory(config, logger), 3000);
        } else {
          logger.error(`[local-memory] ❌ 连续失败 ${MAX_FAILURES} 次，停止自动重启`);
        }
      }
    });

    // 超时检测
    setTimeout(() => {
      if (!serviceReady) {
        logger.warn(`[local-memory] ⚠️ 服务启动超时`);
        resolve(false);
      }
    }, 30000);
  });
}

function stopLocalMemory(logger: PluginLogger) {
  if (healthCheckTimer) {
    clearInterval(healthCheckTimer);
    healthCheckTimer = null;
  }

  if (memoryServiceProcess) {
    logger.info(`[local-memory] 💤 正在停止 Python 记忆服务...`);
    memoryServiceProcess.kill('SIGTERM');
    memoryServiceProcess = null;
    serviceReady = false;
  }
}

async function checkHealth(serviceUrl: string, logger: PluginLogger): Promise<boolean> {
  try {
    const response = await fetch(`${serviceUrl}/health`, {
      signal: AbortSignal.timeout(5000)
    });
    return response.ok;
  } catch {
    return false;
  }
}

function startHealthCheck(config: LocalMemoryConfig, logger: PluginLogger) {
  const interval = config.healthCheckInterval || 60000; // 默认 1 分钟
  const serviceUrl = config.serviceUrl || "http://127.0.0.1:37888";

  healthCheckTimer = setInterval(async () => {
    const healthy = await checkHealth(serviceUrl, logger);

    if (!healthy && serviceReady) {
      logger.warn(`[local-memory] ⚠️ 健康检查失败，服务可能已崩溃`);
      serviceReady = false;

      // 尝试重启
      if (consecutiveFailures < MAX_FAILURES) {
        logger.info(`[local-memory] 🔄 尝试自动重启...`);
        consecutiveFailures++;
        await startLocalMemory(config, logger);
      }
    } else if (healthy) {
      consecutiveFailures = 0;
    }
  }, interval);

  logger.info(`[local-memory] 健康检查已启动 (间隔: ${interval / 1000}s)`);
}

// ============================================================================
// HTTP 客户端
// ============================================================================

async function memoryGet(
  baseUrl: string,
  path: string,
  logger: PluginLogger
): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) {
      logger.warn(`[local-memory] GET ${path} returned ${response.status}`);
      return null;
    }
    return (await response.json()) as Record<string, unknown>;
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.warn(`[local-memory] GET ${path} failed: ${msg}`);
    return null;
  }
}

async function memoryPost(
  baseUrl: string,
  path: string,
  body: Record<string, unknown>,
  logger: PluginLogger
): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120000) // 入库可能较慢
    });
    if (!response.ok) {
      logger.warn(`[local-memory] POST ${path} returned ${response.status}`);
      return null;
    }
    return (await response.json()) as Record<string, unknown>;
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.warn(`[local-memory] POST ${path} failed: ${msg}`);
    return null;
  }
}

async function memoryDelete(
  baseUrl: string,
  path: string,
  logger: PluginLogger
): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method: "DELETE",
      signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) {
      logger.warn(`[local-memory] DELETE ${path} returned ${response.status}`);
      return null;
    }
    return (await response.json()) as Record<string, unknown>;
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.warn(`[local-memory] DELETE ${path} failed: ${msg}`);
    return null;
  }
}

// ============================================================================
// 插件入口
// ============================================================================

export default function localMemoryPlugin(api: OpenClawPluginApi): void {
  const config = (api.pluginConfig || {}) as LocalMemoryConfig;
  const serviceUrl = config.serviceUrl || "http://127.0.0.1:37888";
  const autoStart = config.autoStart !== false;
  const autoInject = config.autoInject !== false;
  const injectTopK = config.injectTopK || 3;
  const injectThreshold = config.injectThreshold || 0.5;

  // ========================================================================
  // Service: 管理 Python 服务生命周期 + 健康检查
  // ========================================================================
  api.registerService({
    id: "local-memory-service",
    start: async (_ctx) => {
      if (autoStart) {
        const success = await startLocalMemory(config, api.logger);
        if (success) {
          startHealthCheck(config, api.logger);
        }
      } else {
        api.logger.info(`[local-memory] 自动启动已禁用`);
      }
    },
    stop: async (_ctx) => {
      stopLocalMemory(api.logger);
    }
  });

  // ========================================================================
  // ContextEngine: 自动注入相关记忆 (支持 re-rank)
  // ========================================================================
  api.on("before_agent_start", async (event, ctx) => {
    if (!autoInject || !event.prompt) return;

    const result = await memoryGet(
      serviceUrl,
      `/recall?query=${encodeURIComponent(event.prompt)}&top_k=${injectTopK}&rerank=true`,
      api.logger
    );

    if (!result || !result.success || !Array.isArray(result.results)) {
      return;
    }

    const memories = result.results as Array<{
      content: string;
      metadata?: Record<string, unknown>;
      score: number;
      rerank_score?: number;
    }>;

    // 使用 rerank_score 或原始 score
    const filtered = memories.filter(m => (m.rerank_score || m.score) >= injectThreshold);
    if (filtered.length === 0) return;

    const memoryBlock = filtered
      .map((m, i) => {
        const source = m.metadata?.source || "未知来源";
        const score = (m.rerank_score || m.score).toFixed(2);
        return `[${i + 1}] (${source}, 相关度: ${score})\n${m.content}`;
      })
      .join("\n\n");

    const injectionContent = `
<local-memory>
以下是与你当前任务相关的历史记忆，供参考：

${memoryBlock}
</local-memory>
`.trim();

    if (api.injectContext) {
      await api.injectContext(ctx, injectionContent);
      api.logger.info(`[local-memory] 已注入 ${filtered.length} 条相关记忆 (re-ranked)`);
    } else {
      api.logger.warn("[local-memory] injectContext 不可用");
    }
  });

  // ========================================================================
  // Command: /mem-ingest <url> - 入库网页
  // ========================================================================
  api.registerCommand({
    name: "mem-ingest",
    description: "将网页内容入库到本地记忆系统",
    acceptsArgs: true,
    handler: async (cmdCtx) => {
      const raw = cmdCtx.args?.trim();
      if (!raw) {
        return "用法: /mem-ingest <URL> [--force]\n示例: /mem-ingest https://example.com --force";
      }

      const force = raw.includes("--force");
      const url = raw.replace("--force", "").trim();

      try {
        new URL(url);
      } catch {
        return `无效的 URL: ${url}`;
      }

      const result = await memoryPost(
        serviceUrl,
        "/ingest/url",
        { url, source_name: url, force },
        api.logger
      );

      if (!result) {
        return "❌ 记忆服务不可用";
      }

      if (result.skipped) {
        return `⏭️ 已跳过 (原因: ${result.reason})\n使用 --force 强制重新入库`;
      }

      if (!result.success) {
        return `❌ 入库失败: ${result.error || "未知错误"}`;
      }

      return `✅ 入库成功!\n来源: ${result.source}\n存储块数: ${result.chunks_stored}`;
    },
  });

  // ========================================================================
  // Command: /mem-ingest-text <name> - 入库文本
  // ========================================================================
  api.registerCommand({
    name: "mem-ingest-text",
    description: "将文本内容直接入库",
    acceptsArgs: true,
    handler: async (cmdCtx) => {
      const input = cmdCtx.args?.trim();
      if (!input) {
        return "用法: /mem-ingest-text <名称>|<文本内容> [--force]";
      }

      const force = input.includes("--force");
      const cleanInput = input.replace("--force", "").trim();
      const separatorIndex = cleanInput.indexOf("|");

      if (separatorIndex === -1) {
        return "格式错误。用法: /mem-ingest-text <名称>|<文本内容>";
      }

      const name = cleanInput.slice(0, separatorIndex).trim();
      const text = cleanInput.slice(separatorIndex + 1).trim();

      if (!text) {
        return "文本内容不能为空";
      }

      const result = await memoryPost(
        serviceUrl,
        "/ingest/text",
        { text, source_name: name, force },
        api.logger
      );

      if (!result) {
        return `❌ 服务不可用`;
      }

      if (result.skipped) {
        return `⏭️ 已跳过 (原因: ${result.reason})`;
      }

      if (!result.success) {
        return `❌ 入库失败: ${result.error}`;
      }

      return `✅ 入库成功!\n名称: ${name}\n存储块数: ${result.chunks_stored}`;
    },
  });

  // ========================================================================
  // Command: /mem-recall <query> - 检索记忆
  // ========================================================================
  api.registerCommand({
    name: "mem-recall",
    description: "从本地记忆系统检索相关内容",
    acceptsArgs: true,
    handler: async (cmdCtx) => {
      const raw = cmdCtx.args?.trim();
      if (!raw) {
        return "用法: /mem-recall <查询内容> [--no-rerank]";
      }

      const useRerank = !raw.includes("--no-rerank");
      const query = raw.replace("--no-rerank", "").trim();

      const result = await memoryGet(
        serviceUrl,
        `/recall?query=${encodeURIComponent(query)}&top_k=5&rerank=${useRerank}`,
        api.logger
      );

      if (!result || !result.success) {
        return `❌ 检索失败: ${result?.error || "服务不可用"}`;
      }

      const memories = result.results as Array<{
        content: string;
        metadata?: Record<string, unknown>;
        score: number;
        rerank_score?: number;
      }>;

      if (memories.length === 0) {
        return "没有找到相关记忆";
      }

      const lines = [`🔍 检索结果 (${memories.length} 条, ${useRerank ? "已重排序" : "原始排序"}):\n`];
      memories.forEach((m, i) => {
        const source = m.metadata?.source || "未知";
        const score = (m.rerank_score || m.score).toFixed(2);
        const preview = m.content.length > 150 ? m.content.slice(0, 150) + "..." : m.content;
        lines.push(`[${i + 1}] (相关度: ${score}) 来源: ${source}`);
        lines.push(`    ${preview}\n`);
      });

      return lines.join("\n");
    },
  });

  // ========================================================================
  // Command: /mem-cleanup - 清理记忆
  // ========================================================================
  api.registerCommand({
    name: "mem-cleanup",
    description: "清理过期或指定的记忆",
    acceptsArgs: true,
    handler: async (cmdCtx) => {
      const raw = cmdCtx.args?.trim();

      if (!raw) {
        return [
          "用法:",
          "  /mem-cleanup source=<名称>    - 删除指定来源的记忆",
          "  /mem-cleanup before=<日期>    - 删除指定日期前的记忆",
          "",
          "示例:",
          "  /mem-cleanup source=旧文档",
          "  /mem-cleanup before=2024-01-01",
          "  /mem-cleanup source=旧文档 before=2024-06-01"
        ].join("\n");
      }

      const params = new URLSearchParams();
      const parts = raw.split(/\s+/);

      for (const part of parts) {
        const [key, value] = part.split("=");
        if (key && value) {
          params.set(key, value);
        }
      }

      const path = `/cleanup?${params.toString()}`;
      const result = await memoryDelete(serviceUrl, path, api.logger);

      if (!result) {
        return "❌ 清理失败: 服务不可用";
      }

      if (!result.success) {
        return `❌ 清理失败: ${result.error}`;
      }

      return `✅ 清理完成\n删除记录数: ${result.deleted_count}`;
    },
  });

  // ========================================================================
  // Command: /mem-stats - 查看统计
  // ========================================================================
  api.registerCommand({
    name: "mem-stats",
    description: "查看本地记忆系统统计信息",
    handler: async () => {
      const health = await checkHealth(serviceUrl, api.logger);
      if (!health) {
        return `❌ 记忆服务不可用`;
      }

      const stats = await memoryGet(serviceUrl, "/stats", api.logger);
      if (!stats) {
        return "❌ 获取统计信息失败";
      }

      const sources = stats.sources as Record<string, number> || {};
      const sourceList = Object.entries(sources)
        .slice(0, 5)
        .map(([name, count]) => `  - ${name}: ${count} 条`)
        .join("\n");

      return [
        "📊 本地记忆系统状态 v2",
        `服务地址: ${serviceUrl}`,
        `进程状态: ${serviceReady ? "运行中" : "未启动/外部启动"}`,
        `总记忆块数: ${stats.total_chunks || 0}`,
        `唯一来源数: ${stats.unique_sources || 0}`,
        `TTL (天): ${stats.ttl_days || "永不过期"}`,
        "",
        "来源分布 (Top 5):",
        sourceList || "  (无数据)",
        "",
        `自动注入: ${autoInject ? "开启" : "关闭"}`,
        `注入阈值: ${injectThreshold}`,
      ].join("\n");
    },
  });

  // ========================================================================
  // Command: /mem-restart - 重启 Python 服务
  // ========================================================================
  api.registerCommand({
    name: "mem-restart",
    description: "重启 Python 记忆服务",
    handler: async () => {
      stopLocalMemory(api.logger);
      await new Promise(r => setTimeout(r, 2000));
      consecutiveFailures = 0; // 重置失败计数
      const success = await startLocalMemory(config, api.logger);
      if (success) {
        startHealthCheck(config, api.logger);
        return "✅ 记忆服务已重启";
      }
      return "❌ 重启失败";
    },
  });

  // ========================================================================
  // Command: /mem-health - 手动健康检查
  // ========================================================================
  api.registerCommand({
    name: "mem-health",
    description: "手动检查记忆服务健康状态",
    handler: async () => {
      const healthy = await checkHealth(serviceUrl, api.logger);

      if (healthy) {
        return `✅ 记忆服务健康\n状态: ${serviceReady ? "运行中" : "外部启动"}\n地址: ${serviceUrl}`;
      } else {
        return `❌ 记忆服务不可用\n地址: ${serviceUrl}\n\n使用 /mem-restart 尝试重启`;
      }
    },
  });

  api.logger.info(`[local-memory] 插件 v2 已加载 (服务: ${serviceUrl})`);
}
