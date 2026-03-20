# MyClaw

MyClaw 是一个中文优先的 NullClaw 一体化桌面控制台。

## 目标

- 开箱即用：内置运行时与默认配置
- 中文优先：默认中文界面与风险说明
- 现代化桌面体验：Notion 风工作台
- 小白可用，开发者可扩展：支持自定义 Python 与环境探测

## 目录

- `desktop/` Electron 主进程与 preload
- `ui/` Svelte 前端
- `runtime/` 运行时模板与 sidecar 目录
- `scripts/` 同步、构建与运行辅助脚本
- `.github/workflows/` 云编译工作流

## 本地开发

```powershell
npm install
npm run install:ui
npm run dev
```

## 本地打包

```powershell
npm run dist:win
```

