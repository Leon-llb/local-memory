"use strict";
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.__testHooks = void 0;
const child_process_1 = require("child_process");
const fs_1 = require("fs");
const os_1 = __importDefault(require("os"));
const path_1 = __importDefault(require("path"));
let memoryServiceProcess = null;
let serviceReady = false;
let healthCheckTimer = null;
let archiveTimer = null;
let consecutiveFailures = 0;
let activeRuntimeConfig = null;
let lastKnownWorkspaceDir;
let healthCheckInFlight = false;
let archiveSweepInFlight = false;
let restartInProgress = null;
let serviceStartInProgress = null;
const MAX_FAILURES = 3;
const STARTUP_TIMEOUT_MS = 60_000;
const STARTUP_POLL_INTERVAL_MS = 500;
const sessionToolEvents = new Map();
const workflowSessionStates = new Map();
const memoryVirtualFiles = new Map();
const DEFAULT_BLACKBOARD_ROOT = '/Users/leon/clawd/workspace/blackboard';
const WORKFLOW_SYSTEM_POLICY = [
    '<openclaw-workflow-policy>',
    '- If a workflow gate is marked required, run it before claiming implementation or completion.',
    '- Keep gate context short: write only delta evidence instead of replaying the whole chat.',
    '- Prefer blackboard files for durable handoff and review artifacts.',
    '</openclaw-workflow-policy>',
].join('\n');
const MAX_WORKFLOW_SESSION_STATES = 256;
let blackboardRoot = DEFAULT_BLACKBOARD_ROOT;
const noopLogger = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
};
function asBoolean(value, fallback) {
    return typeof value === 'boolean' ? value : fallback;
}
function asNumber(value, fallback) {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
function normalizeVisibility(value, fallback) {
    return value === 'private' || value === 'project' || value === 'global' ? value : fallback;
}
function normalizeLayer(value, fallback) {
    const allowed = new Set([
        'user_preference',
        'project_knowledge',
        'summary',
        'session_episode',
        'archive',
    ]);
    return typeof value === 'string' && allowed.has(value)
        ? value
        : fallback;
}
function normalizeInjectStrategy(value, fallback) {
    return value === 'auto' || value === 'lean' || value === 'balanced' || value === 'deep'
        ? value
        : fallback;
}
function flattenMessageContent(content) {
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
function getSessionIdentifier(ctx) {
    return ctx.sessionKey || ctx.agentId || 'default-session';
}
function hasPattern(text, patterns) {
    return patterns.some((pattern) => pattern.test(text));
}
function flattenUnknownMessage(message) {
    if (!message || typeof message !== 'object') {
        return '';
    }
    const content = message.content;
    if (typeof content === 'string') {
        return content;
    }
    if (Array.isArray(content)) {
        return content
            .map((item) => {
            if (!item || typeof item !== 'object') {
                return '';
            }
            const text = item.text;
            return typeof text === 'string' ? text : '';
        })
            .filter(Boolean)
            .join('\n');
    }
    return '';
}
function buildWorkflowPrompt(prompt, messages) {
    const parts = [prompt.trim()];
    const recentMessages = Array.isArray(messages) ? messages.slice(-6) : [];
    for (const message of recentMessages) {
        const flattened = flattenUnknownMessage(message).trim();
        if (flattened) {
            parts.push(flattened);
        }
    }
    return parts.filter(Boolean).join('\n');
}
function normalizeWorkflowText(text) {
    return text.toLowerCase().replace(/\s+/g, ' ').trim();
}
function simpleHash(text) {
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
}
function inferWorkflowDecision(prompt, messages) {
    const text = buildWorkflowPrompt(prompt, messages);
    if (!text) {
        return {
            gates: [],
            risk: 'low',
            reasons: [],
            route: [],
            signature: 'empty',
        };
    }
    const delegationPatterns = [
        /派单/i,
        /拆解/i,
        /分工/i,
        /多智能体/i,
        /子任务/i,
        /并行/i,
        /handoff/i,
        /delegate/i,
        /delegation/i,
        /subagent/i,
        /orchestr/i,
        /workflow/i,
        /route/i,
    ];
    const advisorPatterns = [
        /架构/i,
        /重构/i,
        /refactor/i,
        /rewrite/i,
        /migration/i,
        /迁移/i,
        /prompt/i,
        /提示词/i,
        /system prompt/i,
        /hook/i,
        /plugin/i,
        /插件/i,
        /config/i,
        /配置/i,
        /release/i,
        /上线/i,
        /deploy/i,
        /strategy/i,
        /方案/i,
        /路线/i,
        /agent/i,
    ];
    const verificationPatterns = [
        /验证/i,
        /验收/i,
        /review/i,
        /qa/i,
        /测试/i,
        /test/i,
        /typecheck/i,
        /build/i,
        /回归/i,
        /regression/i,
        /检查/i,
        /审查/i,
        /gate/i,
        /上线/i,
        /release/i,
        /merge/i,
        /\bpr\b/i,
    ];
    const stabilityPatterns = [
        /稳定/i,
        /长期运行/i,
        /long[- ]term/i,
        /production/i,
        /上线/i,
        /发布/i,
        /掉链子/i,
        /reliab/i,
    ];
    const riskPatterns = [
        /数据库/i,
        /db\b/i,
        /schema/i,
        /memory/i,
        /记忆/i,
        /隐私/i,
        /privacy/i,
        /cost/i,
        /路由/i,
        /router/i,
        /自动化/i,
        /automation/i,
        /agent/i,
    ];
    const gates = new Set();
    const reasons = [];
    let riskScore = 0;
    if (hasPattern(text, delegationPatterns)) {
        gates.add('delegation');
        riskScore += 1;
        reasons.push('task requires delegation or multi-agent routing');
    }
    if (hasPattern(text, advisorPatterns)) {
        gates.add('advisor');
        riskScore += 2;
        reasons.push('task changes architecture, prompts, tools, plugins, or configs');
    }
    if (hasPattern(text, verificationPatterns)) {
        gates.add('verification');
        riskScore += 2;
        reasons.push('task requires review, tests, regression, or release confidence');
    }
    if (hasPattern(text, stabilityPatterns)) {
        gates.add('verification');
        riskScore += 2;
        reasons.push('task explicitly prioritizes long-term stability');
    }
    if (hasPattern(text, riskPatterns)) {
        gates.add('advisor');
        riskScore += 1;
        reasons.push('task touches high-risk runtime or memory behavior');
    }
    if (text.length > 1200) {
        gates.add('advisor');
        riskScore += 2;
        reasons.push('task context is long or noisy; compress to delta evidence only');
    }
    if ((text.match(/\n/g) || []).length > 18) {
        gates.add('advisor');
        riskScore += 1;
    }
    const orderedGates = ['delegation', 'advisor', 'verification'].filter((gate) => gates.has(gate));
    if (orderedGates.includes('advisor') && orderedGates.includes('verification')) {
        riskScore += 1;
    }
    const route = ['plan'];
    if (orderedGates.includes('delegation')) {
        route.push('delegate');
    }
    if (orderedGates.includes('advisor')) {
        route.push('advisor');
    }
    route.push('implementation');
    if (orderedGates.includes('verification')) {
        route.push('verification');
    }
    const risk = riskScore >= 5 ? 'high' : riskScore >= 3 ? 'medium' : 'low';
    const normalized = normalizeWorkflowText(text).slice(0, 1200);
    return {
        gates: orderedGates,
        risk,
        reasons: reasons.filter((value, index) => reasons.indexOf(value) === index).slice(0, 3),
        route,
        signature: `${simpleHash(normalized)}:${orderedGates.join(',')}:${risk}`,
    };
}
function shouldInjectWorkflowDecision(sessionId, decision) {
    if (decision.gates.length === 0) {
        workflowSessionStates.delete(sessionId);
        return false;
    }
    const prev = workflowSessionStates.get(sessionId);
    const gateKey = decision.gates.join(',');
    if (prev && prev.signature === decision.signature && prev.gateKey === gateKey && prev.risk === decision.risk) {
        return false;
    }
    if (!prev && workflowSessionStates.size >= MAX_WORKFLOW_SESSION_STATES) {
        const oldestKey = workflowSessionStates.keys().next().value;
        if (typeof oldestKey === 'string') {
            workflowSessionStates.delete(oldestKey);
        }
    }
    workflowSessionStates.set(sessionId, {
        signature: decision.signature,
        gateKey,
        risk: decision.risk,
    });
    return true;
}
function renderWorkflowHints(decision) {
    if (decision.gates.length === 0) {
        return '';
    }
    const requirement = decision.risk === 'high'
        ? 'required'
        : decision.risk === 'medium'
            ? 'recommended'
            : 'suggested';
    const lines = ['<openclaw-workflow-gate>'];
    lines.push(`risk: ${decision.risk}`);
    lines.push(`gates: ${requirement} -> ${decision.gates.join(', ')}`);
    if (decision.reasons.length > 0) {
        lines.push(`why: ${decision.reasons.join('; ')}`);
    }
    if (decision.gates.includes('delegation')) {
        lines.push('- Run `/delegate <goal>` to write a scoped task spec, then use `openclaw-delegation` to fill it.');
    }
    if (decision.gates.includes('advisor')) {
        lines.push('- Run `/advisor <current-plan>` before committing to the current route.');
    }
    if (decision.gates.includes('verification')) {
        lines.push('- Run `/verify <target>` before declaring done or ready to release.');
    }
    lines.push(`route: ${decision.route.join(' -> ')}`);
    lines.push('- Keep gate notes delta-only; do not restate the full session history.');
    lines.push('</openclaw-workflow-gate>');
    return lines.join('\n');
}
function sanitizeTaskId(raw) {
    const value = raw.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
    return value || `TASK-${Date.now()}`;
}
function makeTaskId(prefix) {
    const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
    return `${prefix}-${timestamp}`;
}
async function writeBlackboardArtifact(taskId, fileName, content) {
    const dir = path_1.default.join(blackboardRoot, sanitizeTaskId(taskId));
    await fs_1.promises.mkdir(dir, { recursive: true });
    const filePath = path_1.default.join(dir, fileName);
    await fs_1.promises.writeFile(filePath, content, 'utf8');
    return filePath;
}
function buildDelegateArtifact(body, taskId, phase) {
    return [
        `task_id: ${taskId}`,
        `phase: ${phase}`,
        `purpose: ${body || '<why this child task exists>'}`,
        'scope:',
        '- <files/modules/commands/systems>',
        'known_evidence:',
        '- <error / observation / line number / link>',
        'constraints:',
        '- keep changes scoped',
        '- do not restate prior chat history',
        'done_when:',
        '- <what must be true>',
        'output:',
        '- status',
        '- deliverable',
        '- evidence',
        '- assumptions',
        '- risks',
        '- next_actions',
        '',
        'skill: openclaw-delegation',
    ].join('\n');
}
function buildAdvisorArtifact(body, taskId, stage) {
    return [
        `task_id: ${taskId}`,
        `stage: ${stage}`,
        `current_plan: ${body || '<what we plan to do>'}`,
        'known_evidence:',
        '- <facts / logs / errors / file refs>',
        'question_for_advisor:',
        '- What is most likely wrong with this plan?',
        '- What evidence is missing?',
        '- What verification should be added?',
        '- Should we stay on this route?',
        'required_output:',
        '- weak assumptions',
        '- missing evidence',
        '- regression risks',
        '- added verification',
        '- route recommendation',
        '',
        'skill: openclaw-advisor-gate',
    ].join('\n');
}
function buildVerificationArtifact(body, taskId) {
    return [
        `task_id: ${taskId}`,
        `target: ${body || '<what needs independent verification>'}`,
        'status: pass | partial | fail',
        'qa_report:',
        '- verified:',
        '  - <tests / build / typecheck / happy path>',
        '- findings:',
        '  - none',
        '- blind_spots:',
        '  - <untested area>',
        '- release_decision:',
        '  - <pass / partial / fail and why>',
        'evidence:',
        '- <commands / logs / file refs>',
        'risks:',
        '- <remaining risk>',
        'required_fixes:',
        '- <if any>',
        'next_actions:',
        '- <owner and next step>',
        '',
        'skill: openclaw-verification-gate',
    ].join('\n');
}
async function createWorkflowArtifact(params) {
    const taskId = sanitizeTaskId(params.taskId ||
        makeTaskId(params.kind === 'delegate'
            ? 'TASK'
            : params.kind === 'advisor'
                ? 'ADVISOR'
                : 'VERIFY'));
    if (params.kind === 'delegate') {
        const filePath = await writeBlackboardArtifact(taskId, 'task-spec.md', buildDelegateArtifact(params.body, taskId, params.phase || 'plan'));
        return { taskId, filePath };
    }
    if (params.kind === 'advisor') {
        const filePath = await writeBlackboardArtifact(taskId, 'advisor-check.md', buildAdvisorArtifact(params.body, taskId, params.stage || 'before-implementation'));
        return { taskId, filePath };
    }
    const filePath = await writeBlackboardArtifact(taskId, 'qa-gate.md', buildVerificationArtifact(params.body, taskId));
    return { taskId, filePath };
}
function extractOptions(raw) {
    const flags = {};
    const body = raw.replace(/--([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\s]+)))?/g, (_, key, a, b, c) => {
        flags[key] = a ?? b ?? c ?? true;
        return '';
    }).trim();
    return { body, flags };
}
function getPortFromUrl(serviceUrl) {
    try {
        const parsed = new URL(serviceUrl);
        return parsed.port || '37888';
    }
    catch {
        return '37888';
    }
}
function resolveWorkspaceFromCommand(cmdCtx) {
    const maybeConfig = cmdCtx.config;
    const candidate = maybeConfig.workspaceDir || maybeConfig.cwd || lastKnownWorkspaceDir;
    return typeof candidate === 'string' ? candidate : undefined;
}
function renderInjectedContext(route, memories) {
    const labels = {
        user_preference: '用户偏好',
        project_knowledge: '项目长期知识',
        summary: '沉淀摘要',
        session_episode: '近期会话片段',
        archive: '归档洞察',
    };
    const groups = new Map();
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
function resolveRuntimeConfig(config, ctx) {
    const scriptPath = config.scriptPath || path_1.default.resolve(__dirname, 'start.sh');
    const serviceUrl = config.serviceUrl || 'http://127.0.0.1:37888';
    const dbPath = config.dbPath || resolveDefaultDbPath(ctx);
    return {
        serviceUrl,
        autoStart: asBoolean(config.autoStart, true),
        autoInject: asBoolean(config.autoInject, true),
        autoReflect: asBoolean(config.autoReflect, true),
        autoWorkflowHints: asBoolean(config.autoWorkflowHints, true),
        autoArchive: asBoolean(config.autoArchive, true),
        archiveAfterDays: asNumber(config.archiveAfterDays, 14),
        archiveCheckIntervalMinutes: asNumber(config.archiveCheckIntervalMinutes, 360),
        injectTopK: asNumber(config.injectTopK, 8),
        injectThreshold: asNumber(config.injectThreshold, 0.18),
        injectStrategy: normalizeInjectStrategy(config.injectStrategy, 'auto'),
        scriptPath,
        dbPath,
        healthCheckInterval: asNumber(config.healthCheckInterval, 60000),
        ttlDays: asNumber(config.ttlDays, 180),
        defaultVisibility: normalizeVisibility(config.defaultVisibility, 'project'),
    };
}
function resolveDefaultDbPath(ctx) {
    if (ctx?.stateDir) {
        const stateDir = path_1.default.resolve(ctx.stateDir);
        if (!stateDir.includes(`${path_1.default.sep}extensions${path_1.default.sep}`)) {
            return path_1.default.join(stateDir, 'agent-memory');
        }
    }
    return path_1.default.join(resolveOpenClawHome(), 'agent-memory');
}
function resolveOpenClawHome() {
    const configuredHome = process.env.OPENCLAW_HOME?.trim();
    if (configuredHome) {
        return configuredHome;
    }
    return path_1.default.join(process.env.HOME || os_1.default.homedir(), '.openclaw');
}
async function startLocalMemory(config, logger) {
    if (serviceStartInProgress) {
        return serviceStartInProgress;
    }
    if (memoryServiceProcess) {
        if (serviceReady) {
            return true;
        }
        logger.warn('[local-memory] 检测到未就绪的旧进程，先执行回收');
        stopLocalMemoryProcess(logger);
    }
    const scriptPath = config.scriptPath;
    const cwdPath = path_1.default.dirname(scriptPath);
    const port = getPortFromUrl(config.serviceUrl);
    serviceReady = false;
    serviceStartInProgress = new Promise((resolve) => {
        let settled = false;
        const settle = (value) => {
            if (settled)
                return;
            settled = true;
            resolve(value);
        };
        logger.info(`[local-memory] 启动记忆服务: ${scriptPath}`);
        memoryServiceProcess = (0, child_process_1.spawn)('bash', [scriptPath, port, String(config.ttlDays), config.dbPath], {
            cwd: cwdPath,
            detached: false,
            env: { ...process.env, PYTHONUNBUFFERED: '1' },
        });
        memoryServiceProcess.stdout?.on('data', (data) => {
            const output = data.toString().trim();
            if (!output)
                return;
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
            if (!output)
                return;
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
                settle(false);
                return;
            }
            if (code !== 0) {
                logger.warn(`[local-memory] 服务异常退出: ${code}`);
            }
            settle(false);
        });
        void (async () => {
            const deadline = Date.now() + STARTUP_TIMEOUT_MS;
            while (Date.now() < deadline) {
                if (!memoryServiceProcess) {
                    settle(false);
                    return;
                }
                if (serviceReady) {
                    settle(true);
                    return;
                }
                if (await healthProbe(config.serviceUrl)) {
                    serviceReady = true;
                    consecutiveFailures = 0;
                    logger.info('[local-memory] 服务已通过健康探针就绪');
                    settle(true);
                    return;
                }
                await sleepImpl(STARTUP_POLL_INTERVAL_MS);
            }
            logger.warn('[local-memory] 服务启动超时');
            settle(false);
        })();
    }).finally(() => {
        serviceStartInProgress = null;
    });
    const pendingStartup = serviceStartInProgress;
    return pendingStartup;
}
function clearServiceTimers() {
    if (healthCheckTimer) {
        clearInterval(healthCheckTimer);
        healthCheckTimer = null;
    }
    if (archiveTimer) {
        clearInterval(archiveTimer);
        archiveTimer = null;
    }
}
function stopLocalMemoryProcess(logger) {
    if (memoryServiceProcess) {
        logger.info('[local-memory] 停止记忆服务');
        memoryServiceProcess.kill('SIGTERM');
        memoryServiceProcess = null;
    }
    serviceReady = false;
}
function stopLocalMemory(logger) {
    clearServiceTimers();
    healthCheckInFlight = false;
    archiveSweepInFlight = false;
    restartInProgress = null;
    serviceStartInProgress = null;
    stopLocalMemoryProcess(logger);
}
async function checkHealth(serviceUrl) {
    try {
        const response = await fetch(`${serviceUrl}/health`, {
            signal: AbortSignal.timeout(5000),
        });
        return response.ok;
    }
    catch {
        return false;
    }
}
async function sleep(ms) {
    await new Promise((resolve) => setTimeout(resolve, ms));
}
async function runArchiveSweep(config, logger, workspaceDir) {
    const body = {
        days: config.archiveAfterDays,
    };
    if (workspaceDir) {
        body.workspace_dir = workspaceDir;
    }
    else {
        body.all_projects = true;
    }
    const result = await memoryRequest(config.serviceUrl, 'POST', '/archive/compact', logger, body);
    if (!result?.success) {
        logger.warn('[local-memory] 自动归档扫描失败');
        return false;
    }
    const archivedCount = typeof result.archived_count === 'number' ? result.archived_count : 0;
    if (archivedCount > 0) {
        const scope = workspaceDir ? `workspace=${workspaceDir}` : 'all-projects';
        logger.info(`[local-memory] 自动归档完成 (${scope})，归档 ${archivedCount} 条记忆`);
    }
    return true;
}
let healthProbe = checkHealth;
let serviceStartImpl = startLocalMemory;
let sleepImpl = sleep;
let archiveSweepImpl = runArchiveSweep;
async function restartLocalMemory(config, logger, reason) {
    if (restartInProgress) {
        return restartInProgress;
    }
    restartInProgress = (async () => {
        logger.warn(`[local-memory] ${reason}，执行服务重启`);
        stopLocalMemoryProcess(logger);
        await sleepImpl(1500);
        const success = await serviceStartImpl(config, logger);
        serviceReady = success;
        if (success) {
            consecutiveFailures = 0;
        }
        return success;
    })().finally(() => {
        restartInProgress = null;
    });
    return restartInProgress;
}
async function ensureLocalMemoryReady(config, logger, reason) {
    const healthy = await healthProbe(config.serviceUrl);
    if (healthy) {
        serviceReady = true;
        consecutiveFailures = 0;
        if (config.autoStart) {
            startHealthCheck(config, logger);
            startArchiveSchedule(config, logger);
        }
        return true;
    }
    serviceReady = false;
    if (!config.autoStart) {
        logger.warn(`[local-memory] ${reason}，但自动启动已禁用`);
        return false;
    }
    logger.warn(`[local-memory] ${reason}，尝试恢复记忆服务`);
    const success = await serviceStartImpl(config, logger);
    if (success) {
        serviceReady = true;
        consecutiveFailures = 0;
        startHealthCheck(config, logger);
        startArchiveSchedule(config, logger);
    }
    return success;
}
async function runHealthCheckCycle(config, logger) {
    if (healthCheckInFlight || restartInProgress || serviceStartInProgress) {
        return;
    }
    healthCheckInFlight = true;
    try {
        const healthy = await healthProbe(config.serviceUrl);
        if (healthy) {
            consecutiveFailures = 0;
            serviceReady = true;
            return;
        }
        serviceReady = false;
        if (!config.autoStart) {
            logger.warn('[local-memory] 健康检查失败，自动启动已禁用');
            return;
        }
        if (consecutiveFailures >= MAX_FAILURES) {
            logger.warn('[local-memory] 健康检查失败，已停止自动重启');
            return;
        }
        consecutiveFailures += 1;
        await restartLocalMemory(config, logger, `健康检查失败，第 ${consecutiveFailures} 次`);
    }
    finally {
        healthCheckInFlight = false;
    }
}
function startHealthCheck(config, logger) {
    if (healthCheckTimer) {
        clearInterval(healthCheckTimer);
    }
    healthCheckTimer = setInterval(() => {
        void runHealthCheckCycle(config, logger);
    }, config.healthCheckInterval);
}
async function runArchiveCycle(config, logger) {
    if (!config.autoArchive || archiveSweepInFlight || restartInProgress || serviceStartInProgress) {
        return;
    }
    archiveSweepInFlight = true;
    try {
        await archiveSweepImpl(config, logger, undefined);
    }
    finally {
        archiveSweepInFlight = false;
    }
}
function startArchiveSchedule(config, logger) {
    if (archiveTimer) {
        clearInterval(archiveTimer);
        archiveTimer = null;
    }
    if (!config.autoArchive) {
        return;
    }
    const intervalMs = Math.max(Math.round(config.archiveCheckIntervalMinutes * 60_000), 250);
    archiveTimer = setInterval(() => {
        void runArchiveCycle(config, logger);
    }, intervalMs);
}
async function memoryRequest(baseUrl, method, pathName, logger, body) {
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
        return (await response.json());
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(`[local-memory] ${method} ${pathName} 失败: ${message}`);
        return null;
    }
}
function appendToolEvent(sessionId, text) {
    if (!text.trim())
        return;
    const events = sessionToolEvents.get(sessionId) || [];
    events.push(text.trim());
    sessionToolEvents.set(sessionId, events.slice(-20));
}
function buildMemoryVirtualPath(layer, memoryId) {
    return `local-memory/${layer}/${memoryId}.md`;
}
function storeMemoryVirtualFile(relPath, text) {
    memoryVirtualFiles.set(relPath, { path: relPath, text });
    if (memoryVirtualFiles.size <= 200) {
        return;
    }
    const oldestKey = memoryVirtualFiles.keys().next().value;
    if (typeof oldestKey === 'string') {
        memoryVirtualFiles.delete(oldestKey);
    }
}
function sliceVirtualFile(text, from, lines) {
    const allLines = text.split('\n');
    const startIndex = Math.max((from ?? 1) - 1, 0);
    const endIndex = lines && lines > 0
        ? startIndex + lines
        : allLines.length;
    return allLines.slice(startIndex, endIndex).join('\n');
}
function buildMemorySearchManager(runtime, logger) {
    return {
        async search(query, opts) {
            const ready = await ensureLocalMemoryReady(runtime, logger, '检索前服务不可用');
            if (!ready) {
                return [];
            }
            const result = await memoryRequest(runtime.serviceUrl, 'POST', '/recall', logger, {
                query,
                workspace_dir: lastKnownWorkspaceDir,
                session_key: opts?.sessionKey,
                top_k: opts?.maxResults ?? Math.max(runtime.injectTopK, 8),
            });
            if (!result?.success || !Array.isArray(result.results)) {
                return [];
            }
            const minScore = typeof opts?.minScore === 'number' ? opts.minScore : runtime.injectThreshold;
            return result.results
                .map((item) => {
                const score = typeof item.score === 'number' ? item.score : 0;
                const id = typeof item.id === 'string' ? item.id : '';
                const layer = typeof item.layer === 'string' ? item.layer : 'project_knowledge';
                const title = typeof item.title === 'string' ? item.title : 'memory';
                const summary = typeof item.summary === 'string' ? item.summary : '';
                const content = typeof item.content === 'string' ? item.content : summary;
                const snippet = (summary || content).trim();
                const relPath = buildMemoryVirtualPath(layer, id || title.replace(/\s+/g, '-'));
                const fileText = [
                    `# ${title}`,
                    '',
                    `layer: ${layer}`,
                    `score: ${score.toFixed(4)}`,
                    '',
                    content || summary,
                ].join('\n');
                storeMemoryVirtualFile(relPath, fileText);
                return {
                    path: relPath,
                    startLine: 1,
                    endLine: fileText.split('\n').length,
                    score,
                    snippet: snippet.slice(0, 300),
                    source: 'memory',
                    citation: `[${layer}] ${title}`,
                };
            })
                .filter((item) => item.score >= minScore);
        },
        async readFile(params) {
            const record = memoryVirtualFiles.get(params.relPath);
            if (!record) {
                throw new Error(`memory path not found: ${params.relPath}`);
            }
            return {
                path: record.path,
                text: sliceVirtualFile(record.text, params.from, params.lines),
            };
        },
        status() {
            return {
                backend: 'qmd',
                provider: 'local-memory',
                workspaceDir: lastKnownWorkspaceDir,
                dbPath: runtime.dbPath,
                vector: {
                    enabled: true,
                    available: serviceReady,
                },
                custom: {
                    serviceUrl: runtime.serviceUrl,
                    autoInject: runtime.autoInject,
                    autoReflect: runtime.autoReflect,
                    autoWorkflowHints: runtime.autoWorkflowHints,
                },
            };
        },
        async sync(params) {
            const ready = await ensureLocalMemoryReady(runtime, logger, '归档同步前服务不可用');
            if (!ready) {
                return;
            }
            params?.progress?.({ completed: 0, total: 1, label: 'archive compact' });
            await archiveSweepImpl(runtime, logger, lastKnownWorkspaceDir);
            params?.progress?.({ completed: 1, total: 1, label: 'archive compact' });
        },
        async probeEmbeddingAvailability() {
            const ready = await ensureLocalMemoryReady(runtime, logger, '探测 embedding 前服务不可用');
            if (!ready) {
                return {
                    ok: false,
                    error: 'memory service unavailable',
                };
            }
            const stats = await memoryRequest(runtime.serviceUrl, 'GET', '/stats', logger);
            const ok = Boolean(stats?.vector_enabled);
            return {
                ok,
                error: ok ? undefined : 'vector search disabled',
            };
        },
        async probeVectorAvailability() {
            const ready = await ensureLocalMemoryReady(runtime, logger, '探测向量能力前服务不可用');
            if (!ready) {
                return false;
            }
            const stats = await memoryRequest(runtime.serviceUrl, 'GET', '/stats', logger);
            return Boolean(stats?.vector_enabled);
        },
        async close() {
            memoryVirtualFiles.clear();
        },
    };
}
function registerLocalMemoryPlugin(api) {
    const config = (api.pluginConfig || {});
    if (api.registerMemoryRuntime) {
        api.registerMemoryRuntime({
            async getMemorySearchManager() {
                const runtime = activeRuntimeConfig || resolveRuntimeConfig(config, null);
                return {
                    manager: buildMemorySearchManager(runtime, api.logger),
                };
            },
            resolveMemoryBackendConfig() {
                return {
                    backend: 'qmd',
                    qmd: {
                        provider: 'local-memory',
                        serviceUrl: (activeRuntimeConfig || resolveRuntimeConfig(config, null)).serviceUrl,
                    },
                };
            },
            async closeAllMemorySearchManagers() {
                memoryVirtualFiles.clear();
            },
        });
    }
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
                startArchiveSchedule(runtime, api.logger);
            }
        },
        stop: async () => {
            stopLocalMemory(api.logger);
        },
    });
    api.on('before_prompt_build', async (event, ctx) => {
        const runtime = activeRuntimeConfig || resolveRuntimeConfig(config, null);
        if (!event.prompt?.trim()) {
            return;
        }
        lastKnownWorkspaceDir = ctx.workspaceDir || lastKnownWorkspaceDir;
        const sections = [];
        let prependSystemContext;
        const sessionKey = getSessionIdentifier(ctx);
        if (runtime.autoWorkflowHints) {
            const decision = inferWorkflowDecision(event.prompt, event.messages);
            const workflowHints = shouldInjectWorkflowDecision(sessionKey, decision)
                ? renderWorkflowHints(decision)
                : '';
            if (workflowHints) {
                api.logger.info(`[local-memory] 注入 workflow gate: ${decision.gates.join(',')} risk=${decision.risk}`);
                prependSystemContext = WORKFLOW_SYSTEM_POLICY;
                sections.push(workflowHints);
            }
        }
        if (runtime.autoInject) {
            const ready = await ensureLocalMemoryReady(runtime, api.logger, '构建提示词前记忆服务不可用');
            if (!ready) {
                api.logger.warn('[local-memory] 跳过记忆注入，服务仍不可用');
            }
            else {
                const result = await memoryRequest(runtime.serviceUrl, 'POST', '/context', api.logger, {
                    query: event.prompt,
                    workspace_dir: ctx.workspaceDir,
                    session_key: sessionKey,
                    route: runtime.injectStrategy,
                    top_k: runtime.injectTopK,
                });
                if (result?.success && Array.isArray(result.results)) {
                    const eligible = result.results.filter((item) => {
                        const score = typeof item.score === 'number' ? item.score : 0;
                        return score >= runtime.injectThreshold;
                    });
                    if (eligible.length > 0) {
                        const content = renderInjectedContext(normalizeInjectStrategy(result.route, runtime.injectStrategy), eligible.map((item) => ({
                            title: typeof item.title === 'string' ? item.title : undefined,
                            layer: typeof item.layer === 'string' ? item.layer : 'project_knowledge',
                            visibility: typeof item.visibility === 'string' ? item.visibility : 'project',
                            score: typeof item.score === 'number' ? item.score : undefined,
                            summary: typeof item.summary === 'string' ? item.summary : undefined,
                            content: typeof item.content === 'string' ? item.content : '',
                        })));
                        api.logger.info(`[local-memory] 注入 ${eligible.length} 条记忆，route=${String(result.route || runtime.injectStrategy)}`);
                        sections.push(content);
                    }
                }
            }
        }
        if (sections.length === 0) {
            return;
        }
        return {
            prependContext: sections.join('\n\n'),
            prependSystemContext,
        };
    });
    api.on('tool_result_persist', (event, ctx) => {
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
        lastKnownWorkspaceDir = ctx.workspaceDir || lastKnownWorkspaceDir;
        const sessionKey = getSessionIdentifier(ctx);
        try {
            if (!runtime.autoReflect || !Array.isArray(event.messages) || event.messages.length === 0) {
                return;
            }
            const ready = await ensureLocalMemoryReady(runtime, api.logger, '会话沉淀前记忆服务不可用');
            if (!ready) {
                api.logger.warn('[local-memory] 跳过自动沉淀，服务仍不可用');
                return;
            }
            await memoryRequest(runtime.serviceUrl, 'POST', '/reflect', api.logger, {
                messages: event.messages,
                tool_events: sessionToolEvents.get(sessionKey) || [],
                workspace_dir: ctx.workspaceDir,
                session_key: sessionKey,
            });
        }
        finally {
            sessionToolEvents.delete(sessionKey);
        }
    });
    api.registerCommand({
        name: 'delegate',
        description: '生成 delegation 任务单并落到黑板目录',
        acceptsArgs: true,
        handler: async (cmdCtx) => {
            const raw = cmdCtx.args?.trim();
            if (!raw) {
                return '用法: /delegate <任务目标> [--task=TASK-ID] [--phase=plan|build|fix|release]';
            }
            const { body, flags } = extractOptions(raw);
            const artifact = await createWorkflowArtifact({
                kind: 'delegate',
                body,
                taskId: typeof flags.task === 'string' ? flags.task : undefined,
                phase: typeof flags.phase === 'string' ? flags.phase : undefined,
            });
            return [
                '✅ 已生成 delegation 任务单',
                `任务: ${artifact.taskId}`,
                `文件: ${artifact.filePath}`,
                '下一步: 用 openclaw-delegation 补齐 scope / evidence / done_when，再派给子智能体',
            ].join('\n');
        },
    });
    api.registerCommand({
        name: 'advisor',
        description: '生成 advisor 二审单并落到黑板目录',
        acceptsArgs: true,
        handler: async (cmdCtx) => {
            const raw = cmdCtx.args?.trim();
            if (!raw) {
                return '用法: /advisor <当前计划> [--task=TASK-ID] [--stage=before-implementation|before-release]';
            }
            const { body, flags } = extractOptions(raw);
            const artifact = await createWorkflowArtifact({
                kind: 'advisor',
                body,
                taskId: typeof flags.task === 'string' ? flags.task : undefined,
                stage: typeof flags.stage === 'string' ? flags.stage : undefined,
            });
            return [
                '✅ 已生成 advisor 二审单',
                `任务: ${artifact.taskId}`,
                `文件: ${artifact.filePath}`,
                '下一步: 让 warmaster 或 advisor 视角先打掉弱假设，再继续实现',
            ].join('\n');
        },
    });
    api.registerCommand({
        name: 'verify',
        description: '生成 verification / QA gate 单并落到黑板目录',
        acceptsArgs: true,
        handler: async (cmdCtx) => {
            const raw = cmdCtx.args?.trim();
            if (!raw) {
                return '用法: /verify <待验证目标> [--task=TASK-ID]';
            }
            const { body, flags } = extractOptions(raw);
            const artifact = await createWorkflowArtifact({
                kind: 'verify',
                body,
                taskId: typeof flags.task === 'string' ? flags.task : undefined,
            });
            return [
                '✅ 已生成 verification gate',
                `任务: ${artifact.taskId}`,
                `文件: ${artifact.filePath}`,
                '下一步: 用 openclaw-verification-gate 补齐 findings / blind_spots / release_decision',
            ].join('\n');
        },
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
            }
            catch {
                return `无效的 URL: ${url}`;
            }
            const ready = await ensureLocalMemoryReady(runtime, api.logger, '手动入库前记忆服务不可用');
            if (!ready) {
                return '❌ 入库失败: 服务不可用';
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
            const ready = await ensureLocalMemoryReady(runtime, api.logger, '手动写入文本前记忆服务不可用');
            if (!ready) {
                return '❌ 入库失败: 服务不可用';
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
            const ready = await ensureLocalMemoryReady(runtime, api.logger, '记录偏好前记忆服务不可用');
            if (!ready) {
                return '❌ 记录偏好失败: 服务不可用';
            }
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
            const ready = await ensureLocalMemoryReady(runtime, api.logger, '检索记忆前记忆服务不可用');
            if (!ready) {
                return '❌ 检索失败: 服务不可用';
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
            const memories = result.results;
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
            const ready = await ensureLocalMemoryReady(runtime, api.logger, '读取统计前记忆服务不可用');
            if (!ready) {
                return '❌ 记忆服务不可用';
            }
            const workspace = lastKnownWorkspaceDir
                ? `?workspace_dir=${encodeURIComponent(lastKnownWorkspaceDir)}`
                : '';
            const stats = await memoryRequest(runtime.serviceUrl, 'GET', `/stats${workspace}`, api.logger);
            if (!stats?.success) {
                return '❌ 获取统计失败';
            }
            const layers = Object.entries((stats.layers || {}))
                .map(([key, value]) => `  - ${key}: ${value}`)
                .join('\n') || '  (无)';
            const visibilities = Object.entries((stats.visibilities || {}))
                .map(([key, value]) => `  - ${key}: ${value}`)
                .join('\n') || '  (无)';
            const routes = Object.entries((stats.route_usage || {}))
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
            return `仪表盘地址: ${runtime.serviceUrl}/dashboard${workspace}`;
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
            const ready = await ensureLocalMemoryReady(runtime, api.logger, '手动归档前记忆服务不可用');
            if (!ready) {
                return '❌ 归档失败: 服务不可用';
            }
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
            const ready = await ensureLocalMemoryReady(runtime, api.logger, '清理记忆前记忆服务不可用');
            if (!ready) {
                return '❌ 清理失败: 服务不可用';
            }
            const result = await memoryRequest(runtime.serviceUrl, 'DELETE', `/cleanup?${params.toString()}`, api.logger);
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
            await sleep(1200);
            consecutiveFailures = 0;
            const success = await startLocalMemory(runtime, api.logger);
            if (success) {
                startHealthCheck(runtime, api.logger);
                startArchiveSchedule(runtime, api.logger);
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
            const ready = await ensureLocalMemoryReady(runtime, api.logger, '检查健康状态时记忆服务不可用');
            if (ready) {
                return `✅ 记忆服务健康\n地址: ${runtime.serviceUrl}`;
            }
            return `❌ 记忆服务不可用\n地址: ${runtime.serviceUrl}`;
        },
    });
    api.logger.info('[local-memory] 插件 v3 已加载');
}
exports.default = {
    id: 'local-memory',
    name: 'Local Memory',
    description: 'Layered local memory for OpenClaw with project retention, preferences, workflow gates, slash commands, auto-reflection, archive compaction, cost-aware routing, privacy tiers, and dashboard',
    kind: 'memory',
    register: registerLocalMemoryPlugin,
};
exports.__testHooks = {
    getState() {
        return {
            healthCheckActive: Boolean(healthCheckTimer),
            archiveActive: Boolean(archiveTimer),
            serviceReady,
            consecutiveFailures,
            healthCheckInFlight,
            archiveSweepInFlight,
            restartActive: Boolean(restartInProgress),
            startActive: Boolean(serviceStartInProgress),
        };
    },
    resetState() {
        stopLocalMemory(noopLogger);
        consecutiveFailures = 0;
        activeRuntimeConfig = null;
        lastKnownWorkspaceDir = undefined;
        sessionToolEvents.clear();
        workflowSessionStates.clear();
        memoryVirtualFiles.clear();
        healthCheckInFlight = false;
        archiveSweepInFlight = false;
        restartInProgress = null;
        serviceStartInProgress = null;
        blackboardRoot = DEFAULT_BLACKBOARD_ROOT;
    },
    setHooks(overrides) {
        if (overrides.checkHealth) {
            healthProbe = overrides.checkHealth;
        }
        if (overrides.startService) {
            serviceStartImpl = overrides.startService;
        }
        if (overrides.sleep) {
            sleepImpl = overrides.sleep;
        }
        if (overrides.archiveSweep) {
            archiveSweepImpl = overrides.archiveSweep;
        }
    },
    resetHooks() {
        healthProbe = checkHealth;
        serviceStartImpl = startLocalMemory;
        sleepImpl = sleep;
        archiveSweepImpl = runArchiveSweep;
    },
    startHealthCheck(config, logger = noopLogger) {
        startHealthCheck(config, logger);
    },
    startArchiveSchedule(config, logger = noopLogger) {
        startArchiveSchedule(config, logger);
    },
    ensureReady(config, logger = noopLogger, reason = '测试触发') {
        return ensureLocalMemoryReady(config, logger, reason);
    },
    stopAll(logger = noopLogger) {
        stopLocalMemory(logger);
    },
    inferWorkflowDecision(prompt, messages) {
        return inferWorkflowDecision(prompt, messages);
    },
    shouldInjectWorkflowDecision(sessionId, decision) {
        return shouldInjectWorkflowDecision(sessionId, decision);
    },
    async createWorkflowArtifact(params) {
        return createWorkflowArtifact(params);
    },
    setBlackboardRoot(root) {
        blackboardRoot = root;
    },
    registerPlugin(api) {
        registerLocalMemoryPlugin(api);
    },
    resolveRuntimeConfig(config, ctx) {
        return resolveRuntimeConfig(config, ctx);
    },
};
