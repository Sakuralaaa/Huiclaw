export interface RuntimeBootstrap {
  locale: 'zh-CN' | 'en-US';
  theme: 'light' | 'dark';
  wsUrl: string;
  pairingCode: string;
  authToken: string;
  runtimeStatus: RuntimeStatus;
}

export interface RuntimeStatus {
  phase: 'idle' | 'starting' | 'running' | 'error' | 'stopped';
  binaryFound: boolean;
  pid?: number;
  message: string;
}

export interface EnvironmentReport {
  python: {
    configuredPath: string | null;
    detectedPath: string | null;
    version: string | null;
    available: boolean;
  };
  tools: Array<{
    name: string;
    available: boolean;
    source: 'bundled' | 'system' | 'custom' | 'missing';
    version?: string | null;
  }>;
}

export interface DesktopSummary {
  inbox: Array<{ id: string; title: string; channel: string; unread: number; agent: string }>;
  agents: Array<{ id: string; title: string; model: string; role: string }>;
  skills: Array<{ name: string; enabled: boolean; description: string }>;
  providers: Array<{ name: string; status: string; defaultModel: string }>;
  schedules: Array<{ id: string; name: string; mode: string; nextRun: string; enabled: boolean }>;
  channels: Array<{ id: string; account: string; status: string; health: string }>;
}

export interface DesktopBridge {
  getBootstrap: () => Promise<RuntimeBootstrap>;
  runtime: {
    start: () => Promise<RuntimeStatus>;
    stop: () => Promise<RuntimeStatus>;
    restart: () => Promise<RuntimeStatus>;
    status: () => Promise<RuntimeStatus>;
  };
  desktopApi: {
    getSummary: () => Promise<DesktopSummary>;
    getConfig: () => Promise<Record<string, unknown>>;
    saveConfig: (config: Record<string, unknown>) => Promise<{ ok: boolean; requiresRestart: boolean }>;
  };
  envApi: {
    detect: () => Promise<EnvironmentReport>;
    setPythonPath: (pythonPath: string | null) => Promise<EnvironmentReport>;
    installDependencies: () => Promise<{ ok: boolean; message: string }>;
    updateDependencies: () => Promise<{ ok: boolean; message: string }>;
  };
  logs: {
    subscribe: (callback: (line: string) => void) => () => void;
  };
  openPath: (target: 'workspace' | 'logs' | 'runtime') => Promise<void>;
}

