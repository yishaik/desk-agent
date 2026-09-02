# Repository Guidelines

## Architecture

Desk Agent is a personal WhatsApp agent for SMBs built on the Pi Coding Agent runtime. It connects to Open Connector for SaaS integrations.

**One stack per customer** - Each deployment is an isolated Docker Compose stack (agent + Open Connector + Caddy) with no shared state between customers.

```
src/
├── core/           # Config, types, settings, memory
├── whatsapp/       # Baileys client, message handling (uses Pi sessions)
├── http/           # Express-like HTTP server, Web UI
├── agent/          # Pi session, OC tools (oc_search/guide/execute/list)
└── open-connector/ # Open Connector API client (token resolution)

.pi/
└── skills/         # Pi skills
    └── open-connector/  # OC skill documentation

skills-pack/        # Reference skill configurations (manual setup required)
data/              # Runtime data (gitignored)
```

**Note:** Open Connector tools (`oc_search_actions`, `oc_get_action_guide`, `oc_execute_action`, `oc_list_connections`) are defined inline in `src/agent/session.ts`, not as a Pi extension.

## Pi Integration

The handler uses Pi Coding Agent SDK for:
- **Sessions** - Each project gets a separate Pi session
- **Skills** - On-demand capabilities via `.pi/skills/`
- **Model runtime** - Multi-provider LLM support

Open Connector tools are registered directly in `src/agent/session.ts` as custom tools, not as Pi extensions.

### Customer AI Login

Customers log in via browser OAuth in the Web UI Settings page:
- Click Connect next to ChatGPT or Claude
- Authorize in browser popup
- Pi session is created with the provider default model

## Code Style

- TypeScript with strict mode
- Node.js 22+ with native TypeScript execution
- ES modules (`.ts` imports with explicit extension)
- Pino for logging
- SQLite via better-sqlite3 for persistence

### Naming

- Files: `kebab-case.ts`
- Functions: `camelCase`
- Types/Interfaces: `PascalCase`
- Constants: `UPPER_SNAKE_CASE` for env-like values

### Patterns

- Single responsibility per file
- Dependency injection through function parameters
- No barrel files (`index.ts` exports)
- Explicit return types on public functions

## Configuration

All configuration via environment variables. See `.env.example`.

Runtime settings stored in `data/settings.json`.

## Security

### Owner-Only Gate

The WhatsApp client only processes messages from the owner (messages to yourself / self-chat). This is enforced in `src/whatsapp/client.ts`. The agent never responds to messages from other people.

### Credential Boundary

Open Connector holds all SaaS credentials. The agent only sees:
- Action metadata
- Execution results

Never log or send credentials to the model.

### Token Security

- `PAIR_TOKEN`: Web UI access
- `OPEN_CONNECTOR_TOKEN`: API access to connector
- Per-project tokens: Optional isolation

## Development

```bash
npm install
npm run dev
```

### Testing

```bash
npm test
```

### Type Checking

```bash
npm run typecheck
```

## Adding Features

### New API Endpoint

Add to `src/http/server.ts`:

```typescript
addRoute('GET', '/api/new-thing', async (req, res) => {
  if (!isAuthenticated(req)) {
    sendError(res, 'Unauthorized', 401);
    return;
  }
  // Handler logic
  sendJson(res, { success: true, data: {} });
});
```

### New Command

Add to `src/whatsapp/handler.ts` in `handleCommand()`:

```typescript
case 'newcmd': {
  return {
    handled: true,
    response: 'Response here',
  };
}
```

### New Pi Extension

Create `.pi/extensions/my-extension/index.ts`:

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "my_tool",
    label: "My Tool",
    description: "Does something useful",
    parameters: Type.Object({
      input: Type.String({ description: "Input value" }),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return {
        content: [{ type: "text", text: `Result: ${params.input}` }],
        details: {},
      };
    },
  });
}
```

### New Pi Skill

Create `.pi/skills/my-skill/SKILL.md`:

```markdown
# My Skill

Use this skill when the user wants to do X.

## Steps
1. First step
2. Second step

## Examples
- User: "Do X"
- Response: Use my_tool with appropriate input
```

## Deployment

### Docker

```bash
docker compose up -d
```

### Manual

```bash
npm install
npm start
```

## Versioning

Follow semver. Update `package.json` version for releases.

## Pull Requests

- One feature per PR
- Include tests for new functionality
- Update README if adding user-facing features
- Update SECURITY.md if changing security model
