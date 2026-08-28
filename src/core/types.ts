export interface Settings {
  botName: string;
  ownerName: string;
  ownerPhone?: string;
  timezone: string;
  model: string;
  apiKeyMode: 'shared' | 'per-project';
  sharedConnectorToken?: string;
  projectTokens: Record<string, string>;
  activeProject: string;
  services: ServiceConfig[];
  setupComplete: boolean;
  createdAt: string;
  updatedAt: string;
  businessName?: string;
  businessDescription?: string;
  agentVoice?: string;
  agentBoundaries?: string;
  connectedProviders?: string[];
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
  botName: 'Desk Agent',
  ownerName: '',
  timezone: 'Asia/Jerusalem',
  model: 'claude-sonnet-4-5',
  apiKeyMode: 'shared',
  projectTokens: {},
  activeProject: 'default',
  services: [],
  setupComplete: false,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  businessName: '',
  businessDescription: '',
  agentVoice: '',
  agentBoundaries: '',
  connectedProviders: [],
};
