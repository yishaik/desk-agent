export interface Settings {
  botName: string;
  ownerName: string;
  ownerPhone?: string;
  businessName?: string;
  businessDescription?: string;
  agentVoice?: string;
  agentBoundaries?: string;
  timezone: string;
  model: string;
  apiKeyMode: 'shared' | 'per-project';
  sharedConnectorToken?: string;
  projectTokens: Record<string, string>;
  activeProject: string;
  services: ServiceConfig[];
  /** Selected skill packs (directory names under skills-pack/); see core/skills.ts. */
  skillPacks?: string[];
  setupComplete: boolean;
  connectorAdminTokenAcknowledged: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ServiceConfig {
  id: string;
  name: string;
  enabled: boolean;
  disabledActions?: string[];
  /** Per-action confirmation override: 'always' forces the gate, 'never' bypasses it (read-only-safe actions only). */
  confirmationOverrides?: Record<string, 'always' | 'never'>;
  connectedAt?: string;
}

export interface Project {
  id: string;
  name: string;
  description?: string;
  connectorToken?: string;
  createdAt: string;
}

export interface MessageKey {
  remoteJid: string;
  id: string;
  fromMe: boolean;
  participant?: string;
}

export interface Message {
  id: string;
  from: string;
  to: string;
  body: string;
  timestamp: number;
  isFromMe: boolean;
  projectId?: string;
  messageKey?: MessageKey;
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
  error?: string;
  /** How replies are addressed: the account's LID (preferred), the phone JID (fallback), or nothing yet. */
  selfChat?: 'lid' | 'phone' | 'none';
  /** Last pairing code from requestPairingCode, if any. */
  pairingCode?: string;
}

export const DEFAULT_SETTINGS: Settings = {
  botName: 'Desk Agent',
  ownerName: '',
  businessName: '',
  businessDescription: '',
  agentVoice: '',
  agentBoundaries: '',
  timezone: 'UTC',
  model: 'claude-3-5-sonnet-20241022',
  apiKeyMode: 'shared',
  projectTokens: {},
  activeProject: 'default',
  services: [],
  skillPacks: ['inbox-calendar'],
  setupComplete: false,
  connectorAdminTokenAcknowledged: false,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};
