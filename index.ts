/**
 * OpenClaw Local Memory 插件 v3
 *
 * 设计目标：
 * 1. 跨会话项目知识保留
 * 2. 用户偏好持续积累
 * 3. 分层长期记忆 + agent_end 自动沉淀
 * 4. 成本感知注入策略
 * 5. 三级隐私（private / project / global）
 * 6. 可视化仪表盘
 */

import { spawn, ChildProcess } from 'child_process';
import path from 'path';

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

interface BeforePromptBuildEvent {
  prompt?: string;
  messages?: unknown[];
}

interface BeforePromptBuildResult {
  prependContext?: string;
  systemPrompt?: string;
  prependSystemContext?: string;
  appendSystemContext?: string;
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
  on: ((event: 'before_prompt_build', callback: (event: BeforePromptBuildEvent, ctx: EventContext) =>
    | void
    | BeforePromptBuildResult
    | Promise<void | BeforePromptBuildResult>) => void) &
      ((event: 'before_agent_start', callback: (event: BeforeAgentStartEvent, ctx: EventContext) => void | Promise<void>) => void) &
      ((event: 'tool_result_persist', callback: (event: ToolResultPersistEvent, ctx: EventContext) => void | Promise<void>) => void) &
      ((event: 'agent_end', callback: (event: AgentEndEvent, ctx: EventContext) => void | Promise<void>) => void);
  injectContext?: (ctx: EventContext, content: string) => Promise<void>;
}

type InjectStrategy = 'auto' | 'lean' | 'balanced' | 'deep';
type Visibility = 'private' | 'project' | 'global';
type MemoryLayer =
  | 'user_preference'
  | 'project_knowledge'
  | 'summary'
  | 'session_episode'
  | 'archive';

interface LocalMemoryConfig {
  serviceUrl?: string;
  autoStart?: boolean;
  autoInject?: boolean;
  autoReflect?: boolean;
  autoArchive?: boolean;
  injectTopK?: number;
  injectThreshold?: number;
  injectStrategy?: InjectStrategy;
  scriptPath?: string;
  dbPath?: string;
  healthCheckInterval?: number;
  ttlDays?: number;
  archiveAfterDays?: number;
  archiveCheckIntervalMinutes?: number;
  defaultVisibility?: Visibility;
}

interface RuntimeConfig {
  serviceUrl: string;
  autoStart: boolean;
  autoInject: boolean;
  autoReflect: boolean;
  autoArchive: boolean;
  injectTopK: number;
  injectThreshold: number;
  injectStrategy: InjectStrategy;
  scriptPath: string;
  dbPath: string;
  healthCheckInterval: number;
  ttlDays: number;
  archiveAfterDays: number;
  archiveCheckIntervalMinutes: number;
  defaultVisibility: Visibility;
}

let memoryServiceProcess: ChildProcess | null = null;
let serviceReady = false;
let healthCheckTimer: ReturnType<typeof setInterval> | null = null;
let consecutiveFailures = 0;
let activeRuntimeConfig: RuntimeConfig | null = null;
let lastKnownWorkspaceDir: string | undefined;
let lastAutoArchiveAt = 0;
const MAX_FAILURES = 3;
const sessionToolEvents = new Map<string, string[]>();

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function normalizeVisibility(value: unknown, fallback: Visibility): Visibility {
  return value === 'private' || value === 'project' || value === 'global' ? value : fallback;
}

function normalizeLayer(value: unknown, fallback: MemoryLayer): MemoryLayer {
  const allowed = new Set<MemoryLayer>([
    'user_preference',
    'project_knowledge',
    'summary',
    'session_episode',
    'archive',
  ]);
  return typeof value === 'string' && allowed.has(value as MemoryLayer)
    ? (value as MemoryLayer)
    : fallback;
}

function normalizeInjectStrategy(value: unknown, fallback: InjectStrategy): InjectStrategy {
  return value === 'auto' || value === 'lean' || value === 'balanced' || value === 'deep'
    ? value
    : fallback;
}

function flattenMessageContent(
  content: string | Array<{ type: string; text?: string }> | undefined,
): string {
  if (!content) {
    return '';
  }
  if (typeof content === 'string') {
    return content;
  }
  return content
    .filter((item) => item.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text?.trim() ?? '')
    .filter(Boolean)
    .join('\n');
}

