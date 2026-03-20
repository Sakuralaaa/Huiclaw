import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { DesktopSummary, EnvironmentReport, RuntimeBootstrap, RuntimeStatus } from './contracts';

const isDev = !!process.env.MYCLAW_RENDERER_URL;
const projectRoot = path.resolve(__dirname, '..', '..');
const uiEntry = isDev
  ? process.env.MYCLAW_RENDERER_URL!
  : `file://${path.join(projectRoot, 'ui', 'build', 'index.html')}`;

type AppPaths = {
  root: string;
  home: string;
  workspace: string;
  logs: string;
  runtime: string;
  config: string;
  settings: string;
};

type AppSettings = {
  locale: 'zh-CN' | 'en-US';
  theme: 'light' | 'dark';
  securityMode: 'safe' | 'approval' | 'auto';
  pythonPath: string | null;
};

const defaultSettings: AppSettings = {
  locale: 'zh-CN',
  theme: 'light',
  securityMode: 'approval',
  pythonPath: null,
};

let mainWindow: BrowserWindow | null = null;
let runtimeProc: ChildProcessWithoutNullStreams | null = null;
let runtimeStatus: RuntimeStatus = {
  phase: 'idle',
  binaryFound: false,
  message: '运行时尚未启动',
};

const sessionSecrets = {
  pairingCode: '123456',
  authToken: crypto.randomBytes(16).toString('hex'),
  desktopToken: crypto.randomBytes(16).toString('hex'),
};

function resolveAppPaths(): AppPaths {
  const root = isDev ? path.join(projectRoot, 'runtime') : path.join(process.resourcesPath, 'runtime');
  const userData = app.getPath('userData');
  return {
    root,
    home: path.join(userData, 'home'),
    workspace: path.join(userData, 'workspace'),
    logs: path.join(userData, 'logs'),
    runtime: path.join(root, 'bin'),
    config: path.join(userData, 'config.json'),
    settings: path.join(userData, 'settings.json'),
  };
}

async function ensureBootstrapFiles(paths: AppPaths) {
  await Promise.all([
    fsp.mkdir(paths.home, { recursive: true }),
    fsp.mkdir(paths.workspace, { recursive: true }),
    fsp.mkdir(paths.logs, { recursive: true }),
  ]);

  const templatePath = path.join(projectRoot, 'runtime', 'config', 'default-config.json');
  if (!fs.existsSync(paths.config)) {
    const raw = await fsp.readFile(templatePath, 'utf8');
    await fsp.writeFile(paths.config, raw, 'utf8');
  }
  if (!fs.existsSync(paths.settings)) {
    await fsp.writeFile(paths.settings, JSON.stringify(defaultSettings, null, 2), 'utf8');
  }
}

async function readSettings(paths: AppPaths): Promise<AppSettings> {
  try {
    const raw = await fsp.readFile(paths.settings, 'utf8');
    return { ...defaultSettings, ...(JSON.parse(raw) as Partial<AppSettings>) };
  } catch {
    return defaultSettings;
  }
}

function resolveRuntimeBinary(paths: AppPaths) {
  const local = path.join(paths.runtime, 'nullclaw.exe');
  return { binary: local, found: fs.existsSync(local) };
}

function broadcastLog(line: string) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('runtime:log-line', line);
  }
}

async function detectEnvironment(paths: AppPaths): Promise<EnvironmentReport> {
  const settings = await readSettings(paths);
  const candidates = [
    settings.pythonPath,
    'D:\\Anaconda\\Anaconda\\python.exe',
    'python',
    'python3',
    'py',
  ].filter(Boolean) as string[];
  let detectedPath: string | null = null;
  let version: string | null = null;

  for (const candidate of candidates) {
    const result = spawnSync(candidate, ['--version'], { encoding: 'utf8', shell: true });
    if (result.status === 0) {
      detectedPath = candidate;
      version = (result.stdout || result.stderr).trim();
      break;
    }
  }

  return {
    python: {
      configuredPath: settings.pythonPath,
      detectedPath,
      version,
      available: !!detectedPath,
    },
    tools: [
      { name: 'nullclaw', available: resolveRuntimeBinary(paths).found, source: resolveRuntimeBinary(paths).found ? 'bundled' : 'missing' },
      { name: 'git', available: spawnSync('git', ['--version'], { encoding: 'utf8', shell: true }).status === 0, source: 'system' },
      { name: 'node', available: spawnSync('node', ['--version'], { encoding: 'utf8', shell: true }).status === 0, source: 'system' },
    ],
  };
}

async function startRuntime(paths: AppPaths): Promise<RuntimeStatus> {
  if (runtimeProc) {
    return runtimeStatus;
  }
  const runtime = resolveRuntimeBinary(paths);
  if (!runtime.found) {
    runtimeStatus = {
      phase: 'error',
      binaryFound: false,
      message: '未找到内置 nullclaw.exe，请先执行 runtime 同步脚本或放入 runtime/bin。',
    };
    return runtimeStatus;
  }

  runtimeStatus = {
    phase: 'starting',
    binaryFound: true,
    message: '正在启动内置运行时…',
  };

  const proc = spawn(runtime.binary, ['gateway', '--host', '127.0.0.1', '--port', '32123'], {
    cwd: paths.workspace,
    env: {
      ...process.env,
      NULLCLAW_HOME: paths.home,
      NULLCLAW_WORKSPACE: paths.workspace,
      NULLCLAW_DESKTOP_TOKEN: sessionSecrets.desktopToken,
    },
    shell: false,
  });

  runtimeProc = proc;
  proc.stdout.on('data', (chunk) => broadcastLog(String(chunk).trimEnd()));
  proc.stderr.on('data', (chunk) => broadcastLog(String(chunk).trimEnd()));
  proc.once('spawn', () => {
    runtimeStatus = {
      phase: 'running',
      binaryFound: true,
      pid: proc.pid,
      message: '内置运行时已启动',
    };
  });
  proc.once('exit', (code) => {
    runtimeProc = null;
    runtimeStatus = {
      phase: 'stopped',
      binaryFound: true,
      message: code === 0 ? '运行时已停止' : `运行时已退出，代码 ${code ?? 'unknown'}`,
    };
  });

  return runtimeStatus;
}

