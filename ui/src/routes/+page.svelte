<script lang="ts">
  import { onMount } from 'svelte';
  import { createConnectionController } from '$lib/session/connection-controller.svelte';
  import {
    getDesktopBridge,
    type DesktopSummary,
    type EnvironmentReport,
    type RuntimeBootstrap,
    type RuntimeStatus,
  } from '$lib/bridge';
  import { getCopy, type Locale } from '$lib/i18n';
  import { parseApprovalIntent } from '$lib/approval';

  type SectionId =
    | 'inbox'
    | 'chat'
    | 'agents'
    | 'skills'
    | 'providers'
    | 'schedules'
    | 'channels'
    | 'history'
    | 'logs'
    | 'environment'
    | 'settings';

  const sectionIds: SectionId[] = [
    'inbox',
    'chat',
    'agents',
    'skills',
    'providers',
    'schedules',
    'channels',
    'history',
    'logs',
    'environment',
    'settings',
  ];

  const connection = createConnectionController('desktop-main');
  const session = connection.session;

  let activeSection = $state<SectionId>('chat');
  let locale = $state<Locale>('zh-CN');
  let bootstrap = $state<RuntimeBootstrap | null>(null);
  let runtimeStatus = $state<RuntimeStatus | null>(null);
  let summary = $state<DesktopSummary | null>(null);
  let envReport = $state<EnvironmentReport | null>(null);
  let configText = $state('{\n  "loading": true\n}');
  let composer = $state('');
  let pythonPath = $state('');
  let logs = $state<string[]>([]);
  let feedback = $state<string | null>(null);
  let approvalSessionGranted = $state(false);

  const copy = $derived(getCopy(locale));
  const clientState = $derived(connection.clientState);
  const endpointUrl = $derived(connection.endpointUrl);
  const isPaired = $derived(connection.isPaired);
  const pairingError = $derived(connection.pairingError);
  const pendingApprovals = $derived(session.approvals.filter((item) => !item.resolved));
  const navItems = $derived(sectionIds.map((id, index) => ({ id, label: copy.nav[index] ?? id })));
  const timeline = $derived(
    [...session.messages].sort(
      (left, right) => (left.order ?? left.timestamp) - (right.order ?? right.timestamp),
    ),
  );

  async function refreshSummary() {
    const bridge = getDesktopBridge();
    if (!bridge) return;
    summary = await bridge.desktopApi.getSummary();
    const config = await bridge.desktopApi.getConfig();
    configText = JSON.stringify(config, null, 2);
    envReport = await bridge.envApi.detect();
    pythonPath = envReport.python.configuredPath ?? envReport.python.detectedPath ?? '';
  }

  async function bootstrapDesktop() {
    const bridge = getDesktopBridge();
    if (!bridge) {
      feedback = 'MyClaw 桥接未注入，当前页面需要在 Electron 桌面环境中运行。';
      return;
    }

    bootstrap = await bridge.getBootstrap();
    locale = bootstrap.locale;
    runtimeStatus = bootstrap.runtimeStatus;
    document.documentElement.dataset.theme = bootstrap.theme;

    if (runtimeStatus.phase !== 'running') {
      runtimeStatus = await bridge.runtime.start();
    }

    await refreshSummary();

    if (runtimeStatus.phase === 'running') {
      await connection.connectWithPairing(
        bootstrap.wsUrl,
        bootstrap.pairingCode,
        bootstrap.authToken,
      );
    }
  }

  async function updateRuntime(action: 'start' | 'stop' | 'restart') {
    const bridge = getDesktopBridge();
    if (!bridge) return;
    runtimeStatus = await bridge.runtime[action]();
    feedback = runtimeStatus.message;
  }

  async function saveConfig() {
    const bridge = getDesktopBridge();
    if (!bridge) return;
    try {
      const payload = JSON.parse(configText) as Record<string, unknown>;
      const result = await bridge.desktopApi.saveConfig(payload);
      feedback = result.requiresRestart
        ? '配置已保存，运行时需要重启才能完全生效。'
        : '配置已保存。';
    } catch {
      feedback = '配置 JSON 无法解析，请先修复格式。';
    }
  }

  async function updatePythonPath() {
    const bridge = getDesktopBridge();
    if (!bridge) return;
    envReport = await bridge.envApi.setPythonPath(pythonPath.trim() || null);
    feedback = 'Python 路径已更新。';
  }

  async function runDependencyAction(kind: 'installDependencies' | 'updateDependencies') {
    const bridge = getDesktopBridge();
    if (!bridge) return;
    const result = await bridge.envApi[kind]();
    feedback = result.message;
    envReport = await bridge.envApi.detect();
  }

  function respondApproval(approved: boolean) {
    const next = pendingApprovals[0];
    if (!next) return;
    connection.sendApproval(next.id, next.requestId, approved);
    feedback = approved ? '审批已发送。' : '已拒绝本次请求。';
  }

  function handleSend() {
    const value = composer.trim();
    if (!value) return;

    const approvalIntent = parseApprovalIntent(value);
    if (approvalIntent.kind !== 'message' && pendingApprovals.length > 0) {
      if (approvalIntent.kind === 'approve' && approvalIntent.scope === 'session') {
        approvalSessionGranted = true;
      }
      respondApproval(approvalIntent.kind === 'approve');
      composer = '';
      return;
    }

    if (connection.sendMessage(value)) {
      composer = '';
      feedback = null;
    }
  }

  $effect(() => {
    if (!approvalSessionGranted) return;
    const next = pendingApprovals[0];
    if (!next) return;
    connection.sendApproval(next.id, next.requestId, true);
  });

  onMount(() => {
    let unsubscribe = () => {};
    const bridge = getDesktopBridge();
    if (bridge) {
      unsubscribe = bridge.logs.subscribe((line) => {
        logs = [line, ...logs].slice(0, 80);
      });
    }

    bootstrapDesktop();

    return () => {
      unsubscribe();
      connection.dispose();
    };
  });
