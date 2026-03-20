declare global {
  interface Window {
    myclaw?: import('$lib/bridge').DesktopBridge;
  }

  namespace App {}
}

export {};