function getSessionIdentifier(ctx: EventContext): string {
  return ctx.sessionKey || ctx.agentId || 'default-session';
}

function extractOptions(raw: string): { body: string; flags: Record<string, string | boolean> } {
  const flags: Record<string, string | boolean> = {};
  const body = raw.replace(/--([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\s]+)))?/g, (_, key: string, a: string, b: string, c: string) => {
    flags[key] = a ?? b ?? c ?? true;
    return '';
  }).trim();
  return { body, flags };
}

function getPortFromUrl(serviceUrl: string): string {
  try {
    const parsed = new URL(serviceUrl);
    return parsed.port || '37888';
  } catch {
    return '37888';
  }
}

function resolveWorkspaceFromCommand(cmdCtx: PluginCommandContext): string | undefined {
  const maybeConfig = cmdCtx.config as Record<string, unknown>;
  const candidate = maybeConfig.workspaceDir || maybeConfig.cwd || lastKnownWorkspaceDir;
  return typeof candidate === 'string' ? candidate : undefined;
}

function renderInjectedContext(
  route: InjectStrategy,
  memories: Array<{
    title?: string;
    layer: string;
    visibility: string;
    score?: number;
    summary?: string;
    content: string;
  }>,
): string {
  const labels: Record<string, string> = {
    user_preference: '用户偏好',
    project_knowledge: '项目长期知识',
    summary: '沉淀摘要',
    session_episode: '近期会话片段',
    archive: '归档洞察',
  };

  const groups = new Map<string, string[]>();
  for (const memory of memories) {
    const layer = memory.layer || 'project_knowledge';
    const title = memory.title ? `${memory.title}: ` : '';
    const payload = memory.summary || memory.content;
    const line = `- ${title}${payload}`.trim();
    const items = groups.get(layer) || [];
    items.push(line);
    groups.set(layer, items);
  }

  const sections = [`<local-memory route="${route}">`];
  for (const layer of ['user_preference', 'project_knowledge', 'summary', 'session_episode', 'archive']) {
    const items = groups.get(layer);
    if (!items || items.length === 0) {
      continue;
    }
    sections.push(`### ${labels[layer] || layer}`);
    sections.push(...items);
    sections.push('');
  }
  sections.push('</local-memory>');
  return sections.join('\n').trim();
}

function resolveRuntimeConfig(
  config: LocalMemoryConfig,
  ctx: PluginServiceContext | null,
): RuntimeConfig {
  const scriptPath = config.scriptPath || path.resolve(__dirname, 'start.sh');
  const serviceUrl = config.serviceUrl || 'http://127.0.0.1:37888';
  return {
    serviceUrl,
    autoStart: asBoolean(config.autoStart, true),
    autoInject: asBoolean(config.autoInject, true),
    autoReflect: asBoolean(config.autoReflect, true),
    autoArchive: asBoolean(config.autoArchive, true),
    injectTopK: asNumber(config.injectTopK, 8),
    injectThreshold: asNumber(config.injectThreshold, 0.18),
    injectStrategy: normalizeInjectStrategy(config.injectStrategy, 'auto'),
    scriptPath,
    dbPath: config.dbPath || (ctx ? path.join(ctx.stateDir, 'agent-memory') : path.resolve(__dirname, 'agent_memory')),
    healthCheckInterval: asNumber(config.healthCheckInterval, 60000),
    ttlDays: asNumber(config.ttlDays, 180),
    archiveAfterDays: asNumber(config.archiveAfterDays, 14),
    archiveCheckIntervalMinutes: asNumber(config.archiveCheckIntervalMinutes, 360),
    defaultVisibility: normalizeVisibility(config.defaultVisibility, 'project'),
  };
}

