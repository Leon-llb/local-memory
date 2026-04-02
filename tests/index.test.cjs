const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { __testHooks } = require('../index.js');

const logger = {
  info() {},
  warn() {},
  error() {},
};

const baseConfig = {
  serviceUrl: 'http://127.0.0.1:37888',
  autoStart: true,
  autoInject: true,
  autoReflect: true,
  autoWorkflowHints: true,
  autoArchive: true,
  archiveAfterDays: 14,
  archiveCheckIntervalMinutes: 0.005,
  injectTopK: 8,
  injectThreshold: 0.18,
  injectStrategy: 'auto',
  scriptPath: '/tmp/start.sh',
  dbPath: '/tmp/agent-memory',
  healthCheckInterval: 20,
  ttlDays: 180,
  defaultVisibility: 'project',
};

test.afterEach(() => {
  __testHooks.stopAll(logger);
  __testHooks.resetHooks();
  __testHooks.resetState();
});

test('health supervisor keeps polling after a restart', async () => {
  let healthCalls = 0;
  let startCalls = 0;

  __testHooks.setHooks({
    checkHealth: async () => {
      healthCalls += 1;
      return healthCalls >= 2;
    },
    startService: async () => {
      startCalls += 1;
      return true;
    },
    sleep: async () => undefined,
  });

  __testHooks.startHealthCheck({ ...baseConfig }, logger);
  await new Promise((resolve) => setTimeout(resolve, 90));

  const state = __testHooks.getState();
  assert.equal(startCalls, 1);
  assert.ok(healthCalls >= 2);
  assert.equal(state.healthCheckActive, true);
  assert.equal(state.restartActive, false);
  assert.equal(state.serviceReady, true);
});

test('health supervisor avoids overlapping restarts', async () => {
  let startCalls = 0;
  let activeStarts = 0;
  let maxConcurrentStarts = 0;

  __testHooks.setHooks({
    checkHealth: async () => false,
    startService: async () => {
      startCalls += 1;
      activeStarts += 1;
      maxConcurrentStarts = Math.max(maxConcurrentStarts, activeStarts);
      await new Promise((resolve) => setTimeout(resolve, 60));
      activeStarts -= 1;
      return true;
    },
    sleep: async () => undefined,
  });

  __testHooks.startHealthCheck(
    {
      ...baseConfig,
      healthCheckInterval: 10,
    },
    logger,
  );
  await new Promise((resolve) => setTimeout(resolve, 35));

  assert.equal(startCalls, 1);
  assert.equal(maxConcurrentStarts, 1);
});

test('archive scheduler runs periodic sweep', async () => {
  let archiveCalls = 0;

  __testHooks.setHooks({
    archiveSweep: async (_config, _logger, workspaceDir) => {
      archiveCalls += 1;
      assert.equal(workspaceDir, undefined);
      return true;
    },
  });

  __testHooks.startArchiveSchedule({ ...baseConfig }, logger);
  await new Promise((resolve) => setTimeout(resolve, 360));

  const state = __testHooks.getState();
  assert.ok(archiveCalls >= 1);
  assert.equal(state.archiveActive, true);
});

test('workflow decision marks high-risk prompt for advisor and verification', () => {
  const prompt = `
  请把 openclaw 的记忆管理系统和插件 hook 全面升级，涉及 memory 路由、隐私、自动化、发布前验证、回归测试和配置变更。
  这次必须稳定，不能掉链子，还要补 review、qa、build、typecheck 和 release 检查。
  `;

  const decision = __testHooks.inferWorkflowDecision(prompt);

  assert.equal(decision.risk, 'high');
  assert.ok(decision.gates.includes('advisor'));
  assert.ok(decision.gates.includes('verification'));
  assert.ok(decision.route.includes('verification'));
});

test('workflow decision deduplicates repeated injection within a session', () => {
  const decision = __testHooks.inferWorkflowDecision(
    '请帮我重构 memory plugin 并补验证、测试和 release 检查',
  );

  assert.equal(__testHooks.shouldInjectWorkflowDecision('session-1', decision), true);
  assert.equal(__testHooks.shouldInjectWorkflowDecision('session-1', decision), false);
  assert.equal(__testHooks.shouldInjectWorkflowDecision('session-2', decision), true);
});

test('workflow commands create blackboard artifacts', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'local-memory-workflow-'));
  __testHooks.setBlackboardRoot(tempRoot);

  const commands = new Map();
  __testHooks.registerPlugin({
    id: 'local-memory',
    name: 'Local Memory',
    version: 'test',
    source: 'test',
    config: {},
    pluginConfig: baseConfig,
    logger,
    registerService() {},
    registerMemoryRuntime() {},
    registerCommand(command) {
      commands.set(command.name, command);
    },
    on() {},
  });

  const delegateResult = await commands.get('delegate').handler({
    senderId: 'tester',
    channel: 'test',
    isAuthorizedSender: true,
    args: '补齐多智能体派单约束 --task=TASK-900 --phase=plan',
    commandBody: '',
    config: { workspaceDir: '/tmp/workspace' },
  });
  const advisorResult = await commands.get('advisor').handler({
    senderId: 'tester',
    channel: 'test',
    isAuthorizedSender: true,
    args: '评估这次 memory hook 改动是否路线正确 --task=TASK-900 --stage=before-release',
    commandBody: '',
    config: { workspaceDir: '/tmp/workspace' },
  });
  const verifyResult = await commands.get('verify').handler({
    senderId: 'tester',
    channel: 'test',
    isAuthorizedSender: true,
    args: '验证 local-memory 的自动触发和回归测试 --task=TASK-900',
    commandBody: '',
    config: { workspaceDir: '/tmp/workspace' },
  });

  assert.match(String(delegateResult), /TASK-900/);
  assert.match(String(advisorResult), /TASK-900/);
  assert.match(String(verifyResult), /TASK-900/);

  const delegateFile = path.join(tempRoot, 'TASK-900', 'task-spec.md');
  const advisorFile = path.join(tempRoot, 'TASK-900', 'advisor-check.md');
  const verifyFile = path.join(tempRoot, 'TASK-900', 'qa-gate.md');

  assert.match(await fs.readFile(delegateFile, 'utf8'), /skill: openclaw-delegation/);
  assert.match(await fs.readFile(advisorFile, 'utf8'), /stage: before-release/);
  assert.match(await fs.readFile(verifyFile, 'utf8'), /skill: openclaw-verification-gate/);
});
