import { createChildLogger } from '../core/logger.ts';
import { config } from '../core/config.ts';
import { loadSettings, getActiveConnectorToken } from '../core/settings.ts';

const log = createChildLogger('open-connector');

export interface ActionInput {
  actionId: string;
  input: Record<string, unknown>;
  connectionName?: string;
}

export interface ActionResponse {
  success: boolean;
  message: string;
  data?: unknown;
  meta?: {
    executionId?: string;
    actionId?: string;
  };
}

export interface Provider {
  id: string;
  displayName: string;
  description?: string;
  authTypes: string[];
  hasConnection?: boolean;
  connectionIdentity?: {
    label: string;
  };
}

export interface Connection {
  service: string;
  connectionName: string;
  authType: string;
  virtual?: boolean;
  identity?: {
    label: string;
    email?: string;
  };
}

export function isRealConnection(conn: Connection): boolean {
  return conn.virtual !== true && conn.authType !== 'no_auth';
}

export interface Action {
  id: string;
  service: string;
  displayName: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  requiredScopes?: string[];
}

export interface ConnectedApp {
  service: string;
  displayName: string;
  description?: string;
  authType: string;
  identity?: {
    label: string;
    email?: string;
  };
}

export interface OAuthStartResponse {
  authorizationUrl: string;
  state: string;
}

export class OpenConnectorClient {
  private baseUrl: string;
  private projectId?: string;

  constructor(projectId?: string) {
    this.baseUrl = config.openConnectorUrl;
    this.projectId = projectId;
  }

  private getToken(): string | undefined {
    const settings = loadSettings();
    return getActiveConnectorToken(settings, this.projectId);
  }

  private async request<T>(
    path: string,
    options: RequestInit = {}
  ): Promise<T> {
    // Console endpoints (/api/*) require the admin token; runtime endpoints
    // (/v1/*) take the runtime token.
    const token = path.startsWith('/api/')
      ? (config.connectorAdminToken ?? this.getToken())
      : this.getToken();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(options.headers as Record<string, string> | undefined),
    };

    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const url = `${this.baseUrl}${path}`;
    log.debug({ url, method: options.method ?? 'GET' }, 'API request');

    const response = await fetch(url, {
      ...options,
      headers,
    });

    if (!response.ok) {
      const errorText = await response.text();
      log.error(
        { status: response.status, url, error: errorText },
        'API request failed'
      );
      throw new Error(`Open Connector API error: ${response.status} - ${errorText}`);
    }

    return response.json() as Promise<T>;
  }

  async listProviders(): Promise<Provider[]> {
    const response = await this.request<Provider[]>('/v1/providers');
    return response;
  }

  async getProvider(serviceId: string): Promise<Provider | null> {
    try {
      const response = await this.request<{ success: boolean; data: Provider }>(
        `/v1/apps/services/${serviceId}`
      );
      return response.data;
    } catch {
      return null;
    }
  }

  async listConnections(): Promise<Connection[]> {
    const response = await this.request<Connection[]>('/api/connections');
    return response;
  }

  async getAuthenticatedServices(services: string[]): Promise<string[]> {
    if (services.length === 0) return [];
    const query = services.map((s) => `service=${encodeURIComponent(s)}`).join('&');
    const response = await this.request<{ success: boolean; data: string[] }>(
      `/v1/apps/authenticated?${query}`
    );
    return response.data;
  }

  async listActions(serviceId?: string): Promise<Action[]> {
    const path = serviceId ? `/v1/actions?service=${encodeURIComponent(serviceId)}` : '/v1/actions';
    const response = await this.request<Action[] | { success: boolean; data: Action[] }>(path);
    if (Array.isArray(response)) {
      return response;
    }
    return response.data;
  }

  async getAction(actionId: string): Promise<Action | null> {
    try {
      const response = await this.request<{ success: boolean; data: Action }>(
        `/v1/actions/${actionId}`
      );
      return response.data;
    } catch {
      return null;
    }
  }

  async getActionGuide(actionId: string): Promise<string> {
    const response = await fetch(
      `${this.baseUrl}/api/actions/${actionId}/agent.md`,
      {
        headers: this.getToken()
          ? { Authorization: `Bearer ${this.getToken()}` }
          : {},
      }
    );
    if (!response.ok) {
      throw new Error(`Failed to get action guide: ${response.status}`);
    }
    return response.text();
  }

  async executeAction(input: ActionInput): Promise<ActionResponse> {
    const token = this.getToken();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    if (input.connectionName) {
      headers['x-oo-connector-alias'] = input.connectionName;
    }

    const response = await fetch(
      `${this.baseUrl}/v1/actions/${input.actionId}`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ input: input.input }),
      }
    );

    const result = (await response.json()) as ActionResponse;

    if (!response.ok) {
      log.error(
        { actionId: input.actionId, status: response.status, result },
        'Action execution failed'
      );
    } else {
      log.info(
        { actionId: input.actionId, executionId: result.meta?.executionId },
        'Action executed'
      );
    }

    return result;
  }

  async searchActions(query: string): Promise<Action[]> {
    const response = await this.request<{ success: boolean; data: Action[] }>(
      `/v1/actions/search?q=${encodeURIComponent(query)}`
    );
    return response.data;
  }

  async checkHealth(): Promise<boolean> {
    try {
      await this.request('/v1/health');
      return true;
    } catch {
      return false;
    }
  }

  async listConnectedApps(): Promise<ConnectedApp[]> {
    const response = await this.request<ConnectedApp[]>('/v1/apps');
    return response;
  }

  async startOAuth(
    service: string,
    redirectUri?: string
  ): Promise<OAuthStartResponse> {
    const body: Record<string, unknown> = { service };
    if (redirectUri) {
      body.redirectUri = redirectUri;
    }
    const response = await this.request<OAuthStartResponse>(
      '/api/oauth/authorizations',
      {
        method: 'POST',
        body: JSON.stringify(body),
      }
    );
    return response;
  }

  async disconnectService(service: string, connectionName?: string): Promise<void> {
    const query = connectionName ? `?connectionName=${encodeURIComponent(connectionName)}` : '';
    await this.request<void>(`/api/connections/${encodeURIComponent(service)}${query}`, {
      method: 'DELETE',
    });
  }
}

export function createClient(projectId?: string): OpenConnectorClient {
  return new OpenConnectorClient(projectId);
}

export const defaultClient = new OpenConnectorClient();
