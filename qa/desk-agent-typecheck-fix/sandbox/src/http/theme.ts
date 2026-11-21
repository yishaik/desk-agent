/**
 * Shared theme CSS variables for Desk Agent Web UI.
 * Zinc/indigo palette with RTL Hebrew support.
 */

export function getThemeCss(): string {
  return `
    :root {
      --bg-primary: #09090b;
      --bg-secondary: #18181b;
      --bg-tertiary: #27272a;
      --text-primary: #fafafa;
      --text-secondary: #a1a1aa;
      --text-muted: #71717a;
      --accent: #6366f1;
      --accent-hover: #4f46e5;
      --success: #22c55e;
      --error: #ef4444;
      --warning: #f59e0b;
      --border: #3f3f46;
      --border-subtle: #27272a;
    }
    
    * { box-sizing: border-box; margin: 0; padding: 0; }
    
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: var(--bg-primary);
      min-height: 100vh;
      color: var(--text-primary);
    }
  `;
}
