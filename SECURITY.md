# Security Model

Desk Agent is designed for single-tenant deployments where one business owner operates their own agent stack. This document explains what is isolated, what a leaked token can do, and how to rotate credentials.

## Threat Model

### What We Protect Against

1. **Unauthorized access to the agent** - PAIR_TOKEN gates all Web UI and API access
2. **Message eavesdropping** - Only processes messages from the owner's WhatsApp (self-chat only)
3. **Credential exposure to AI** - Open Connector holds secrets; agent only sees action results
4. **Cross-customer data leaks** - One Docker stack per customer, no shared state

### What We Don't Protect Against

1. **Compromised host machine** - If the server is compromised, all data is at risk
2. **Leaked PAIR_TOKEN with network access** - Attacker can access the Web UI
3. **WhatsApp account compromise** - If someone has your WhatsApp, they can message as you
4. **Model provider data retention** - Messages are sent to the model API

## Security Boundaries

### Per-Customer Isolation

Each customer gets their own:
- Docker Compose stack (agent + Open Connector + Caddy)
- SQLite database files
- WhatsApp session
- Open Connector instance
- Network namespace

There is no shared database or multi-tenant architecture. A compromise of one customer's stack does not affect others.

### Owner-Only Message Gate (Self-Chat)

The WhatsApp client only processes messages that are:
1. Sent by the owner to themselves (messages to yourself / self-chat)
2. From the phone number that paired the WhatsApp session

**The agent never responds to messages from other people.** Group messages are ignored. Direct messages from others are ignored. The agent only activates when you message yourself.

### Open Connector Credential Boundary

```
┌─────────────────────────────────────────────────────┐
│                    Desk Agent                        │
│                                                      │
│   ❌ Never sees: OAuth tokens, API keys, passwords  │
│   ✅ Only sees: Action metadata, execution results   │
└─────────────────────┬───────────────────────────────┘
                      │ Runtime Token
                      ▼
┌─────────────────────────────────────────────────────┐
│                 Open Connector                       │
│                                                      │
│   ✅ Stores: OAuth tokens, API keys (encrypted)     │
│   ✅ Enforces: Allow/block policies, scopes         │
│   ✅ Logs: All action executions (redacted)         │
└─────────────────────────────────────────────────────┘
```

The AI model never receives raw credentials. When the agent calls `gmail.send_email`, it sends:
- Action ID
- Input parameters (to, subject, body)

Open Connector adds the authentication and executes the action.

## Token Security

### PAIR_TOKEN

**What it protects:** Web UI access, API endpoints

**What a leaked token can do:**
- Access the Web UI
- View settings (not credential values)
- Change settings
- See WhatsApp pairing status
- Manage projects and per-project tokens

**What it cannot do:**
- Access Open Connector credentials directly
- Read WhatsApp messages (no message history API exposed)
- Send WhatsApp messages (no send API in Web UI)

**How to rotate:**
1. Generate a new token: `openssl rand -hex 32`
2. Update `.env` with new `PAIR_TOKEN`
3. Restart the agent: `docker compose restart agent`
4. Old sessions are invalidated (cookie-based auth)

### OPEN_CONNECTOR_TOKEN

**What it protects:** Runtime API access to Open Connector

**What a leaked token can do:**
- Execute any action allowed by the token's policy
- List connected services
- See connection identities (not credentials)

**What it cannot do:**
- Access raw credentials
- Modify OAuth apps or admin settings (requires ADMIN_TOKEN)
- Bypass allow/block action policies

**How to rotate:**
1. Open Connector Web Console → Access → Create new token
2. Delete the old token
3. Update `.env` with new `OPEN_CONNECTOR_TOKEN`
4. Restart: `docker compose restart agent`

### Admin Token (Optional — Operators Only)

`CONNECTOR_ADMIN_TOKEN` is an optional credential for accessing the Open Connector console at `https://console.{DOMAIN}`. Operators set it in `.env` before deployment if they need the console for additional integrations beyond Gmail/Calendar.

This token is **not** part of the customer first-run wizard. Gmail and Calendar connect directly from Settings without the console. The admin token is for operators who need to configure extra tools or manage OAuth apps.

### CONNECTOR_ENCRYPTION_KEY

**What it protects:** Encrypted credentials in Open Connector's database

**If leaked:** Attacker with database access could decrypt stored credentials

**How to rotate:**
1. Set `OOMOL_CONNECT_NEW_ENCRYPTION_KEY` to a new key
2. Run: `docker compose exec connector npm run runtime:data rotate-key`
3. Move the new key to `OOMOL_CONNECT_ENCRYPTION_KEY`
4. Remove `OOMOL_CONNECT_NEW_ENCRYPTION_KEY`
5. Restart: `docker compose restart connector`

## AI Provider OAuth Security

AI provider login uses OAuth in the browser:
- User clicks Connect in Settings
- Browser popup opens to provider (OpenAI or Anthropic)
- User authorizes access
- Callback returns to the agent
- Pi session is created with the provider credentials

If the OAuth session expires, Settings shows a reconnect prompt. The credentials are managed by the Pi runtime, not stored in plain text.

## Service OAuth Security (Gmail, Calendar)

Gmail and Google Calendar connect via OAuth from the Settings page:
- User clicks the Connect button next to Gmail or Google Calendar
- Browser popup opens to Google OAuth consent screen
- User authorizes access with their Google account
- Callback returns to the agent; tokens are stored in Open Connector (encrypted)

