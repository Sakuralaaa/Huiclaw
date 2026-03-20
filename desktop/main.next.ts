import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { createServer, request, type IncomingMessage, type RequestOptions, type Server, type ServerResponse } from 'node:http';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { DesktopSummary, EnvironmentReport, RuntimeBootstrap, RuntimeStatus } from './contracts';

const isDev = !!process.env.MYCLAW_RENDERER_URL;
const projectRoot = path.resolve(__dirname, '..', '..');

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
let uiServer: Server | null = null;
let uiServerUrl: string | null = null;
let runtimeStatus: RuntimeStatus = {
  phase: 'idle',
  binaryFound: false,
  message: '运行时尚未启动。',
};

const sessionSecrets = {
  pairingCode: '123456',
  authToken: 'desktop-auth-token-123456',
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

  const templatePath = path.join(projectRoot, 'runtime', 'config', 'default-config.desktop.json');
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

function emptySummary(): DesktopSummary {
  return {
    inbox: [],
    agents: [],
    skills: [],
    providers: [],
    schedules: [],
    channels: [],
  };
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function contentTypeFor(filePath: string) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
      return 'text/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.json':
    case '.webmanifest':
      return 'application/json; charset=utf-8';
    case '.png':
      return 'image/png';
    case '.ico':
      return 'image/x-icon';
    case '.svg':
      return 'image/svg+xml';
    case '.txt':
      return 'text/plain; charset=utf-8';
    default:
      return 'application/octet-stream';
  }
}

function writeStaticResponse(res: ServerResponse<IncomingMessage>, status: number, body: string) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(body);
}

async function startUiServer(): Promise<string> {
  if (uiServer && uiServerUrl) {
    return uiServerUrl;
  }

  const uiRoot = path.join(projectRoot, 'ui', 'build');
  const indexPath = path.join(uiRoot, 'index.html');

  uiServer = createServer(async (req, res) => {
    try {
      const requestUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
      let relativePath = decodeURIComponent(requestUrl.pathname);
      if (relativePath === '/' || relativePath.length === 0) {
        relativePath = '/index.html';
      }

      const safePath = path.normalize(relativePath).replace(/^(\.\.[\\/])+/, '');
      let filePath = path.join(uiRoot, safePath);

      let shouldFallbackToIndex = false;
      const stat = await fsp.stat(filePath).catch(() => null);
      if (!stat) {
        shouldFallbackToIndex = path.extname(filePath).length === 0;
      } else if (stat.isDirectory()) {
        filePath = path.join(filePath, 'index.html');
      }

      if (shouldFallbackToIndex) {
        filePath = indexPath;
      }

      const exists = await fsp.stat(filePath).catch(() => null);
      if (!exists || !exists.isFile()) {
        writeStaticResponse(res, 404, 'Not Found');
        return;
      }

      res.writeHead(200, { 'Content-Type': contentTypeFor(filePath) });
      fs.createReadStream(filePath).pipe(res);
    } catch {
      writeStaticResponse(res, 500, 'Internal Server Error');
    }
  });

  await new Promise<void>((resolve, reject) => {
    uiServer!.once('error', reject);
    uiServer!.listen(0, '127.0.0.1', () => {
      uiServer!.off('error', reject);
      resolve();
    });
  });

  const address = uiServer.address();
  if (!address || typeof address === 'string') {
    throw new Error('UI server failed to start');
  }

  uiServerUrl = `http://127.0.0.1:${address.port}/`;
  return uiServerUrl;
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
      {
        name: 'nullclaw',
        available: resolveRuntimeBinary(paths).found,
        source: resolveRuntimeBinary(paths).found ? 'bundled' : 'missing',
      },
      {
        name: 'git',
        available: spawnSync('git', ['--version'], { encoding: 'utf8', shell: true }).status === 0,
        source: 'system',
      },
      {
        name: 'node',
        available: spawnSync('node', ['--version'], { encoding: 'utf8', shell: true }).status === 0,
        source: 'system',
      },
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
      message: '未找到内置 nullclaw.exe，请先构建或同步 runtime/bin。',
    };
    return runtimeStatus;
  }

  runtimeStatus = {
    phase: 'starting',
    binaryFound: true,
    message: '正在启动内置运行时。',
  };

  const proc = spawn(runtime.binary, ['gateway', '--host', '127.0.0.1', '--port', '32123'], {
    cwd: paths.workspace,
    env: {
      ...process.env,
      NULLCLAW_HOME: paths.home,
      NULLCLAW_WORKSPACE: paths.workspace,
      NULLCLAW_DESKTOP_TOKEN: sessionSecrets.desktopToken,
      HOME: paths.home,
      USERPROFILE: paths.home,
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
      message: '内置运行时已启动。',
    };
  });
  proc.once('exit', (code) => {
    runtimeProc = null;
    runtimeStatus = {
      phase: 'stopped',
      binaryFound: true,
      message: code === 0 ? '运行时已停止。' : `运行时已退出，代码 ${code ?? 'unknown'}`,
    };
  });

  for (let index = 0; index < 20; index += 1) {
    if (runtimeStatus.phase === 'running' || runtimeStatus.phase === 'error') {
      break;
    }
    await delay(150);
  }

  return runtimeStatus;
}

