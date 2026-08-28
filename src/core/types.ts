export interface Settings {
  // Customer-facing settings (visible in first-run)
  ownerName: string;
  businessName: string;
  ownerPhone?: string;
  timezone: string;
  setupComplete: boolean;
  
  // Operator settings (hidden from first-run)
  botName: string;
  model: string;
  apiKeyMode: 'shared' | 'per-project';
  sharedConnectorToken?: string;
  projectTokens: Record<string, string>;
  activeProject: string;
  services: ServiceConfig[];
  
  createdAt: string;
  updatedAt: string;
}

export interface ServiceConfig {
  id: string;
  name: string;
  enabled: boolean;
  connectedAt?: string;
}

export interface Project {
  id: string;
  name: string;
  description?: string;
  connectorToken?: string;
  createdAt: string;
}

export interface Message {
  id: string;
  from: string;
  to: string;
  body: string;
  timestamp: number;
  isFromMe: boolean;
  projectId?: string;
}

export interface ConversationContext {
  projectId: string;
  messages: Message[];
  summary?: string;
}

export interface SkillDefinition {
  id: string;
  name: string;
  description: string;
  actions: string[];
  requiredServices: string[];
  prompts: Record<string, string>;
}

export interface ActionResult {
  success: boolean;
  data?: unknown;
  error?: string;
  actionId: string;
  executionId?: string;
}

export interface PairingState {
  isPaired: boolean;
  qrCode?: string;
  qrExpiry?: number;
  phoneNumber?: string;
  name?: string;
}

export const DEFAULT_SETTINGS: Settings = {
  // Customer-facing defaults
  ownerName: '',
  businessName: '',
  timezone: 'Asia/Jerusalem',
  setupComplete: false,
  
  // Operator defaults
  botName: 'Desk Agent',
  model: 'claude-3-5-sonnet-20241022',
  apiKeyMode: 'shared',
  projectTokens: {},
  activeProject: 'default',
  services: [],
  
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

export interface CustomerTool {
  id: string;
  hebrewName: string;
  hebrewDescription: string;
  icon: string;
  serviceId: string;
  isConnected: boolean;
  identity?: string;
}

export const CUSTOMER_TOOLS: Omit<CustomerTool, 'isConnected' | 'identity'>[] = [
  {
    id: 'gmail',
    hebrewName: 'Gmail',
    hebrewDescription: 'קריאה ומענה למיילים',
    icon: '✉️',
    serviceId: 'google-mail',
  },
  {
    id: 'calendar',
    hebrewName: 'יומן',
    hebrewDescription: 'ניהול פגישות ואירועים',
    icon: '📅',
    serviceId: 'google-calendar',
  },
  {
    id: 'contacts',
    hebrewName: 'אנשי קשר',
    hebrewDescription: 'ניהול פרטי לקוחות',
    icon: '👥',
    serviceId: 'google-contacts',
  },
  {
    id: 'notion',
    hebrewName: 'Notion',
    hebrewDescription: 'רשימות ומסמכים',
    icon: '📝',
    serviceId: 'notion',
  },
];
