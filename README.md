# Desk Agent

Personal WhatsApp agent for SMBs. One isolated Docker stack per customer: agent + Open Connector + Caddy.

**Two AI engines:**
- **Claude Code (recommended)** — the unmodified official `claude` binary running headless. The customer signs in with their own Claude Pro/Max subscription, so usage draws on their **plan limits** (this is the only Anthropic-compliant way to do that; third-party OAuth is billed from extra usage per token and violates their ToS — see [legal & compliance](https://code.claude.com/docs/en/legal-and-compliance)). Tools are provided via a stdio MCP server wrapping Open Connector.
- **[Pi Coding Agent](https://github.com/earendil-works/pi)** — used for the ChatGPT (Codex OAuth) path.

## What You Get

- **WhatsApp agent** responding only to messages you send to yourself (self-chat)
- **Browser-based setup** with QR pairing, AI provider OAuth, and identity configuration
- **Open Connector integration** for SaaS tools (Gmail, Calendar, Notion, and 1000+ more)
- **Settings dashboard** to manage identity, AI login, services, and WhatsApp connection
- **Docker Compose stack** with automatic HTTPS via Caddy

## First-Run Setup

After `docker compose up`, the Web UI guides you through:

1. **WhatsApp Pairing** - Scan QR code with your phone (Settings → Linked Devices → Link a Device)
2. **AI Provider Login** - Connect **Claude (subscription — recommended)**: authorize in the browser, copy the code Claude shows, paste it in the wizard. Or connect ChatGPT via OAuth.
3. **Identity Setup** - Enter your name, business name, and timezone (writes SOUL.md and AGENTS.md)
4. **Open Connector** - Health check and connection status
5. **Admin Token** - Shown once, save it securely, then acknowledge (never shown again)

After onboarding, the **Settings** page lets you:
- Review and edit identity (name, business, timezone)
- Reconnect ChatGPT or Claude if needed
- **Connect Gmail and Google Calendar** via the Connect buttons (OAuth popup)
- Check WhatsApp status and re-pair if disconnected

For other integrations or advanced configuration, operators can use the Open Connector console at `https://console.your-domain.com` (optional, extra tools).

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                    Your Phone                        │
│                  (WhatsApp App)                      │
└─────────────────────┬───────────────────────────────┘
                      │ WhatsApp Web Protocol (Baileys)
                      ▼
┌─────────────────────────────────────────────────────┐
│                    Caddy                             │
│            (HTTPS + Reverse Proxy)                   │
│     :443 → agent:3001 | /oauth/* → connector:3000   │
└─────────────────────┬───────────────────────────────┘
                      │
    ┌─────────────────┼─────────────────┐
    ▼                 ▼                 ▼
┌─────────────┐ ┌─────────────┐ ┌─────────────────────┐
│   Agent     │ │  Open       │ │   SQLite            │
│   :3001     │ │  Connector  │ │   (Memory)          │
│             │ │  :3000      │ │                     │
│  Pi Runtime │ │             │ │  settings.json      │
│  WebSocket  │ │  OAuth      │ │  whatsapp-auth/     │
│  WhatsApp   │ │  Credentials│ │                     │
└─────────────┘ └─────────────┘ └─────────────────────┘
```

**One stack per customer** - Each business gets isolated Docker Compose deployment. No shared database, no multi-tenant risks.

## WhatsApp Features

- **Baileys** client with QR code pairing
- **LID Message-yourself** for sending (self-chat only)
- **Emoji reactions** to indicate processing status (reading → processing/thinking/tools → done/error)
- **Graceful disconnect** on restart (socket.end, not logout - preserves pairing)
- **515 error handling** after scan reconnects with existing creds (no wipe)

**Not implemented:**
- Quoted replies (parameter exists but unused)
- Composing/typing indicators
- Read receipts

## Web UI

The Web UI provides:

1. **Login** - Token-gated access (PAIR_TOKEN)
2. **Setup Wizard** - First-boot onboarding flow
3. **Dashboard** - Status overview
4. **Settings** - Identity, AI login, Open Connector, WhatsApp
5. **Tools** - Shows CONNECTED Open Connector services only (logo cards + human-readable actions). Empty state links to Settings for Gmail/Calendar Connect, or the OC console (`https://console.{DOMAIN}`) for other integrations.

Access the UI at `https://your-domain.com/?token=YOUR_PAIR_TOKEN`

## WhatsApp Commands

Send these to yourself in WhatsApp:

| Command | Description |
|---------|-------------|
| `/help` | Show available commands |
| `/status` | Check system status |
| `/project [name]` | Switch or create a project |
| `/projects` | List all projects |
| `/services` | List connected services |
| `/settings` | View current settings |
| `/model [name]` | Switch AI model |

## AI Provider Login

Two options, shown in the wizard and Settings:

1. **⭐ Claude — Pro/Max subscription (recommended).** Drives Claude Code's own
   interactive login: click Connect, authorize at claude.ai, copy the code
   shown, paste it back. Credentials are stored by the `claude` binary inside
   the customer's stack; usage draws on their plan limits. When connected,
   this engine takes precedence.
2. **ChatGPT.** Device code flow via the Pi runtime — authorize in the browser,
   then paste the redirect URL from the address bar. Uses the ChatGPT subscription.

Neither flow requires an API key. If auth expires, Settings shows a reconnect
prompt. Switch Claude Code models with `/model claude-code/<name>` in WhatsApp.

## Configuration

All configuration is via environment variables. See `.env.example` for the full list.

### Required Variables

| Variable | Description |
|----------|-------------|
| `PAIR_TOKEN` | Access token for the Web UI (auto-generated on first run) |
| `OPEN_CONNECTOR_TOKEN` | Runtime token for Open Connector API |
| `CONNECTOR_ENCRYPTION_KEY` | Encryption key for stored credentials |

### Optional Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DOMAIN` | localhost | Your domain for HTTPS |
| `CONNECTOR_ORIGIN` | http://localhost:3000 | Public URL for OAuth callbacks |
| `LOG_LEVEL` | info | Logging verbosity |

## Deployment

### Recommended: Hetzner CX23

**Specs:** 2 vCPU / 4 GB RAM / 40 GB disk / IPv4 / ports 80+443

**Price:** ~€5.99/mo in Falkenstein (FSN) or Helsinki (HEL)

**Setup:**
1. Create CX23 with Ubuntu 22.04, add SSH key
2. Point two DNS A records to the VM's IPv4: `your-domain.com` and `console.your-domain.com`
3. SSH in, install Docker, clone repo, configure `.env`, run `docker compose up -d`

### Fallback Options (if CX23 sold out)

| Provider | Plan | Specs | Notes |
|----------|------|-------|-------|
| **OVH** | VPS-1 (2027) | 2 vCPU / 4 GB RAM | Good availability |
| **Netcup** | VPS 500 G12 | 2 vCPU / 4 GB RAM | Good pricing |
| **Kamatera** | Type A (TLV) | 2 vCPU / 4 GB RAM | Israel DC, higher price |

### Hard Requirements

- **4 GB RAM minimum** - Pi runtime needs memory headroom
- **IPv4 address** - WhatsApp Web requires IPv4
- **Ports 80 + 443** - Caddy needs both for HTTPS
- **Always-on** - WhatsApp session requires persistent connection
- **Docker Compose** - Stack orchestration

### Do NOT Use

- **1 GB RAM VPS** - Will OOM when Pi runs with WhatsApp
- **IPv6-only hosts** - WhatsApp Web connectivity issues
- **Serverless/sleep platforms** - Fly.io sleep, Cloudflare Workers, Lambda (WhatsApp needs persistent socket)
- **Ephemeral disk** - Session data must persist across restarts
- **Oracle Always Free** - Idle reclaim unpredictable, IPv4 allocation unreliable

### Caddy Configuration

Caddy handles TLS and routing:

| Domain | Path | Auth | Target | Notes |
|--------|------|------|--------|-------|
| `{$CONSOLE_DOMAIN}` | `/*` | OC admin-token login | `connector:3000` | Open Connector console (whole origin) |
| `{$DOMAIN}` | `/oauth/*` | Public | `connector:3000` | OAuth redirect target |
| `{$DOMAIN}` | `/*` | PAIR_TOKEN cookie | `agent:3001` | Agent wizard / settings / API |

**Security:**
- The console SPA uses absolute paths and a router without a base path, so it must own its host — it cannot be served under `/connector/` on the agent's origin (#72)
- On `{$DOMAIN}` nothing but the OAuth callback reaches the connector: `/v1/*`, `/mcp`, `/api/files/*`, `/api/runs*`, `/openapi.json` stay internal
- Agent-to-connector traffic uses the internal Docker network (`http://connector:3000`)

**Console URL:** `https://console.your-domain.com` (log in with the admin token the wizard shows once). Override the host with `CONSOLE_DOMAIN` / the link with `CONSOLE_URL`.

Set `CONNECTOR_ORIGIN=https://your-domain.com` so OAuth callbacks land on the agent's domain.

### Production Tips

- **Pre-build images** for faster deploys
- **Set `mem_limit`** on Pi container to prevent OOM killing WhatsApp
- **Use healthcheck restarts** for automatic recovery

### Version Pinning

Both Claude Code and Open Connector are pinned to tested versions to prevent
overnight breakage when dependencies release incompatible changes:

- **Claude Code**: `CLAUDE_CODE_VERSION` ARG in Dockerfile (currently `2.1.258`)
- **Open Connector**: Git SHA in docker-compose.yml (currently `6788fec...`)

Bump these after verifying compatibility — the TUI login driver depends on
Claude Code's prompt strings and the agent depends on Open Connector's response
schemas.

## Security

See [SECURITY.md](SECURITY.md) for the threat model.

Key points:
- Messages only processed from your own WhatsApp (self-chat)
- Web UI requires PAIR_TOKEN authentication
- Credentials stay in Open Connector, never sent to the AI model
- One stack per customer for isolation

## Skill Packs

Reference configurations for common tasks. See `skills-pack/` directory:

- **inbox-calendar** - Email and calendar management
- **light-crm** - Contact tracking and follow-ups
- **storefront-faq** - Answer business questions

Pick packs in **Settings → סקילים** (`settings.skillPacks`, default `inbox-calendar`). Selected packs are loaded by both engines: Pi via its skill loader, Claude Code via the system prompt. Add a pack by creating `skills-pack/<id>/SKILL.md` with `name`/`description` frontmatter.

## License

MIT License. See [LICENSE](LICENSE).

Open Connector is Apache 2.0 licensed.

## Support

- Issues: GitHub Issues
- Questions: Open a Discussion

---

Built with [Baileys](https://github.com/WhiskeySockets/Baileys) and [Open Connector](https://github.com/oomol-lab/open-connector).