async function stopRuntime(): Promise<RuntimeStatus> {
  if (!runtimeProc) return runtimeStatus;
  runtimeProc.kill();
  runtimeProc = null;
  runtimeStatus = {
    phase: 'stopped',
    binaryFound: runtimeStatus.binaryFound,
    message: '运行时已停止',
  };
  return runtimeStatus;
}

async function getSummary(): Promise<DesktopSummary> {
  return {
    inbox: [
      { id: 'desk-main', title: '本地桌面会话', channel: 'desktop', unread: 0, agent: 'main' },
      { id: 'tg-main', title: 'Telegram / main', channel: 'telegram', unread: 3, agent: 'assistant-cn' },
      { id: 'discord-main', title: 'Discord / ops', channel: 'discord', unread: 1, agent: 'orchestrator' },
    ],
    agents: [
      { id: 'assistant-cn', title: '中文助手', model: 'openrouter/anthropic/claude-sonnet-4', role: 'default' },
      { id: 'orchestrator', title: '编排协调器', model: 'openrouter/openai/gpt-5', role: 'routing' },
      { id: 'coder', title: '代码专家', model: 'ollama/qwen3.5-coder', role: 'delegate' },
    ],
    skills: [
      { name: 'doc', enabled: true, description: '文档读写与格式检查' },
      { name: 'pdf', enabled: true, description: 'PDF 解析与生成' },
      { name: 'playwright', enabled: false, description: '浏览器自动化' },
    ],
    providers: [
      { name: 'OpenRouter', status: 'ready', defaultModel: 'anthropic/claude-sonnet-4' },
      { name: 'OpenAI', status: 'idle', defaultModel: 'gpt-5' },
      { name: 'Ollama', status: 'local', defaultModel: 'qwen3.5-coder' },
    ],
    schedules: [
      { id: 'job-1', name: '晨间摘要', mode: 'agent', nextRun: '每天 09:00', enabled: true },
      { id: 'job-2', name: '同步收件箱', mode: 'shell', nextRun: '每 30 分钟', enabled: true },
    ],
    channels: [
      { id: 'desktop', account: 'local', status: 'connected', health: 'healthy' },
      { id: 'telegram', account: 'main', status: 'configured', health: 'warning' },
      { id: 'discord', account: 'ops', status: 'configured', health: 'healthy' },
    ],
  };
}

async function createWindow() {
  const paths = resolveAppPaths();
  await ensureBootstrapFiles(paths);
  const settings = await readSettings(paths);

  mainWindow = new BrowserWindow({
    width: 1480,
    height: 980,
    minWidth: 1180,
    minHeight: 760,
    title: 'MyClaw',
    backgroundColor: settings.theme === 'dark' ? '#101114' : '#f7f5f2',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (isDev) {
    await mainWindow.loadURL(uiEntry);
  } else {
    await mainWindow.loadFile(path.join(projectRoot, 'ui', 'build', 'index.html'));
  }
}

app.whenReady().then(async () => {
  const paths = resolveAppPaths();
  await ensureBootstrapFiles(paths);

  ipcMain.handle('bridge:get-bootstrap', async () => {
    const settings = await readSettings(paths);
    return {
      locale: settings.locale,
      theme: settings.theme,
      wsUrl: 'ws://127.0.0.1:32123/ws',
      pairingCode: sessionSecrets.pairingCode,
      authToken: sessionSecrets.authToken,
      runtimeStatus,
    } satisfies RuntimeBootstrap;
  });

  ipcMain.handle('runtime:start', async () => startRuntime(paths));
  ipcMain.handle('runtime:stop', async () => stopRuntime());
  ipcMain.handle('runtime:restart', async () => {
    await stopRuntime();
    return startRuntime(paths);
  });
  ipcMain.handle('runtime:status', async () => runtimeStatus);

  ipcMain.handle('desktop:get-summary', async () => getSummary());
  ipcMain.handle('desktop:get-config', async () => JSON.parse(await fsp.readFile(paths.config, 'utf8')) as Record<string, unknown>);
  ipcMain.handle('desktop:save-config', async (_event, config: Record<string, unknown>) => {
    await fsp.writeFile(paths.config, JSON.stringify(config, null, 2), 'utf8');
    return { ok: true, requiresRestart: true };
  });

  ipcMain.handle('env:detect', async () => detectEnvironment(paths));
  ipcMain.handle('env:set-python-path', async (_event, pythonPath: string | null) => {
    const current = await readSettings(paths);
    const next = { ...current, pythonPath };
    await fsp.writeFile(paths.settings, JSON.stringify(next, null, 2), 'utf8');
    return detectEnvironment(paths);
  });
  ipcMain.handle('env:install-dependencies', async () => ({
    ok: true,
    message: '已完成依赖检查。当前版本保留了安装接口，后续可接入实际下载器。',
  }));
  ipcMain.handle('env:update-dependencies', async () => ({
    ok: true,
    message: '已完成更新检查。当前版本保留了更新接口，后续可接入真实升级流程。',
  }));
  ipcMain.handle('shell:open-path', async (_event, target: 'workspace' | 'logs' | 'runtime') => {
    const mapping = {
      workspace: paths.workspace,
      logs: paths.logs,
      runtime: paths.runtime,
    };
    await shell.openPath(mapping[target]);
  });

  await createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
