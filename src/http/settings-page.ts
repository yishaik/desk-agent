import type { Settings, PairingState } from '../core/types.ts';

interface ConnectorStatus {
  healthy: boolean;
  connectionCount: number;
  consoleUrl?: string;
}

export interface SettingsPageData {
  settings: Settings;
  pairingState: PairingState;
  connectorStatus: ConnectorStatus;
}

export function getSettingsHtml(data: SettingsPageData): string {
  const { settings, pairingState, connectorStatus } = data;
  
  const safeBotName = escapeHtml(settings.botName);
  
  return `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${safeBotName} - הגדרות</title>
  <style>
    :root {
      --bg-primary: #09090b;
      --bg-secondary: #18181b;
      --bg-tertiary: #27272a;
      --text-primary: #fafafa;
      --text-secondary: #a1a1aa;
      --text-muted: #71717a;
      --accent: #6366f1;
      --accent-hover: #4f46e5;
      --success: #10b981;
      --error: #ef4444;
      --warning: #f59e0b;
      --border: #3f3f46;
    }
    
    * { box-sizing: border-box; margin: 0; padding: 0; }
    
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: var(--bg-primary);
      min-height: 100vh;
      color: var(--text-primary);
    }
    
    .navbar {
      background: var(--bg-secondary);
      padding: 16px 24px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid var(--border);
      position: sticky;
      top: 0;
      z-index: 100;
    }
    
    .navbar h1 {
      font-size: 20px;
      display: flex;
      align-items: center;
      gap: 12px;
    }
    
    .back-link {
      color: var(--text-secondary);
      text-decoration: none;
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 14px;
      transition: color 0.2s;
    }
    
    .back-link:hover { color: var(--text-primary); }
    
    .container {
      max-width: 800px;
      margin: 0 auto;
      padding: 32px 24px;
    }
    
    .page-title {
      font-size: 28px;
      margin-bottom: 8px;
    }
    
    .page-subtitle {
      color: var(--text-secondary);
      margin-bottom: 32px;
    }
    
    .section {
      background: var(--bg-secondary);
      border-radius: 12px;
      padding: 24px;
      margin-bottom: 24px;
      border: 1px solid var(--border);
    }
    
    .section-header {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 20px;
    }
    
    .section-icon {
      font-size: 24px;
    }
    
    .section-title {
      font-size: 18px;
      font-weight: 600;
    }
    
    .section-description {
      color: var(--text-secondary);
      font-size: 14px;
      margin-bottom: 20px;
    }
    
    .form-group {
      margin-bottom: 20px;
    }
    
    .form-row {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 16px;
    }
    
    @media (max-width: 600px) {
      .form-row { grid-template-columns: 1fr; }
    }
    
    label {
      display: block;
      margin-bottom: 8px;
      font-weight: 500;
      color: var(--text-secondary);
      font-size: 14px;
    }
    
    input, select, textarea {
      width: 100%;
      padding: 12px 16px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--bg-tertiary);
      color: var(--text-primary);
      font-size: 14px;
      font-family: inherit;
      transition: border-color 0.2s;
    }
    
    input:focus, select:focus, textarea:focus {
      outline: none;
      border-color: var(--accent);
    }
    
    textarea {
      resize: vertical;
      min-height: 80px;
    }
    
    select option { background: var(--bg-tertiary); }
    
    button {
      padding: 12px 24px;
      background: var(--accent);
      color: white;
      border: none;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      transition: background 0.2s;
    }
    
    button:hover { background: var(--accent-hover); }
    
    button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    
    button.secondary {
      background: transparent;
      border: 1px solid var(--border);
      color: var(--text-primary);
    }
    
    button.secondary:hover {
      background: var(--bg-tertiary);
    }
    
    button.danger {
      background: var(--error);
    }
    
    button.danger:hover {
      background: #dc2626;
    }
    
    .btn-group {
      display: flex;
      gap: 12px;
      margin-top: 24px;
    }
    
    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 12px;
      border-radius: 20px;
      font-size: 13px;
      font-weight: 500;
    }
    
    .status-badge.success {
      background: rgba(16, 185, 129, 0.15);
      color: var(--success);
    }
    
    .status-badge.error {
      background: rgba(239, 68, 68, 0.15);
      color: var(--error);
    }
    
    .status-badge.warning {
      background: rgba(245, 158, 11, 0.15);
      color: var(--warning);
    }
    
    .provider-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 16px;
      background: var(--bg-tertiary);
      border-radius: 8px;
      margin-bottom: 12px;
    }
    
    .provider-info {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    
    .provider-name {
      font-weight: 500;
    }
    
    .provider-status {
      font-size: 13px;
      color: var(--text-muted);
    }
    
    .info-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 0;
      border-bottom: 1px solid var(--border);
    }
    
    .info-row:last-child { border-bottom: none; }
    
    .info-label {
      color: var(--text-secondary);
      font-size: 14px;
    }
    
    .info-value {
      font-weight: 500;
    }
    
    .qr-container {
      background: white;
      padding: 20px;
      border-radius: 8px;
      display: inline-block;
      margin: 20px 0;
    }
    
    .qr-container img {
      display: block;
      max-width: 200px;
    }
    
    .toast {
      position: fixed;
      bottom: 24px;
      left: 50%;
      transform: translateX(-50%);
      background: var(--bg-secondary);
      color: var(--text-primary);
      padding: 12px 24px;
      border-radius: 8px;
      border: 1px solid var(--border);
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
      display: none;
      z-index: 1000;
    }
    
    .toast.success { border-color: var(--success); }
    .toast.error { border-color: var(--error); }
    
    .modal-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.7);
      display: none;
      align-items: center;
      justify-content: center;
      z-index: 1000;
    }
    
    .modal-backdrop.active { display: flex; }
    
    .modal {
      background: var(--bg-secondary);
      border-radius: 12px;
      padding: 24px;
      max-width: 400px;
      width: 90%;
      border: 1px solid var(--border);
    }
    
    .modal-title {
      font-size: 18px;
      margin-bottom: 12px;
    }
    
    .modal-description {
      color: var(--text-secondary);
      font-size: 14px;
      margin-bottom: 20px;
    }
    
    .external-link {
      color: var(--accent);
      text-decoration: none;
    }
    
    .external-link:hover {
      text-decoration: underline;
    }
    
    .tool-card {
      background: var(--bg-tertiary);
      border-radius: 12px;
      padding: 20px;
      margin-bottom: 16px;
    }
    
    .tool-card-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      margin-bottom: 16px;
    }
    
    .tool-card-info {
      display: flex;
      align-items: center;
      gap: 14px;
      flex: 1;
      min-width: 0;
    }
    
    .tool-logo {
      width: 48px;
      height: 48px;
      border-radius: 12px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 24px;
      font-weight: 600;
      flex-shrink: 0;
    }
    
    .tool-card-details {
      flex: 1;
      min-width: 0;
    }
    
    .tool-card-name {
      font-weight: 600;
      font-size: 16px;
      margin-bottom: 4px;
    }
    
    .tool-card-identity {
      font-size: 13px;
      color: var(--success);
      display: flex;
      align-items: center;
      gap: 4px;
    }
    
    .tool-card-actions-header {
      font-size: 12px;
      color: var(--text-muted);
      margin-bottom: 10px;
      font-weight: 500;
    }
    
    .action-chips {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    
    .action-chip {
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 6px 10px;
      font-size: 12px;
      color: var(--text-secondary);
    }
    
    .action-chip-title {
      font-weight: 500;
      color: var(--text-primary);
    }
    
    .action-chip-desc {
      font-size: 11px;
      color: var(--text-muted);
      margin-top: 2px;
    }
    
    .action-more {
      background: transparent;
      border: 1px dashed var(--border);
      color: var(--text-muted);
      font-style: italic;
    }
    
    .tool-switch {
      display: flex;
      align-items: center;
      gap: 8px;
      cursor: pointer;
      user-select: none;
    }
    
    .tool-switch-track {
      width: 36px;
      height: 20px;
      background: var(--border);
      border-radius: 10px;
      position: relative;
      transition: background 0.2s;
    }
    
    .tool-switch-track.enabled {
      background: var(--accent);
    }
    
    .tool-switch-thumb {
      width: 16px;
      height: 16px;
      background: white;
      border-radius: 50%;
      position: absolute;
      top: 2px;
      right: 18px;
      transition: right 0.2s;
    }
    
    .tool-switch-track.enabled .tool-switch-thumb {
      right: 2px;
    }
    
    .tool-switch-label {
      font-size: 13px;
      color: var(--text-secondary);
    }
    
    .tool-card.disabled {
      opacity: 0.5;
    }
    
    .tool-card-controls {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    
    .action-chip.with-switch {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      min-width: 180px;
    }
    
    .action-chip.with-switch.disabled {
      opacity: 0.5;
    }
    
    .action-chip-content {
      flex: 1;
      min-width: 0;
    }
    
    .action-switch {
      display: flex;
      align-items: center;
      gap: 4px;
      cursor: pointer;
      flex-shrink: 0;
    }
    
    .action-switch-track {
      width: 28px;
      height: 16px;
      background: var(--border);
      border-radius: 8px;
      position: relative;
      transition: background 0.2s;
    }
    
    .action-switch-track.enabled {
      background: var(--accent);
    }
    
    .action-switch-thumb {
      width: 12px;
      height: 12px;
      background: white;
      border-radius: 50%;
      position: absolute;
      top: 2px;
      right: 14px;
      transition: right 0.2s;
    }
    
    .action-switch-track.enabled .action-switch-thumb {
      right: 2px;
    }
    
    .action-switch-label {
      font-size: 11px;
      color: var(--text-muted);
      min-width: 32px;
    }
    
    .empty-state {
      text-align: center;
      padding: 32px 16px;
      color: var(--text-muted);
    }
    
    .empty-state-icon {
      font-size: 48px;
      margin-bottom: 12px;
      opacity: 0.5;
    }
    
    .tools-grid {
      display: grid;
      gap: 16px;
    }
  </style>
</head>
<body>
  <nav class="navbar">
    <h1>⚙️ הגדרות</h1>
    <a href="/" class="back-link">
      <span>חזרה</span>
      <span>←</span>
    </a>
  </nav>

  <div class="container">
    <h2 class="page-title">הגדרות ${safeBotName}</h2>
    <p class="page-subtitle">ניהול הזהות, חיבורי AI ושירותים</p>

    <!-- Identity Section -->
    <div class="section">
      <div class="section-header">
        <span class="section-icon">👤</span>
        <h3 class="section-title">זהות</h3>
      </div>
      <p class="section-description">פרטי הבעלים והעסק שישמשו את הסוכן</p>
      
      <form id="identityForm">
        <div class="form-row">
          <div class="form-group">
            <label for="ownerName">שם הבעלים</label>
            <input type="text" id="ownerName" name="ownerName" value="${escapeHtml(settings.ownerName)}" placeholder="השם שלך">
          </div>
          <div class="form-group">
            <label for="businessName">שם העסק</label>
            <input type="text" id="businessName" name="businessName" value="${escapeHtml(settings.businessName || '')}" placeholder="שם החברה או העסק">
          </div>
        </div>
        
        <div class="form-row">
          <div class="form-group">
            <label for="botName">שם הבוט</label>
            <input type="text" id="botName" name="botName" value="${escapeHtml(settings.botName)}" placeholder="Desk Agent">
          </div>
          <div class="form-group">
            <label for="timezone">אזור זמן</label>
            <select id="timezone" name="timezone">
              <option value="Asia/Jerusalem" ${settings.timezone === 'Asia/Jerusalem' ? 'selected' : ''}>ישראל (Asia/Jerusalem)</option>
              <option value="UTC" ${settings.timezone === 'UTC' ? 'selected' : ''}>UTC</option>
              <option value="America/New_York" ${settings.timezone === 'America/New_York' ? 'selected' : ''}>ניו יורק</option>
              <option value="Europe/London" ${settings.timezone === 'Europe/London' ? 'selected' : ''}>לונדון</option>
              <option value="Europe/Paris" ${settings.timezone === 'Europe/Paris' ? 'selected' : ''}>פריז</option>
              <option value="Asia/Tokyo" ${settings.timezone === 'Asia/Tokyo' ? 'selected' : ''}>טוקיו</option>
            </select>
          </div>
        </div>
        
        <div class="form-group">
          <label for="businessDescription">תיאור העסק</label>
          <textarea id="businessDescription" name="businessDescription" placeholder="תאר את העסק שלך בקצרה - מה אתם עושים, מי הלקוחות שלכם...">${escapeHtml(settings.businessDescription || '')}</textarea>
        </div>
        
        <div class="form-group">
          <label for="agentVoice">סגנון ואישיות</label>
          <textarea id="agentVoice" name="agentVoice" placeholder="איך הסוכן צריך לדבר? רשמי, ידידותי, מקצועי...">${escapeHtml(settings.agentVoice || '')}</textarea>
        </div>
        
        <div class="form-group">
          <label for="agentBoundaries">גבולות</label>
          <textarea id="agentBoundaries" name="agentBoundaries" placeholder="מה הסוכן לא צריך לעשות? נושאים להימנע מהם...">${escapeHtml(settings.agentBoundaries || '')}</textarea>
        </div>
        
        <div class="btn-group">
          <button type="submit">שמור שינויים</button>
        </div>
      </form>
    </div>

    <!-- AI Providers Section -->
    <div class="section">
      <div class="section-header">
        <span class="section-icon">🧠</span>
        <h3 class="section-title">ספקי AI</h3>
      </div>
      <p class="section-description">התחבר לספקי AI כדי להפעיל את הסוכן</p>
      
      <div id="providersContainer">
        <p style="color: var(--text-muted);">טוען...</p>
      </div>
    </div>

    <!-- Open Connector Section -->
    <div class="section">
      <div class="section-header">
        <span class="section-icon">🔌</span>
        <h3 class="section-title">Open Connector</h3>
      </div>
      <p class="section-description">חיבור לשירותים חיצוניים כמו Gmail, Calendar ועוד</p>
      
      <div class="info-row">
        <span class="info-label">סטטוס</span>
        <span class="status-badge ${connectorStatus.healthy ? 'success' : 'error'}">
          ${connectorStatus.healthy ? '✓ תקין' : '✗ לא זמין'}
        </span>
      </div>
      <div class="info-row">
        <span class="info-label">חיבורים פעילים</span>
        <span class="info-value">${connectorStatus.connectionCount}</span>
      </div>
      <div class="btn-group">
        <a href="${escapeHtml(connectorStatus.consoleUrl || '/connector/')}" target="_blank">
          <button type="button" class="secondary">פתח את הקונסול</button>
        </a>
      </div>
    </div>

    <!-- Tools Section -->
    <div class="section">
      <div class="section-header">
        <span class="section-icon">🧰</span>
        <h3 class="section-title">כלים מחוברים</h3>
      </div>
      <p class="section-description">הכלים והשירותים שהסוכן יכול להשתמש בהם</p>
      
      <div id="toolsContainer">
        <p style="color: var(--text-muted);">טוען...</p>
      </div>
    </div>

    <!-- WhatsApp Section -->
    <div class="section">
      <div class="section-header">
        <span class="section-icon">📱</span>
        <h3 class="section-title">WhatsApp</h3>
      </div>
      <p class="section-description">חיבור WhatsApp לשליחת וקבלת הודעות</p>
      
      <div class="info-row">
        <span class="info-label">סטטוס</span>
        <span class="status-badge ${pairingState.isPaired ? 'success' : 'error'}">
          ${pairingState.isPaired ? '✓ מחובר' : '✗ מנותק'}
        </span>
      </div>
      ${pairingState.isPaired ? `
        ${pairingState.name ? `
        <div class="info-row">
          <span class="info-label">שם</span>
          <span class="info-value">${escapeHtml(pairingState.name)}</span>
        </div>
        ` : ''}
        ${pairingState.phoneNumber ? `
        <div class="info-row">
          <span class="info-label">טלפון</span>
          <span class="info-value">${escapeHtml(pairingState.phoneNumber)}</span>
        </div>
        ` : ''}
      ` : `
        <div id="qrSection" style="text-align: center; margin-top: 20px;">
          <p style="color: var(--text-secondary); margin-bottom: 16px;">סרוק QR לחיבור מחדש</p>
          <button type="button" onclick="showQrCode()" class="secondary">חבר מחדש</button>
          <div id="qrDisplay" style="display: none; margin-top: 20px;">
            <div class="qr-container">
              <img id="qrImage" src="" alt="QR Code">
            </div>
            <p style="color: var(--text-muted); font-size: 13px;">QR מתעדכן כל 60 שניות</p>
          </div>
        </div>
      `}
    </div>
  </div>

  <!-- Paste Callback Modal -->
  <div class="modal-backdrop" id="pasteModal">
    <div class="modal">
      <h3 class="modal-title">הדבק קוד אישור</h3>
      <p class="modal-description">אם החלון לא נפתח, העתק את הקישור מכאן והדבק את הקוד שחזר:</p>
      <div class="form-group">
        <label for="callbackUrl">קוד או URL מלא</label>
        <input type="text" id="callbackUrl" placeholder="הדבק כאן...">
      </div>
      <div class="btn-group">
        <button type="button" onclick="submitCallback()">אשר</button>
        <button type="button" class="secondary" onclick="closeModal()">ביטול</button>
      </div>
    </div>
  </div>

  <div class="toast" id="toast"></div>

  <script>
    let currentProvider = null;
    let loginPollInterval = null;

    function escapeHtml(str) {
      if (!str) return '';
      return str.replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;');
    }

    function showToast(message, type = 'success') {
      const toast = document.getElementById('toast');
      toast.textContent = message;
      toast.className = 'toast ' + type;
      toast.style.display = 'block';
      setTimeout(() => { toast.style.display = 'none'; }, 3000);
    }

    function closeModal() {
      document.getElementById('pasteModal').classList.remove('active');
      currentProvider = null;
    }

    async function loadProviders() {
      try {
        const res = await fetch('/api/auth/providers');
        const { data } = await res.json();
        
        const container = document.getElementById('providersContainer');
        container.innerHTML = data.map(p => \`
          <div class="provider-item">
            <div class="provider-info">
              <span class="provider-name">\${escapeHtml(p.name)}</span>
              <span class="provider-status">\${p.isConnected ? '✓ מחובר' : 'לא מחובר'}</span>
            </div>
            <div>
              \${p.isConnected 
                ? \`<button type="button" class="danger" onclick="disconnectProvider('\${p.id}')">ניתוק</button>\`
                : \`<button type="button" onclick="connectProvider('\${p.id}')">התחבר</button>\`
              }
            </div>
          </div>
        \`).join('');
      } catch (err) {
        document.getElementById('providersContainer').innerHTML = 
          '<p style="color: var(--error);">שגיאה בטעינת ספקים</p>';
      }
    }

    async function connectProvider(providerId) {
      currentProvider = providerId;
      
      const popup = window.open('about:blank', '_blank', 'noopener');
      
      try {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider: providerId })
        });
        
        const json = await res.json();
        
        if (json.authorizeUrl) {
          if (popup && !popup.closed) {
            popup.location = json.authorizeUrl;
          } else {
            window.open(json.authorizeUrl, '_blank');
          }
          
          startLoginPoll(providerId);
          
          setTimeout(() => {
            document.getElementById('pasteModal').classList.add('active');
          }, 2000);
        } else {
          if (popup && !popup.closed) popup.close();
          showToast(json.error || 'שגיאה בהתחברות', 'error');
        }
      } catch (err) {
        if (popup && !popup.closed) popup.close();
        showToast('שגיאה בהתחברות', 'error');
      }
    }

    function startLoginPoll(providerId) {
      if (loginPollInterval) {
        clearInterval(loginPollInterval);
      }
      
      loginPollInterval = setInterval(async () => {
        try {
          const res = await fetch(\`/api/auth/login/\${providerId}/status\`);
          const { data } = await res.json();
          
          if (data.status === 'success') {
            clearInterval(loginPollInterval);
            loginPollInterval = null;
            closeModal();
            showToast('התחברות הצליחה!');
            loadProviders();
          } else if (data.status === 'failed') {
            clearInterval(loginPollInterval);
            loginPollInterval = null;
            closeModal();
            showToast(data.error || 'ההתחברות נכשלה', 'error');
          }
        } catch (err) {
          // Continue polling
        }
      }, 2000);
      
      setTimeout(() => {
        if (loginPollInterval) {
          clearInterval(loginPollInterval);
          loginPollInterval = null;
        }
      }, 120000);
    }

    async function submitCallback() {
      const callbackUrl = document.getElementById('callbackUrl').value;
      if (!callbackUrl || !currentProvider) return;
      
      try {
        const res = await fetch('/api/auth/complete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            provider: currentProvider, 
            codeOrRedirectUrl: callbackUrl 
          })
        });
        
        const json = await res.json();
        
        if (json.success) {
          closeModal();
          showToast('התחברות הצליחה!');
          loadProviders();
        } else {
          showToast(json.error || 'שגיאה באישור', 'error');
        }
      } catch (err) {
        showToast('שגיאה באישור', 'error');
      }
    }

    async function disconnectProvider(providerId) {
      if (!confirm(\`האם לנתק את \${providerId}?\`)) return;
      
      try {
        const res = await fetch('/api/auth/logout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider: providerId })
        });
        
        const json = await res.json();
        
        if (json.success) {
          showToast('נותק בהצלחה');
          loadProviders();
        } else {
          showToast(json.error || 'שגיאה בניתוק', 'error');
        }
      } catch (err) {
        showToast('שגיאה בניתוק', 'error');
      }
    }

    async function showQrCode() {
      const display = document.getElementById('qrDisplay');
      display.style.display = 'block';
      
      try {
        const res = await fetch('/api/pairing');
        const { data } = await res.json();
        
        if (data.qrDataUrl) {
          document.getElementById('qrImage').src = data.qrDataUrl;
        } else if (data.qrCode) {
          document.getElementById('qrImage').alt = 'טוען QR...';
        }
        
        setTimeout(() => showQrCode(), 60000);
      } catch (err) {
        showToast('שגיאה בטעינת QR', 'error');
      }
    }

    document.getElementById('identityForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      
      const form = new FormData(e.target);
      const data = Object.fromEntries(form.entries());
      
      try {
        const res = await fetch('/api/settings', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data)
        });
        
        if (res.ok) {
          showToast('ההגדרות נשמרו בהצלחה');
        } else {
          showToast('שגיאה בשמירה', 'error');
        }
      } catch (err) {
        showToast('שגיאה בשמירה', 'error');
      }
    });

    function humanizeAction(action) {
      if (action.displayName) return action.displayName;
      const id = action.id || '';
      const parts = id.split('.');
      const actionPart = parts.length > 1 ? parts.slice(1).join('.') : id;
      return actionPart
        .replace(/_/g, ' ')
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .split(' ')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
        .join(' ');
    }

    function getToolLogo(tool) {
      if (tool.icon && !tool.icon.includes('🔧')) {
        return \`<span style="font-size: 28px;">\${escapeHtml(tool.icon)}</span>\`;
      }
      const name = tool.name || tool.id || '?';
      const letter = name.charAt(0).toUpperCase();
      const colors = [
        ['#4285F4', '#fff'], ['#EA4335', '#fff'], ['#34A853', '#fff'], 
        ['#FBBC05', '#000'], ['#6366f1', '#fff'], ['#8B5CF6', '#fff'],
        ['#EC4899', '#fff'], ['#14B8A6', '#fff'], ['#F97316', '#fff']
      ];
      const colorIdx = name.charCodeAt(0) % colors.length;
      const [bg, fg] = colors[colorIdx];
      return \`<span style="background:\${bg}; color:\${fg}; width:100%; height:100%; display:flex; align-items:center; justify-content:center; border-radius:12px;">\${escapeHtml(letter)}</span>\`;
    }

    async function loadToolActions(serviceId) {
      try {
        const res = await fetch(\`/api/connector/actions?service=\${encodeURIComponent(serviceId)}\`);
        if (!res.ok) return [];
        const json = await res.json();
        return json.data || [];
      } catch {
        return [];
      }
    }

    async function loadTools() {
      const container = document.getElementById('toolsContainer');
      
      try {
        const res = await fetch('/api/connector/tools');
        
        if (!res.ok) {
          throw new Error('Failed to load tools');
        }
        
        const json = await res.json();
        const tools = json.data || [];
        
        if (tools.length === 0) {
          const connectorRes = await fetch('/api/connector/onboarding');
          const connectorData = connectorRes.ok ? (await connectorRes.json()).data : {};
          const consoleUrl = connectorData.consoleUrl || '#';
          
          container.innerHTML = \`
            <div class="empty-state">
              <div class="empty-state-icon">🧰</div>
              <p>אין כלים מחוברים</p>
              <p style="font-size: 13px; margin-top: 8px;">
                <a href="\${escapeHtml(consoleUrl)}" target="_blank" class="external-link">פתח את הקונסול</a> כדי לחבר כלים חדשים
              </p>
            </div>
          \`;
          return;
        }
        
        const connectedTools = tools.map(t => ({
          id: t.id || t.serviceId,
          name: t.hebrewName || t.name || t.id || t.serviceId,
          description: t.hebrewDescription || t.description || '',
          icon: t.icon || '',
          identity: t.identity || null,
          virtual: t.virtual || false,
          authType: t.authType || '',
          enabled: t.enabled !== false
        }));
        
        function canDisconnect(tool) {
          return tool.virtual !== true && tool.authType !== 'no_auth';
        }
        
        const toolsWithActions = await Promise.all(
          connectedTools.map(async (tool) => {
            const actions = await loadToolActions(tool.id);
            return { ...tool, actions };
          })
        );
        
        const MAX_ACTIONS = 40;
        
        container.innerHTML = '<div class="tools-grid">' + toolsWithActions.map(tool => {
          const identityStr = tool.identity 
            ? (typeof tool.identity === 'string' ? tool.identity : tool.identity.label || tool.identity.email || '')
            : '';
          const displayActions = tool.actions.slice(0, MAX_ACTIONS);
          const moreCount = tool.actions.length - MAX_ACTIONS;
          const showDisconnect = canDisconnect(tool);
          const isRealTool = canDisconnect(tool);
          
          return \`
            <div class="tool-card\${tool.enabled ? '' : ' disabled'}">
              <div class="tool-card-header">
                <div class="tool-card-info">
                  <div class="tool-logo">\${getToolLogo(tool)}</div>
                  <div class="tool-card-details">
                    <div class="tool-card-name">\${escapeHtml(tool.name)}</div>
                    \${identityStr ? \`<div class="tool-card-identity">✓ \${escapeHtml(identityStr)}</div>\` : ''}
                  </div>
                </div>
                <div class="tool-card-controls">
                  \${isRealTool ? \`
                    <div class="tool-switch" role="switch" aria-checked="\${tool.enabled}" onclick="toggleToolEnabled('\${escapeHtml(tool.id)}', \${!tool.enabled})">
                      <div class="tool-switch-track\${tool.enabled ? ' enabled' : ''}">
                        <div class="tool-switch-thumb"></div>
                      </div>
                      <span class="tool-switch-label">\${tool.enabled ? 'מופעל' : 'כבוי'}</span>
                    </div>
                  \` : ''}
                  \${showDisconnect ? \`<button type="button" class="danger" onclick="disconnectTool('\${escapeHtml(tool.id)}', '\${escapeHtml(tool.name)}')">ניתוק</button>\` : ''}
                </div>
              </div>
              \${displayActions.length > 0 ? \`
                <div class="tool-card-actions-header">פעולות זמינות</div>
                <div class="action-chips">
                  \${displayActions.map(action => {
                    const actionEnabled = tool.enabled && (action.enabled !== false);
                    return \`
                      <div class="action-chip with-switch\${actionEnabled ? '' : ' disabled'}" title="\${escapeHtml(action.description || '')}">
                        <div class="action-chip-content">
                          <div class="action-chip-title">\${escapeHtml(humanizeAction(action))}</div>
                          \${action.description ? \`<div class="action-chip-desc">\${escapeHtml(action.description.slice(0, 60))}\${action.description.length > 60 ? '...' : ''}</div>\` : ''}
                        </div>
                        \${isRealTool ? \`
                          <div class="action-switch" role="switch" aria-checked="\${actionEnabled}" onclick="event.stopPropagation(); toggleActionEnabled('\${escapeHtml(tool.id)}', '\${escapeHtml(action.id)}', \${!action.enabled})" \${!tool.enabled ? 'style="pointer-events: none;"' : ''}>
                            <div class="action-switch-track\${actionEnabled ? ' enabled' : ''}">
                              <div class="action-switch-thumb"></div>
                            </div>
                            <span class="action-switch-label">\${actionEnabled ? 'מופעל' : 'כבוי'}</span>
                          </div>
                        \` : ''}
                      </div>
                    \`;
                  }).join('')}
                  \${moreCount > 0 ? \`<div class="action-chip action-more">+\${moreCount} נוספות</div>\` : ''}
                </div>
              \` : ''}
            </div>
          \`;
        }).join('') + '</div>';
      } catch (err) {
        container.innerHTML = \`
          <div class="empty-state">
            <div class="empty-state-icon">⚠️</div>
            <p style="color: var(--error);">שגיאה בטעינת כלים</p>
            <button type="button" class="secondary" style="margin-top: 12px;" onclick="loadTools()">נסה שוב</button>
          </div>
        \`;
      }
    }

    async function disconnectTool(serviceId, serviceName) {
      if (!confirm(\`האם לנתק את \${serviceName}?\`)) return;
      
      try {
        const res = await fetch(\`/api/connector/services/\${encodeURIComponent(serviceId)}\`, {
          method: 'DELETE'
        });
        
        const json = await res.json();
        
        if (json.success || res.ok) {
          showToast('הכלי נותק בהצלחה');
          loadTools();
        } else {
          showToast(json.error || json.message || 'שגיאה בניתוק הכלי', 'error');
        }
      } catch (err) {
        showToast('שגיאה בניתוק הכלי', 'error');
      }
    }

    async function toggleToolEnabled(serviceId, enabled) {
      try {
        const res = await fetch(\`/api/connector/tools/\${encodeURIComponent(serviceId)}/enabled\`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled })
        });
        
        const json = await res.json();
        
        if (json.success) {
          showToast(enabled ? 'הכלי הופעל' : 'הכלי כובה');
          loadTools();
        } else {
          showToast(json.error || 'שגיאה בעדכון מצב הכלי', 'error');
        }
      } catch (err) {
        showToast('שגיאה בעדכון מצב הכלי', 'error');
      }
    }

    async function toggleActionEnabled(serviceId, actionId, enabled) {
      try {
        const res = await fetch(\`/api/connector/tools/\${encodeURIComponent(serviceId)}/actions/\${encodeURIComponent(actionId)}/enabled\`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled })
        });
        
        const json = await res.json();
        
        if (json.success) {
          showToast(enabled ? 'הפעולה הופעלה' : 'הפעולה כובתה');
          loadTools();
        } else {
          showToast(json.error || 'שגיאה בעדכון מצב הפעולה', 'error');
        }
      } catch (err) {
        showToast('שגיאה בעדכון מצב הפעולה', 'error');
      }
    }

    loadProviders();
    loadTools();
  </script>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