</script>

<div class="shell">
  <aside class="sidebar">
    <div class="brand">
      <h1>MyClaw</h1>
      <p>中文优先的 NullClaw 一体化桌面控制台</p>
    </div>

    <div class="nav-list">
      {#each navItems as item}
        <button class:active={activeSection === item.id} class="nav-button" onclick={() => (activeSection = item.id)}>
          <span>{item.label}</span>
          {#if item.id === 'inbox' && summary && summary.inbox.length > 0}
            <span class="badge">{summary.inbox.reduce((total, chat) => total + chat.unread, 0)}</span>
          {/if}
        </button>
      {/each}
    </div>

    <div class="panel">
      <div class="panel-header">
        <div>
          <h3 class="panel-title">安全模式</h3>
          <p class="tiny">安全 / 批准 / 全自动</p>
        </div>
        <span class="status-pill">{bootstrap?.runtimeStatus.phase ?? 'idle'}</span>
      </div>
      <p class="tiny">当前产品策略以用户明确指令为最高优先级，高风险动作会先解释风险，再等待批准。</p>
    </div>
  </aside>

  <main class="content">
    <div class="topbar">
      <div>
        <h2 class="section-title">{navItems.find((item) => item.id === activeSection)?.label}</h2>
        <p class="muted">内置运行时、现代工作台、中文交互、可扩展环境配置。</p>
      </div>
      <div class="topbar-actions">
        <button class="chip" onclick={() => (locale = locale === 'zh-CN' ? 'en-US' : 'zh-CN')}>{locale}</button>
        <button class="chip" onclick={() => (document.documentElement.dataset.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark')}>Theme</button>
        <span class="status-pill">{copy.labels.runtime}: {clientState}</span>
      </div>
    </div>

    <div class="content-scroll">
      {#if activeSection === 'chat'}
        <div class="grid two">
          <section class="panel">
            <div class="panel-header">
              <div>
                <h3 class="panel-title">本地聊天</h3>
                <p class="tiny">自动连接内置 WebChannel，无需手填 ws 地址或 PIN。</p>
              </div>
              <span class="status-pill">{isPaired ? 'paired' : pairingError ?? clientState}</span>
            </div>

            <div class="list">
              {#if timeline.length === 0}
                <div class="list-item">
                  <strong>聊天已就绪</strong>
                  <p class="tiny">你可以直接用中文发出任务，也可以输入“继续执行”“允许本次”等自然语言完成审批。</p>
                </div>
              {/if}

              {#each timeline as message}
                <div class="message {message.role}">
                  <strong>{message.role === 'user' ? '你' : 'MyClaw'}</strong>
                  <div>{message.content}</div>
                </div>
              {/each}
            </div>

            <div class="composer" style="margin-top: 16px;">
              <textarea bind:value={composer} placeholder={copy.labels.inputPlaceholder}></textarea>
              <div class="button-row">
                <button class="primary-button" onclick={handleSend} disabled={!isPaired || session.isAwaitingAssistant}>
                  {session.isAwaitingAssistant ? copy.labels.sending : copy.labels.send}
                </button>
                <span class="tiny">Endpoint: <span class="mono">{endpointUrl}</span></span>
              </div>
            </div>
          </section>

          <section class="panel">
            <div class="panel-header">
              <div>
                <h3 class="panel-title">工具与审批</h3>
                <p class="tiny">按钮批准和自然语言批准都可继续执行。</p>
              </div>
              <span class="status-pill">{copy.labels.approvals}: {pendingApprovals.length}</span>
            </div>

            <div class="list">
              {#each session.toolCalls as tool}
                <div class="list-item">
                  <strong>{tool.name}</strong>
                  <p class="tiny mono">{JSON.stringify(tool.arguments)}</p>
                  {#if tool.result}
                    <p class:success={tool.result.ok} class:danger={!tool.result.ok} class="tiny">{tool.result.ok ? '执行成功' : tool.result.error ?? '执行失败'}</p>
                  {/if}
                </div>
              {/each}

              {#each pendingApprovals as approval}
                <div class="list-item">
                  <strong>{approval.action}</strong>
                  <p class="tiny">{approval.reason ?? '等待用户批准后继续执行。'}</p>
                </div>
              {/each}
            </div>
          </section>
        </div>
      {:else if summary}
        <div class="grid two">
          <section class="panel">
            <div class="panel-header">
              <div>
                <h3 class="panel-title">{navItems.find((item) => item.id === activeSection)?.label}</h3>
                <p class="tiny">当前页面使用内置示例摘要承接桌面控制台能力，后续可直接接入 `/api/desktop/*` 的完整 JSON 数据。</p>
              </div>
            </div>

            <div class="list">
              {#if activeSection === 'inbox'}
                {#each summary.inbox as item}
                  <div class="list-item"><strong>{item.title}</strong><p class="tiny">{item.channel} · {item.agent} · 未读 {item.unread}</p></div>
                {/each}
              {:else if activeSection === 'agents'}
                {#each summary.agents as item}
                  <div class="list-item"><strong>{item.title}</strong><p class="tiny">{item.id} · {item.model} · {item.role}</p></div>
                {/each}
              {:else if activeSection === 'skills'}
                {#each summary.skills as item}
                  <div class="list-item"><strong>{item.name}</strong><p class="tiny">{item.description} · {item.enabled ? '已启用' : '未启用'}</p></div>
                {/each}
              {:else if activeSection === 'providers'}
                {#each summary.providers as item}
                  <div class="list-item"><strong>{item.name}</strong><p class="tiny">{item.status} · 默认模型 {item.defaultModel}</p></div>
                {/each}
              {:else if activeSection === 'schedules'}
                {#each summary.schedules as item}
                  <div class="list-item"><strong>{item.name}</strong><p class="tiny">{item.mode} · {item.nextRun} · {item.enabled ? '启用中' : '已暂停'}</p></div>
                {/each}
              {:else if activeSection === 'channels' || activeSection === 'history'}
                {#each summary.channels as item}
                  <div class="list-item"><strong>{item.id}</strong><p class="tiny">{item.account} · {item.status} · {item.health}</p></div>
                {/each}
              {:else}
                <div class="list-item"><strong>桌面控制台</strong><p class="tiny">这一页会随着 Desktop API 扩展持续接入更完整的实时数据。</p></div>
              {/if}
            </div>
          </section>

          <section class="panel">
            <div class="panel-header">
              <div>
                <h3 class="panel-title">{copy.labels.config}</h3>
                <p class="tiny">支持小白表单 + 开发者高级 JSON 双模式，这里先提供全量 JSON 编辑入口。</p>
              </div>
            </div>
            <textarea bind:value={configText} class="config-editor"></textarea>
            <div class="button-row" style="margin-top: 12px;">
              <button class="primary-button" onclick={saveConfig}>{copy.labels.save}</button>
              <button class="secondary-button" onclick={() => updateRuntime('restart')}>{copy.labels.restart}</button>
            </div>
          </section>
        </div>
      {/if}
    </div>
  </main>

  <aside class="details">
    <div class="details-scroll">
      <div class="grid">
        <section class="panel">
          <div class="panel-header">
            <div>
              <h3 class="panel-title">{copy.labels.runtime}</h3>
              <p class="tiny">{runtimeStatus?.message ?? '等待初始化'}</p>
            </div>
            <span class="status-pill">{runtimeStatus?.phase ?? 'idle'}</span>
          </div>
          <div class="button-row">
            <button class="secondary-button" onclick={() => updateRuntime('start')}>{copy.labels.start}</button>
            <button class="secondary-button" onclick={() => updateRuntime('stop')}>{copy.labels.stop}</button>
            <button class="primary-button" onclick={() => updateRuntime('restart')}>{copy.labels.restart}</button>
          </div>
        </section>

        <section class="panel">
          <div class="panel-header">
            <div>
              <h3 class="panel-title">{copy.labels.approvals}</h3>
              <p class="tiny">支持按钮批准和自然语言批准。</p>
            </div>
          </div>
          <div class="list">
            {#if pendingApprovals.length === 0}
              <div class="list-item"><strong>当前没有待审批动作</strong><p class="tiny">风险操作会先进入这里，再由你决定是否继续。</p></div>
            {/if}
            {#each pendingApprovals as approval}
              <div class="list-item">
                <strong>{approval.action}</strong>
                <p class="tiny">{approval.reason ?? '等待批准'}</p>
              </div>
            {/each}
          </div>
          <div class="button-row" style="margin-top: 12px;">
            <button class="primary-button" onclick={() => respondApproval(true)}>允许本次</button>
            <button class="secondary-button" onclick={() => respondApproval(false)}>拒绝</button>
          </div>
        </section>

        <section class="panel">
          <div class="panel-header">
            <div>
              <h3 class="panel-title">{copy.labels.env}</h3>
              <p class="tiny">面向小白自动检测，也支持开发者覆盖 Python 路径。</p>
            </div>
          </div>
          <div class="list">
            <div class="list-item">
              <strong>Python</strong>
              <p class="tiny mono">{envReport?.python.detectedPath ?? '未检测到'}</p>
              <p class="tiny">{envReport?.python.version ?? '暂无版本信息'}</p>
            </div>
            {#each envReport?.tools ?? [] as tool}
              <div class="list-item"><strong>{tool.name}</strong><p class="tiny">{tool.available ? '可用' : '缺失'} · {tool.source}</p></div>
            {/each}
          </div>
          <div class="composer" style="margin-top: 12px;">
            <textarea bind:value={pythonPath} placeholder="自定义 Python 路径，例如 D:\\Anaconda\\Anaconda\\python.exe"></textarea>
            <div class="button-row">
              <button class="secondary-button" onclick={updatePythonPath}>更新 Python 路径</button>
              <button class="secondary-button" onclick={() => runDependencyAction('installDependencies')}>{copy.labels.installDeps}</button>
              <button class="secondary-button" onclick={() => runDependencyAction('updateDependencies')}>{copy.labels.updateDeps}</button>
            </div>
          </div>
        </section>

        <section class="panel">
          <div class="panel-header">
            <div>
              <h3 class="panel-title">{copy.labels.logs}</h3>
              <p class="tiny">运行时输出会实时汇总到这里。</p>
            </div>
          </div>
          <div class="list">
            {#each logs.slice(0, 12) as line}
              <div class="list-item"><p class="tiny mono">{line}</p></div>
            {/each}
          </div>
          <div class="button-row" style="margin-top: 12px;">
            <button class="secondary-button" onclick={() => getDesktopBridge()?.openPath('workspace')}>{copy.labels.workspace}</button>
            <button class="secondary-button" onclick={() => getDesktopBridge()?.openPath('logs')}>{copy.labels.openLogs}</button>
            <button class="secondary-button" onclick={() => getDesktopBridge()?.openPath('runtime')}>{copy.labels.openRuntime}</button>
          </div>
        </section>

        {#if feedback}
          <section class="panel">
            <strong>状态</strong>
            <p class="tiny">{feedback}</p>
          </section>
        {/if}
      </div>
    </div>
  </aside>
</div>