async function maybeRunAutoArchive(
  runtime: RuntimeConfig,
  workspaceDir: string | undefined,
  logger: PluginLogger,
): Promise<void> {
  if (!runtime.autoArchive) {
    return;
  }
  const cooldownMs = Math.max(runtime.archiveCheckIntervalMinutes, 5) * 60_000;
  const now = Date.now();
  if (lastAutoArchiveAt > 0 && now - lastAutoArchiveAt < cooldownMs) {
    return;
  }
  lastAutoArchiveAt = now;
  try {
    const result = await memoryRequest(runtime.serviceUrl, 'POST', '/archive/compact', logger, {
      days: runtime.archiveAfterDays,
      workspace_dir: workspaceDir,
    });
    if (result?.success && (Number(result.archived_count || 0) > 0 || result.created_archive)) {
      logger.info(
        `[local-memory] 自动归档完成 archived=${String(result.archived_count || 0)} created_archive=${String(Boolean(result.created_archive))}`,
      );
    }
  } catch (error) {
    logger.warn(`[local-memory] 自动归档失败: ${String(error)}`);
  }
}

async function startLocalMemory(config: RuntimeConfig, logger: PluginLogger): Promise<boolean> {
  if (memoryServiceProcess && serviceReady) {
    return true;
  }

  const scriptPath = config.scriptPath;
  const cwdPath = path.dirname(scriptPath);
  const port = getPortFromUrl(config.serviceUrl);

  return new Promise((resolve) => {
    let settled = false;
    const settle = (value: boolean) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    logger.info(`[local-memory] 启动记忆服务: ${scriptPath}`);
    memoryServiceProcess = spawn('bash', [scriptPath, port, String(config.ttlDays), config.dbPath], {
      cwd: cwdPath,
      detached: false,
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    });

    memoryServiceProcess.stdout?.on('data', (data) => {
      const output = data.toString().trim();
      if (!output) return;
      if (output.includes('服务启动:')) {
        serviceReady = true;
        consecutiveFailures = 0;
        logger.info('[local-memory] 服务已就绪');
        settle(true);
      }
      logger.info(`[记忆服务] ${output}`);
    });

    memoryServiceProcess.stderr?.on('data', (data) => {
      const output = data.toString().trim();
      if (!output) return;
      logger.warn(`[记忆服务] ${output}`);
    });

    memoryServiceProcess.on('error', (err) => {
      serviceReady = false;
      logger.error(`[local-memory] 启动失败: ${err.message}`);
      settle(false);
    });

    memoryServiceProcess.on('exit', (code, signal) => {
      serviceReady = false;
      memoryServiceProcess = null;
      if (signal) {
        logger.info(`[local-memory] 服务停止，信号: ${signal}`);
        return;
      }
      if (code !== 0) {
        logger.warn(`[local-memory] 服务异常退出: ${code}`);
      }
    });

    setTimeout(() => {
      if (!serviceReady) {
        logger.warn('[local-memory] 服务启动超时');
        settle(false);
      }
    }, 40000);
  });
}

function stopLocalMemory(logger: PluginLogger): void {
  if (healthCheckTimer) {
    clearInterval(healthCheckTimer);
    healthCheckTimer = null;
  }
  if (memoryServiceProcess) {
    logger.info('[local-memory] 停止记忆服务');
    memoryServiceProcess.kill('SIGTERM');
    memoryServiceProcess = null;
  }
  serviceReady = false;
}

