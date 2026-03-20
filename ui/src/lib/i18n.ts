export type Locale = 'zh-CN' | 'en-US';

type Copy = {
  nav: string[];
  labels: {
    runtime: string;
    env: string;
    approvals: string;
    config: string;
    logs: string;
    save: string;
    restart: string;
    start: string;
    stop: string;
    installDeps: string;
    updateDeps: string;
    workspace: string;
    openLogs: string;
    openRuntime: string;
    sending: string;
    send: string;
    inputPlaceholder: string;
  };
};

const copies: Record<Locale, Copy> = {
  'zh-CN': {
    nav: ['收件箱', '聊天', 'Agents', 'Skills', 'AI 供应商', '定时任务', '外部渠道', '历史与记忆', '日志与健康', '环境与依赖', '设置'],
    labels: {
      runtime: '运行时',
      env: '环境与依赖',
      approvals: '待批准',
      config: '配置',
      logs: '运行日志',
      save: '保存配置',
      restart: '重启运行时',
      start: '启动',
      stop: '停止',
      installDeps: '安装核心依赖',
      updateDeps: '更新核心依赖',
      workspace: '打开工作区',
      openLogs: '打开日志目录',
      openRuntime: '打开运行时目录',
      sending: '发送中...',
      send: '发送',
      inputPlaceholder: '输入中文指令，或直接输入“继续执行”“允许本次”等自然语言批准',
    },
  },
  'en-US': {
    nav: ['Inbox', 'Chat', 'Agents', 'Skills', 'Providers', 'Schedules', 'Channels', 'History', 'Logs', 'Environment', 'Settings'],
    labels: {
      runtime: 'Runtime',
      env: 'Environment',
      approvals: 'Approvals',
      config: 'Config',
      logs: 'Logs',
      save: 'Save Config',
      restart: 'Restart Runtime',
      start: 'Start',
      stop: 'Stop',
      installDeps: 'Install Core Deps',
      updateDeps: 'Update Core Deps',
      workspace: 'Open Workspace',
      openLogs: 'Open Logs',
      openRuntime: 'Open Runtime',
      sending: 'Sending...',
      send: 'Send',
      inputPlaceholder: 'Type a message or approve with natural language like "continue" or "allow once".',
    },
  },
};

export function getCopy(locale: Locale): Copy {
  return copies[locale] ?? copies['zh-CN'];
}