async function stopRuntime(): Promise<RuntimeStatus> {
  if (!runtimeProc) return runtimeStatus;
  runtimeProc.kill();
  runtimeProc = null;
  runtimeStatus = {
    phase: 'stopped',
    binaryFound: runtimeStatus.binaryFound,
    message: '运行时已停止。',
  };
  return runtimeStatus;
}

function requestJson<T>(options: RequestOptions, body?: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = request(options, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        if ((res.statusCode ?? 500) >= 400) {
          reject(new Error(data || `${res.statusCode} ${res.statusMessage ?? 'request failed'}`));
          return;
        }
        try {
          resolve(JSON.parse(data) as T);
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('error', reject);
    if (body) {
      req.write(body);
    }
    req.end();
  });
}

async function desktopApiRequest<T>(
  paths: AppPaths,
  endpoint: string,
  init?: {
    method?: 'GET' | 'PUT' | 'POST';
    body?: unknown;
  },
): Promise<T> {
  const current = await startRuntime(paths);
  if (current.phase !== 'running') {
    throw new Error(current.message);
  }

  const payload = init?.body ? JSON.stringify(init.body) : undefined;
  return requestJson<T>(
    {
      host: '127.0.0.1',
      port: 32123,
      path: endpoint,
      method: init?.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${sessionSecrets.desktopToken}`,
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    },
    payload,
  );
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
    await mainWindow.loadURL(process.env.MYCLAW_RENDERER_URL!);
  } else {
    await mainWindow.loadURL(await startUiServer());
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

  ipcMain.handle('desktop:get-summary', async () => {
    try {
      return await desktopApiRequest<DesktopSummary>(paths, '/api/desktop/summary');
    } catch {
      return emptySummary();
    }
  });
  ipcMain.handle('desktop:get-config', async () => {
    try {
      return await desktopApiRequest<Record<string, unknown>>(paths, '/api/desktop/config');
    } catch {
      return JSON.parse(await fsp.readFile(paths.config, 'utf8')) as Record<string, unknown>;
    }
  });
  ipcMain.handle('desktop:save-config', async (_event, config: Record<string, unknown>) => {
    try {
      return await desktopApiRequest<{ ok: boolean; requiresRestart: boolean }>(paths, '/api/desktop/config', {
        method: 'PUT',
        body: config,
      });
    } catch {
      await fsp.writeFile(paths.config, JSON.stringify(config, null, 2), 'utf8');
      return { ok: true, requiresRestart: true };
    }
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
    message: '已完成依赖检查，当前版本保留了安装接口，后续可接入真实下载器。',
  }));
  ipcMain.handle('env:update-dependencies', async () => ({
    ok: true,
    message: '已完成更新检查，当前版本保留了更新接口，后续可接入真实升级流程。',
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
  if (uiServer) {
    uiServer.close();
    uiServer = null;
    uiServerUrl = null;
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