The agent never sees raw Google credentials — only action metadata and execution results. If the OAuth session expires, Settings shows a reconnect prompt.

## WhatsApp Session Security

### Session Storage

The WhatsApp session is stored in `data/whatsapp-auth/`. This contains:
- Session keys
- Device registration
- Encryption keys for the WhatsApp E2E protocol

### Graceful Disconnect on Restart

When the agent restarts, it calls `socket.end()` (not `logout`). This preserves the WhatsApp pairing. The session reconnects automatically on next start.

### 515 Error Handling

If a 515 error occurs after QR scan, the system reconnects with existing credentials rather than wiping the session.

### Rotating the Session

To invalidate the current WhatsApp session:

1. **From WhatsApp app:**
   Settings → Linked Devices → Remove this device

2. **From the server:**
   ```bash
   docker compose stop agent
   rm -rf data/whatsapp-auth/
   docker compose start agent
   # Re-pair with QR code
   ```

### Session Compromise

If you suspect session compromise:
1. Immediately unlink from WhatsApp app
2. Delete session files on server
3. Check WhatsApp's "Linked Devices" for unknown sessions
4. Re-pair with a new QR code

## Network Security

### HTTPS

In production, always use HTTPS:
- Caddy provides automatic Let's Encrypt certificates
- Set `DOMAIN` environment variable
- Never expose the agent on port 80 without HTTPS in production

### Caddy Routing

Caddy routes:
- `/*` → `agent:3001`
- `/oauth/*` → `connector:3000` (for OAuth callbacks)

Set `CONNECTOR_ORIGIN` to the public HTTPS URL so OAuth callbacks work correctly.

### Binding Address

- Development: Binds to `127.0.0.1` (localhost only)
- Production: Binds to `0.0.0.0` but should be behind Caddy

Never expose the agent port directly to the internet without the Caddy reverse proxy.

### Firewall Recommendations

```bash
# Only allow HTTP/HTTPS through Caddy
ufw allow 80/tcp
ufw allow 443/tcp

# Block direct access to internal ports
ufw deny 3001/tcp  # Agent
ufw deny 3000/tcp  # Open Connector

ufw enable
```

## Action Policies

Open Connector supports allow/block lists for actions:

```bash
# Allow only specific actions
CONNECTOR_ALLOWED_ACTIONS=gmail.list_messages,gmail.get_message,google-calendar.*

# Block dangerous actions
CONNECTOR_BLOCKED_ACTIONS=gmail.delete_message,notion.delete_*
```

Block policies take precedence over allow policies.

### Recommended Blocks for Sensitive Deployments

```bash
CONNECTOR_BLOCKED_ACTIONS=*.delete_*,*.remove_*,gmail.send_email,slack.post_message
```

Then explicitly allow sending through the agent's confirmation flow.

## Confirmation Gates

Every action that is not read-only requires the owner's approval in WhatsApp before it runs. The gate is an **allow-list**: only actions whose leading verb is read-only (`get`, `list`, `search`, `fetch`, `retrieve`, `query`, `find`, `describe`, `read`, `lookup`, `count`, `check`, …) run immediately. Anything else — send, reply, create, update, delete, move, trash, modify, schedule, upload, and verbs the agent has never seen — is held until the owner replies "yes".

Per-action overrides are stored in `settings.json` (`services[].confirmationOverrides`) and set through
`PATCH /api/connector/tools/:service/actions/:action/confirmation` with `{"mode": "always" | "never" | "auto"}`.
`GET /api/connector/actions` reports the effective gate for every action.

This is enforced in the tool implementations and the message handler, not just the prompts: the model has no parameter through which it can approve an action, and a confirmed action is executed by the handler outside the model's turn.

## Logging and Audit

### Agent Logs

```bash
docker compose logs -f agent
```

Logs include:
- Message processing (first 50 characters of message content at `info` level)
- API requests
- Errors

**Note:** Message content is partially logged for debugging. To disable, set `LOG_LEVEL=warn` or above.

### Open Connector Audit

Open Connector maintains action execution logs:
- Action ID and timestamp
- Input parameters (redacted)
- Success/failure status
- Execution ID for tracing

Access via: Open Connector Web Console → Runs

## Incident Response

### Suspected Compromise

1. **Immediate:** Unlink WhatsApp session from phone
2. **Rotate:** All tokens (PAIR_TOKEN, OPEN_CONNECTOR_TOKEN)
3. **Review:** Open Connector action logs for unauthorized activity
4. **Revoke:** OAuth connections in Open Connector
5. **Investigate:** Server access logs

### Data Breach

If the server is compromised:
1. Stop all containers: `docker compose down`
2. Rotate encryption key (see above)
3. Revoke all OAuth connections
4. Re-authorize with new credentials
5. Consider server wipe and fresh deployment

## Security Checklist

Before going live:

- [ ] Strong PAIR_TOKEN (32+ random bytes)
- [ ] HTTPS enabled with valid certificate
- [ ] Firewall blocks internal ports
- [ ] (Optional) CONNECTOR_ADMIN_TOKEN set if using the Open Connector console at https://console.{DOMAIN}
- [ ] Encryption key is set and backed up securely
- [ ] Action allow/block policies configured
- [ ] WhatsApp session working (test message to yourself)
- [ ] AI provider connected via OAuth
- [ ] Logs are being written and monitored

## Reporting Security Issues

For security vulnerabilities, please email directly rather than opening a public issue.
