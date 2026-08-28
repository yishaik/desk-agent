# 🤖 Desk Agent

Personal WhatsApp agent template for one SMB. Pair, connect tools, one gated stack per customer.

**Built on [Pi Coding Agent](https://github.com/earendil-works/pi)** - a minimal terminal coding harness with extensions, skills, and tools.

**10 minutes to a working agent:**
1. `docker compose up`
2. Open the URL, enter your pair token
3. Scan QR with WhatsApp
4. Log in to your AI provider: `pi /login` (or set `MODEL_API_KEY`)
5. Connect your services in Open Connector
6. Message yourself to talk to your agent

## What You Get

- **WhatsApp agent** that only responds to messages you send to yourself
- **Pi runtime** with sessions, skills, extensions, and tool execution
- **Open Connector tools** - search, get guides, execute actions (with confirmation)
- **Web UI** for pairing, settings, and service connections
- **Per-project API keys** for isolating different business contexts with separate tokens
- **Docker Compose stack** (one stack per customer) with automatic HTTPS via Caddy

## Quick Start

### Prerequisites

- Node.js 22+ (for local development)
- Docker and Docker Compose (for deployment)
- An Anthropic API key (or other model provider)
- A domain with DNS (for production HTTPS)

### Local Development

```bash
# Install dependencies
npm install

# Log in to your AI provider (Claude, OpenAI, etc.)
# Option A: Use your subscription
npx pi /login

# Option B: Use API key
export MODEL_API_KEY=sk-ant-...

# Start the agent (generates PAIR_TOKEN on first run)
npm run dev

# Open the URL shown in the terminal
# Scan QR code with WhatsApp
```

### Docker Deployment

```bash
# Copy and configure environment
cp .env.example .env
# Edit .env with your tokens and domain

# Start the stack
docker compose up -d

# View logs
docker compose logs -f agent
```

## Configuration

All configuration is via environment variables. See `.env.example` for the full list.

### Required Variables

| Variable | Description |
|----------|-------------|
| `PAIR_TOKEN` | Access token for the Web UI (auto-generated if not set) |
| `MODEL_API_KEY` | Your AI model API key (Anthropic recommended) |
| `OPEN_CONNECTOR_TOKEN` | Runtime token for Open Connector API |
| `CONNECTOR_ENCRYPTION_KEY` | Encryption key for stored credentials |

### Optional Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DOMAIN` | localhost | Your domain for HTTPS |
| `MODEL_API_URL` | Anthropic | API endpoint for the model |
| `LOG_LEVEL` | info | Logging verbosity |

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                    Your Phone                        │
│                  (WhatsApp App)                      │
└─────────────────────┬───────────────────────────────┘
                      │ WhatsApp Web Protocol
                      ▼
┌─────────────────────────────────────────────────────┐
│              Desk Agent (this repo)                  │
│                                                      │
│  ┌─────────────────────────────────────────────┐    │
│  │             Pi Coding Agent                  │    │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  │    │
│  │  │ Sessions │  │  Skills  │  │Extensions│  │    │
│  │  │ /project │  │.pi/skills│  │  Tools   │  │    │
│  │  └──────────┘  └──────────┘  └──────────┘  │    │
│  └─────────────────────┬───────────────────────┘    │
│                        │                             │
│  ┌─────────────┐  ┌────┴────┐  ┌─────────────┐     │
│  │  WhatsApp   │  │  HTTP   │  │   Memory    │     │
│  │   Client    │  │  + UI   │  │  (SQLite)   │     │
│  │  (Baileys)  │  │         │  │             │     │
│  └─────────────┘  └─────────┘  └─────────────┘     │
└─────────────────────┬───────────────────────────────┘
                      │ Open Connector Tools:
                      │ oc_search_actions
                      │ oc_get_action_guide
                      │ oc_execute_action
                      ▼
┌─────────────────────────────────────────────────────┐
│              Open Connector (fork)                   │
│         (Auth gateway for SaaS apps)                 │
│     github.com/yishaik/open-connector                │
│                                                      │
│   Gmail │ Calendar │ Notion │ Slack │ 1000+ more    │
└─────────────────────────────────────────────────────┘
```

**One stack per customer** - Each business gets their own isolated Docker Compose deployment. No shared database, no multi-tenant risks.

## Web UI

The Web UI provides:

1. **Login** - Token-gated access
2. **Setup Wizard** - First-boot flow for pairing and configuration
3. **Dashboard** - Status overview and quick actions
4. **Settings** - Bot name, timezone, model, API key mode
5. **Projects** - Manage multiple contexts with separate tokens
6. **Services** - View and manage Open Connector connections

Access the UI at `http://localhost:3001/?token=YOUR_PAIR_TOKEN`

## WhatsApp Commands

Send these to yourself in WhatsApp:

| Command | Description |
|---------|-------------|
| `/help` | Show available commands |
| `/status` | Check system status |
| `/project [name]` | Switch or create a project (creates new Pi session) |
| `/projects` | List all projects |
| `/mode [shared\|per-project]` | Change API key mode |
| `/services` | List connected services |
| `/settings` | View current settings |
| `/model [name]` | Switch AI model |
| `/login` | Instructions for AI provider login |

## Pi Integration

Desk Agent uses Pi as its AI runtime:

- **Sessions** - Each project gets a separate Pi session with history
- **Skills** - Add capabilities via `.pi/skills/` 
- **Extensions** - Custom tools via `.pi/extensions/`
- **Model switching** - Use `/model` or `pi /login` for provider login

### Logging In

Pi supports subscription logins (no API key needed):

```bash
# In the terminal where the agent runs
npx pi /login

# Then select:
# - Anthropic (Claude Pro/Max subscription)
# - OpenAI (ChatGPT Plus/Pro)
# - GitHub Copilot
# etc.
```

Or use API keys:
```bash
export MODEL_API_KEY=sk-ant-...
export MODEL_API_URL=https://api.anthropic.com/v1/messages  # optional
```

## API Key Modes

### Shared Mode (default)

One Open Connector token for all projects. Simple setup, shared permissions.

```
All projects → Single token → All connected services
```

### Per-Project Mode

Each project gets its own Open Connector token. Better isolation for different clients or use cases.

```
Project A → Token A → Client A's services
Project B → Token B → Client B's services
```

Set per-project tokens in the Web UI under Projects.

## Skill Packs

Pre-built configurations for common tasks. See `skills-pack/` directory:

- **inbox-calendar** - Email and calendar management
- **light-crm** - Contact tracking and follow-ups
- **storefront-faq** - Answer business questions

## Security

See [SECURITY.md](SECURITY.md) for the threat model and security practices.

Key points:
- Messages only processed from your own WhatsApp number
- Web UI requires PAIR_TOKEN authentication
- Credentials stay in Open Connector, never sent to the AI model
- One stack per customer for isolation

## Deployment Options

### Cheap VPS (Hetzner CX23 / OVH / Netcup)

**Recommended:** Hetzner CX23 (2 vCPU, 4GB RAM, IPv4) ~€5.99/mo in Falkenstein or Helsinki.

**Alternatives if sold out:**
- OVH VPS-1 (2027) - 2 vCPU, 4GB RAM
- Netcup VPS 500 G12 - 2 vCPU, 4GB RAM

> ⚠️ The stack needs 4GB RAM. Do not use 1GB VPS instances.

1. Provision a VM with Docker
2. Point your domain DNS to the VM
3. Copy files and `.env`
4. `docker compose up -d`

### Fly.io

```bash
# Create app
fly launch --no-deploy

# Set secrets
fly secrets set PAIR_TOKEN=... MODEL_API_KEY=...

# Deploy
fly deploy
```

### Self-Hosted (No Docker)

```bash
# Run Open Connector separately
# See: https://github.com/oomol-lab/open-connector

# Run the agent
npm install
npm start
```

## License

MIT License. See [LICENSE](LICENSE).

Open Connector is Apache 2.0 licensed.

## Contributing

Contributions welcome! Please read the codebase first and keep changes focused.

## Support

- Issues: GitHub Issues
- Questions: Open a Discussion
- Commercial support: Contact the author

---

Built with [Baileys](https://github.com/WhiskeySockets/Baileys) and [Open Connector](https://github.com/oomol-lab/open-connector).