async function checkHealth(serviceUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${serviceUrl}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function startHealthCheck(config: RuntimeConfig, logger: PluginLogger): void {
  if (healthCheckTimer) {
    clearInterval(healthCheckTimer);
  }
  healthCheckTimer = setInterval(async () => {
    const healthy = await checkHealth(config.serviceUrl);
    if (healthy) {
      consecutiveFailures = 0;
      serviceReady = true;
      return;
    }

    if (!config.autoStart || consecutiveFailures >= MAX_FAILURES) {
      logger.warn('[local-memory] 健康检查失败，已停止自动重启');
      serviceReady = false;
      return;
    }

    logger.warn('[local-memory] 健康检查失败，尝试自动重启');
    consecutiveFailures += 1;
    stopLocalMemory(logger);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await startLocalMemory(config, logger);
  }, config.healthCheckInterval);
}

async function memoryRequest(
  baseUrl: string,
  method: 'GET' | 'POST' | 'DELETE',
  pathName: string,
  logger: PluginLogger,
  body?: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(`${baseUrl}${pathName}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(method === 'POST' ? 120000 : 10000),
    });
    if (!response.ok) {
      logger.warn(`[local-memory] ${method} ${pathName} -> ${response.status}`);
      return null;
    }
    return (await response.json()) as Record<string, unknown>;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`[local-memory] ${method} ${pathName} 失败: ${message}`);
    return null;
  }
}

function appendToolEvent(sessionId: string, text: string): void {
  if (!text.trim()) return;
  const events = sessionToolEvents.get(sessionId) || [];
  events.push(text.trim());
  sessionToolEvents.set(sessionId, events.slice(-20));
}

export default function localMemoryPlugin(api: OpenClawPluginApi): void {
  const config = (api.pluginConfig || {}) as LocalMemoryConfig;

  api.registerService({
    id: 'local-memory-service',
    start: async (ctx) => {
      const runtime = resolveRuntimeConfig(config, ctx);
      activeRuntimeConfig = runtime;
      if (!runtime.autoStart) {
        api.logger.info('[local-memory] 自动启动已禁用');
        return;
      }
      const success = await startLocalMemory(runtime, api.logger);
      if (success) {
        startHealthCheck(runtime, api.logger);
      }
    },
    stop: async () => {
      stopLocalMemory(api.logger);
    },
  });

  api.on('before_prompt_build', async (event, ctx) => {
    const runtime = activeRuntimeConfig || resolveRuntimeConfig(config, null);
    if (!runtime.autoInject || !event.prompt?.trim()) {
      return;
    }
    lastKnownWorkspaceDir = ctx.workspaceDir || lastKnownWorkspaceDir;

    const sessionKey = getSessionIdentifier(ctx);
    const result = await memoryRequest(runtime.serviceUrl, 'POST', '/context', api.logger, {
      query: event.prompt,
      workspace_dir: ctx.workspaceDir,
      session_key: sessionKey,
      route: runtime.injectStrategy,
      top_k: runtime.injectTopK,
    });

    if (!result?.success || !Array.isArray(result.results)) {
      return;
    }

    const eligible = (result.results as Array<Record<string, unknown>>).filter((item) => {
      const score = typeof item.score === 'number' ? item.score : 0;
      return score >= runtime.injectThreshold;
    });
    if (eligible.length === 0) {
      return;
    }

    const content = renderInjectedContext(
      normalizeInjectStrategy(result.route, runtime.injectStrategy),
      eligible.map((item) => ({
        title: typeof item.title === 'string' ? item.title : undefined,
        layer: typeof item.layer === 'string' ? item.layer : 'project_knowledge',
        visibility: typeof item.visibility === 'string' ? item.visibility : 'project',
        score: typeof item.score === 'number' ? item.score : undefined,
        summary: typeof item.summary === 'string' ? item.summary : undefined,
        content: typeof item.content === 'string' ? item.content : '',
      })),
    );

    api.logger.info(
      `[local-memory] 注入 ${eligible.length} 条记忆，route=${String(result.route || runtime.injectStrategy)}`,
    );
    return {
      prependContext: content,
    };
  });

  api.on('tool_result_persist', async (event, ctx) => {
    const sessionKey = getSessionIdentifier(ctx);
    lastKnownWorkspaceDir = ctx.workspaceDir || lastKnownWorkspaceDir;
    const toolName = event.toolName || 'tool';
    const paramKeys = event.params ? Object.keys(event.params).slice(0, 4).join(', ') : '';
    const message = flattenMessageContent(event.message?.content);
    const line = [toolName, paramKeys ? `params=${paramKeys}` : '', message ? `msg=${message.slice(0, 180)}` : '']
      .filter(Boolean)
      .join(' | ');
    appendToolEvent(sessionKey, line);
  });

  api.on('agent_end', async (event, ctx) => {
    const runtime = activeRuntimeConfig || resolveRuntimeConfig(config, null);
    if (!runtime.autoReflect || !Array.isArray(event.messages) || event.messages.length === 0) {
      return;
    }
    lastKnownWorkspaceDir = ctx.workspaceDir || lastKnownWorkspaceDir;

    const sessionKey = getSessionIdentifier(ctx);
    await memoryRequest(runtime.serviceUrl, 'POST', '/reflect', api.logger, {
      messages: event.messages,
      tool_events: sessionToolEvents.get(sessionKey) || [],
      workspace_dir: ctx.workspaceDir,
      session_key: sessionKey,
    });
    sessionToolEvents.delete(sessionKey);
    await maybeRunAutoArchive(runtime, ctx.workspaceDir, api.logger);
  });

  api.registerCommand({
    name: 'mem-ingest',
    description: '将网页内容写入分层记忆库',
    acceptsArgs: true,
    handler: async (cmdCtx) => {
      const runtime = activeRuntimeConfig || resolveRuntimeConfig(config, null);
      const raw = cmdCtx.args?.trim();
      if (!raw) {
        return '用法: /mem-ingest <URL> [--force] [--layer=project_knowledge] [--visibility=project]';
      }

      const { body, flags } = extractOptions(raw);
      const url = body.trim();
      try {
        new URL(url);
      } catch {
        return `无效的 URL: ${url}`;
      }

      const result = await memoryRequest(runtime.serviceUrl, 'POST', '/ingest/url', api.logger, {
        url,
        source_name: url,
        workspace_dir: resolveWorkspaceFromCommand(cmdCtx),
        layer: normalizeLayer(flags.layer, 'project_knowledge'),
        visibility: normalizeVisibility(flags.visibility, runtime.defaultVisibility),
        force: Boolean(flags.force),
      });

      if (!result?.success) {
        return `❌ 入库失败: ${String(result?.error || '服务不可用')}`;
      }
      return `✅ 入库成功\n来源: ${String(result.source || url)}\n层级: ${String(result.layer)}\n隐私: ${String(result.visibility)}\n块数: ${String(result.chunks_stored || 0)}`;
    },
  });

  api.registerCommand({
    name: 'mem-ingest-text',
    description: '手动写入项目知识或摘要',
    acceptsArgs: true,
    handler: async (cmdCtx) => {
      const runtime = activeRuntimeConfig || resolveRuntimeConfig(config, null);
      const raw = cmdCtx.args?.trim();
      if (!raw) {
        return '用法: /mem-ingest-text <名称>|<文本> [--layer=project_knowledge] [--visibility=project]';
      }

      const { body, flags } = extractOptions(raw);
      const divider = body.indexOf('|');
      if (divider === -1) {
        return '格式错误。用法: /mem-ingest-text <名称>|<文本>';
      }

      const sourceName = body.slice(0, divider).trim();
      const text = body.slice(divider + 1).trim();
      if (!sourceName || !text) {
        return '名称和文本都不能为空';
      }

      const result = await memoryRequest(runtime.serviceUrl, 'POST', '/ingest/text', api.logger, {
        text,
        source_name: sourceName,
        workspace_dir: resolveWorkspaceFromCommand(cmdCtx),
        layer: normalizeLayer(flags.layer, 'project_knowledge'),
        visibility: normalizeVisibility(flags.visibility, runtime.defaultVisibility),
        force: Boolean(flags.force),
      });

      if (!result?.success) {
        return `❌ 入库失败: ${String(result?.error || '服务不可用')}`;
      }
      return `✅ 入库成功\n名称: ${sourceName}\n层级: ${String(result.layer)}\n隐私: ${String(result.visibility)}\n块数: ${String(result.chunks_stored || 0)}`;
    },
  });

  api.registerCommand({
    name: 'mem-pref',
    description: '手动记录用户偏好',
    acceptsArgs: true,
    handler: async (cmdCtx) => {
      const runtime = activeRuntimeConfig || resolveRuntimeConfig(config, null);
      const raw = cmdCtx.args?.trim();
      if (!raw) {
        return '用法: /mem-pref <偏好描述> [--visibility=global|project]';
      }

      const { body, flags } = extractOptions(raw);
      const result = await memoryRequest(runtime.serviceUrl, 'POST', '/ingest/text', api.logger, {
        text: body,
        source_name: 'manual-preference',
        workspace_dir: resolveWorkspaceFromCommand(cmdCtx),
        layer: 'user_preference',
        visibility: normalizeVisibility(flags.visibility, 'global'),
        importance: 0.9,
        confidence: 0.88,
      });

      if (!result?.success) {
        return `❌ 记录偏好失败: ${String(result?.error || '服务不可用')}`;
      }
      return `✅ 已记录偏好\n隐私: ${String(result.visibility)}\n块数: ${String(result.chunks_stored || 0)}`;
    },
  });

  api.registerCommand({
    name: 'mem-recall',
    description: '检索当前项目相关记忆',
    acceptsArgs: true,
    handler: async (cmdCtx) => {
      const runtime = activeRuntimeConfig || resolveRuntimeConfig(config, null);
      const query = cmdCtx.args?.trim();
      if (!query) {
        return '用法: /mem-recall <查询>';
      }

      const result = await memoryRequest(runtime.serviceUrl, 'POST', '/recall', api.logger, {
        query,
        workspace_dir: resolveWorkspaceFromCommand(cmdCtx),
        session_key: 'manual-query',
        top_k: 6,
      });

      if (!result?.success || !Array.isArray(result.results)) {
        return `❌ 检索失败: ${String(result?.error || '服务不可用')}`;
      }

      const memories = result.results as Array<Record<string, unknown>>;
      if (memories.length === 0) {
        return '没有找到相关记忆';
      }

      const lines = ['🔍 检索结果:'];
      for (const [index, memory] of memories.entries()) {
        const title = typeof memory.title === 'string' ? memory.title : '未命名记忆';
        const layer = typeof memory.layer === 'string' ? memory.layer : 'unknown';
        const visibility = typeof memory.visibility === 'string' ? memory.visibility : 'unknown';
        const score = typeof memory.score === 'number' ? memory.score.toFixed(2) : '0.00';
        const preview = typeof memory.summary === 'string'
          ? memory.summary
          : typeof memory.content === 'string'
            ? memory.content.slice(0, 160)
            : '';
        lines.push(`[${index + 1}] ${title}`);
        lines.push(`    layer=${layer} visibility=${visibility} score=${score}`);
        lines.push(`    ${preview}`);
      }
      return lines.join('\n');
    },
  });

  api.registerCommand({
    name: 'mem-stats',
    description: '查看分层记忆状态',
    handler: async () => {
      const runtime = activeRuntimeConfig || resolveRuntimeConfig(config, null);
      const health = await checkHealth(runtime.serviceUrl);
      if (!health) {
        return '❌ 记忆服务不可用';
      }
      const workspace = lastKnownWorkspaceDir
        ? `?workspace_dir=${encodeURIComponent(lastKnownWorkspaceDir)}`
        : '';
      const stats = await memoryRequest(runtime.serviceUrl, 'GET', `/stats${workspace}`, api.logger);
      if (!stats?.success) {
        return '❌ 获取统计失败';
      }

      const layers = Object.entries((stats.layers || {}) as Record<string, number>)
        .map(([key, value]) => `  - ${key}: ${value}`)
        .join('\n') || '  (无)';
      const visibilities = Object.entries((stats.visibilities || {}) as Record<string, number>)
        .map(([key, value]) => `  - ${key}: ${value}`)
        .join('\n') || '  (无)';
      const routes = Object.entries((stats.route_usage || {}) as Record<string, number>)
        .map(([key, value]) => `  - ${key}: ${value}`)
        .join('\n') || '  (无)';

      return [
        `📊 Local Memory v${String(stats.version || '3')}`,
        `服务: ${runtime.serviceUrl}`,
        `状态: ${serviceReady ? '运行中' : '外部/未知'}`,
        `总记忆数: ${String(stats.total_chunks || 0)}`,
        `向量检索: ${stats.vector_enabled ? '开启' : '关闭'}`,
        '',
        '层级分布:',
        layers,
        '',
        '隐私分布:',
        visibilities,
        '',
        '注入路由:',
        routes,
      ].join('\n');
    },
  });

  api.registerCommand({
    name: 'mem-dashboard',
    description: '打开本地记忆仪表盘',
    handler: async () => {
      const runtime = activeRuntimeConfig || resolveRuntimeConfig(config, null);
      const workspace = lastKnownWorkspaceDir
        ? `?workspace_dir=${encodeURIComponent(lastKnownWorkspaceDir)}`
        : '';
      return [
        '🧭 记忆管理面板',
        `仪表盘: ${runtime.serviceUrl}/dashboard${workspace}`,
        `统计: ${runtime.serviceUrl}/stats${workspace}`,
        `健康: ${runtime.serviceUrl}/health`,
        `自动归档: ${runtime.autoArchive ? '开启' : '关闭'} / ${runtime.archiveAfterDays} 天 / ${runtime.archiveCheckIntervalMinutes} 分钟`,
      ].join('\n');
    },
  });

  api.registerCommand({
    name: 'mem-panel',
    description: '打开完整记忆管理入口',
    handler: async () => {
      const runtime = activeRuntimeConfig || resolveRuntimeConfig(config, null);
      const workspace = lastKnownWorkspaceDir
        ? `?workspace_dir=${encodeURIComponent(lastKnownWorkspaceDir)}`
        : '';
      return [
        '🧠 Local Memory Panel',
        `面板: ${runtime.serviceUrl}/dashboard${workspace}`,
        `统计: ${runtime.serviceUrl}/stats${workspace}`,
        `健康: ${runtime.serviceUrl}/health`,
        '',
        '常用命令:',
        '/mem-stats',
        '/mem-recall <query>',
        `/mem-archive --days=${runtime.archiveAfterDays}`,
        '/mem-health',
      ].join('\n');
    },
  });

  api.registerCommand({
    name: 'mem-archive',
    description: '归档旧的会话沉淀',
    acceptsArgs: true,
    handler: async (cmdCtx) => {
      const runtime = activeRuntimeConfig || resolveRuntimeConfig(config, null);
      const { flags } = extractOptions(cmdCtx.args?.trim() || '');
      const days = typeof flags.days === 'string' ? Number(flags.days) : 14;
      const result = await memoryRequest(runtime.serviceUrl, 'POST', '/archive/compact', api.logger, {
        days: Number.isFinite(days) ? days : 14,
        workspace_dir: resolveWorkspaceFromCommand(cmdCtx),
      });
      if (!result?.success) {
        return `❌ 归档失败: ${String(result?.error || '服务不可用')}`;
      }
      return `✅ 归档完成\n归档条数: ${String(result.archived_count || 0)}\n生成摘要: ${result.created_archive ? '是' : '否'}`;
    },
  });

  api.registerCommand({
    name: 'mem-cleanup',
    description: '删除指定来源或指定时间之前的记忆',
    acceptsArgs: true,
    handler: async (cmdCtx) => {
      const runtime = activeRuntimeConfig || resolveRuntimeConfig(config, null);
      const raw = cmdCtx.args?.trim();
      if (!raw) {
        return '用法: /mem-cleanup source=<来源> 或 /mem-cleanup before=<ISO日期>';
      }
      const parts = raw.split(/\s+/);
      const params = new URLSearchParams();
      for (const part of parts) {
        const [key, value] = part.split('=');
        if (key && value) {
          params.set(key, value);
        }
      }
      const result = await memoryRequest(
        runtime.serviceUrl,
        'DELETE',
        `/cleanup?${params.toString()}`,
        api.logger,
      );
      if (!result?.success) {
        return `❌ 清理失败: ${String(result?.error || '服务不可用')}`;
      }
      return `✅ 清理完成\n删除条数: ${String(result.deleted_count || 0)}`;
    },
  });

  api.registerCommand({
    name: 'mem-restart',
    description: '重启本地记忆服务',
    handler: async () => {
      const runtime = activeRuntimeConfig || resolveRuntimeConfig(config, null);
      stopLocalMemory(api.logger);
      await new Promise((resolve) => setTimeout(resolve, 1200));
      consecutiveFailures = 0;
      const success = await startLocalMemory(runtime, api.logger);
      if (success) {
        startHealthCheck(runtime, api.logger);
        return '✅ 记忆服务已重启';
      }
      return '❌ 重启失败';
    },
  });

  api.registerCommand({
    name: 'mem-health',
    description: '检查记忆服务健康状态',
    handler: async () => {
      const runtime = activeRuntimeConfig || resolveRuntimeConfig(config, null);
      const healthy = await checkHealth(runtime.serviceUrl);
      if (healthy) {
        return `✅ 记忆服务健康\n地址: ${runtime.serviceUrl}`;
      }
      return `❌ 记忆服务不可用\n地址: ${runtime.serviceUrl}`;
    },
  });

  api.logger.info('[local-memory] 插件 v3 已加载');
}
