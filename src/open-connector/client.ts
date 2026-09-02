import { createChildLogger } from '../core/logger.ts';
import { config } from '../core/config.ts';
import { loadSettings, getActiveConnectorToken } from '../core/settings.ts';

const log = createChildLogger('open-connector');

const ID_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,127}$/i;
const DEFAULT_TIMEOUT_MS = 15_000;

function validateId(id: string, label: string): void {
  if (!ID_PATTERN.test(id)) {
    throw new Error(`invalid ${label}`);
  }
}

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
    options: RequestInit = {},
    timeoutMs: number = DEFAULT_TIMEOUT_MS
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
      signal: AbortSignal.timeout(timeoutMs),
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
    // /v1/providers responds {success, data: [{service, displayName, authTypes, scenario, ...}]}
    const response = await this.request<
      Provider[] | { success: boolean; data: Array<Record<string, unknown>> }
    >('/v1/providers');
    const items = Array.isArray(response) ? response : (response.data ?? []);
    return (items as Array<Record<string, unknown>>).map((p) => ({
      id: (p['service'] ?? p['id']) as string,
      displayName: (p['displayName'] ?? p['service']) as string,
      description: (p['scenario'] ?? p['description']) as string | undefined,
      authTypes: (p['authTypes'] as string[] | undefined) ?? [],
    }));
  }

  async getProvider(serviceId: string): Promise<Provider | null> {
    validateId(serviceId, 'service id');
    try {
      const response = await this.request<{ success: boolean; data: Provider }>(
        `/v1/apps/services/${encodeURIComponent(serviceId)}`
      );
      return response.data;
    } catch {
      return null;
    }
  }

  async listConnections(): Promise<Connection[]> {
    const response = await this.request<
      Connection[] | { success?: boolean; data?: Connection[]; connections?: Connection[] }
    >('/api/connections');
    const items = Array.isArray(response)
      ? response
      : (response.data ?? response.connections ?? []);
    // The server exposes account info as `profile`, not `identity` — normalize
    // so callers can show "connected as x@gmail.com".
    return items.map((c) => {
      const raw = c as Connection & { profile?: { displayName?: string; accountId?: string } };
      const label = raw.profile?.displayName ?? raw.profile?.accountId;
      return {
        ...raw,
        identity: raw.identity ?? (label ? { label, email: raw.profile?.accountId } : undefined),
      };
    });
  }

  async getAuthenticatedServices(services: string[]): Promise<string[]> {
    if (services.length === 0) return [];
    const query = services.map((s) => `service=${encodeURIComponent(s)}`).join('&');
    const response = await this.request<{ success: boolean; data: string[] }>(
      `/v1/apps/authenticated?${query}`
    );
    return response.data;
  }

  // The server serializes the action title as `name`; our Action type uses
  // `displayName`. Entries without an id (the bare {service} rows returned by
  // /v1/actions with no ?service=) are not actions and get filtered out.
  private normalizeAction(raw: Record<string, unknown>): Action {
    return {
      ...(raw as unknown as Action),
      displayName: (raw['displayName'] ?? raw['name'] ?? raw['id'] ?? '') as string,
    };
  }

  async listActions(serviceId?: string): Promise<Action[]> {
    if (serviceId) {
      validateId(serviceId, 'service id');
    }
    const path = serviceId ? `/v1/actions?service=${encodeURIComponent(serviceId)}` : '/v1/actions';
    const response = await this.request<Action[] | { success: boolean; data: Action[] }>(path);
    const items = Array.isArray(response) ? response : response.data;
    return (items as unknown as Array<Record<string, unknown>>)
      .filter((a) => a['id'])
      .map((a) => this.normalizeAction(a));
  }

  async getAction(actionId: string): Promise<Action | null> {
    validateId(actionId, 'action id');
    try {
      const response = await this.request<{ success: boolean; data: Action }>(
        `/v1/actions/${encodeURIComponent(actionId)}`
      );
      return response.data
        ? this.normalizeAction(response.data as unknown as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }

  async getActionGuide(actionId: string): Promise<string> {
    validateId(actionId, 'action id');
    // /api/* is admin scope on the connector — the runtime token gets a 401.
    // Use request() for consistent auth + timeout handling, but we need text, not JSON.
    const token = config.connectorAdminToken ?? this.getToken();
    const url = `${this.baseUrl}/api/actions/${encodeURIComponent(actionId)}/agent.md`;
    log.debug({ url, method: 'GET' }, 'API request');

    const response = await fetch(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`Failed to get action guide: ${response.status}`);
    }
    return response.text();
  }

  async executeAction(input: ActionInput): Promise<ActionResponse> {
    validateId(input.actionId, 'action id');
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
      `${this.baseUrl}/v1/actions/${encodeURIComponent(input.actionId)}`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ input: input.input }),
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
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
    return (response.data as unknown as Array<Record<string, unknown>>)
      .filter((a) => a['id'])
      .map((a) => this.normalizeAction(a));
  }

  async checkHealth(): Promise<boolean> {
    // GET /health on the docker-internal baseUrl (OPEN_CONNECTOR_URL, typically
    // http://connector:3000). No Authorization header — /health is public on the
    // connector. Do NOT use /v1/health (requires runtime token) or the public
    // domain (Caddy doesn't expose /v1/*).
    try {
      const response = await fetch(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async listConnectedApps(): Promise<ConnectedApp[]> {
    const response = await this.request<
      ConnectedApp[] | { success: boolean; data: ConnectedApp[] }
    >('/v1/apps');
    return Array.isArray(response) ? response : (response.data ?? []);
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
    validateId(service, 'service id');
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
