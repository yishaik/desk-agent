# Desk Agent

Personal WhatsApp agent for SMBs. One isolated Docker stack per customer: agent + Open Connector + Caddy.

**Built on [Pi Coding Agent](https://github.com/earendil-works/pi)** - AI runtime with sessions, skills, and extensions.

## What You Get

- **WhatsApp agent** responding only to messages you send to yourself (self-chat)
- **Browser-based setup** with QR pairing, AI provider OAuth, and identity configuration
- **Open Connector integration** for SaaS tools (Gmail, Calendar, Notion, and 1000+ more)
- **Settings dashboard** to manage identity, AI login, services, and WhatsApp connection
- **Docker Compose stack** with automatic HTTPS via Caddy

## First-Run Setup

After `docker compose up`, the Web UI guides you through:

1. **WhatsApp Pairing** - Scan QR code with your phone (Settings → Linked Devices → Link a Device)
2. **AI Provider Login** - Connect ChatGPT or Claude via browser OAuth (click Connect, authorize in popup, done)
3. **Identity Setup** - Enter your name, business name, and timezone (writes SOUL.md and AGENTS.md)
4. **Open Connector** - Health check and connection status
5. **Admin Token** - Shown once, save it securely, then acknowledge (never shown again)

After onboarding, the **Settings** page lets you:
- Review and edit identity (name, business, timezone)
- Reconnect ChatGPT or Claude if needed
- Manage Open Connector connections
- Check WhatsApp status and re-pair if disconnected

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
- **Quoted replies** when responding to specific messages
- **Composing/paused** indicators while AI is thinking
- **Read receipts** after processing
- **Graceful disconnect** on restart (socket.end, not logout - preserves pairing)
- **515 error handling** after scan reconnects with existing creds (no wipe)

## Web UI

The Web UI provides:

1. **Login** - Token-gated access (PAIR_TOKEN)
2. **Setup Wizard** - First-boot onboarding flow
3. **Dashboard** - Status overview
4. **Settings** - Identity, AI login, Open Connector, WhatsApp
5. **Tools** - Shows CONNECTED Open Connector services only (logo cards + human-readable actions). Empty state links to OC console.

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

Login happens in the browser via OAuth:

1. Open **Settings** in the Web UI
2. Click **Connect** next to ChatGPT or Claude
3. Authorize in the popup window
4. Paste callback URL if popup was blocked (fallback only)

After OAuth, the model is set to the provider default:
- **OpenAI:** `openai-codex/gpt-5.5`
- **Anthropic:** `anthropic/claude-sonnet-4-6`

If OAuth expires, Settings shows a reconnect prompt.

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
2. Point DNS A record to the VM's IPv4
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
- `https://your-domain.com/*` → `agent:3001`
- `https://your-domain.com/oauth/*` → `connector:3000`

Set `CONNECTOR_ORIGIN=https://your-domain.com` so OAuth callbacks route correctly.

### Production Tips

- **Pre-build images** for faster deploys
- **Set `mem_limit`** on Pi container to prevent OOM killing WhatsApp
- **Use healthcheck restarts** for automatic recovery

## Security

See [SECURITY.md](SECURITY.md) for the threat model.

Key points:
- Messages only processed from your own WhatsApp (self-chat)
- Web UI requires PAIR_TOKEN authentication
- Credentials stay in Open Connector, never sent to the AI model
- One stack per customer for isolation

## Skill Packs

Pre-built configurations for common tasks. See `skills-pack/` directory:

- **inbox-calendar** - Email and calendar management
- **light-crm** - Contact tracking and follow-ups
- **storefront-faq** - Answer business questions

## License

MIT License. See [LICENSE](LICENSE).

Open Connector is Apache 2.0 licensed.

## Support

- Issues: GitHub Issues
- Questions: Open a Discussion

---

Built with [Baileys](https://github.com/WhiskeySockets/Baileys) and [Open Connector](https://github.com/oomol-lab/open-connector).
