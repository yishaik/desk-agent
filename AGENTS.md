# Repository Guidelines

## Architecture

Desk Agent is a personal WhatsApp agent template for SMBs. It connects to Open Connector for SaaS integrations.

```
src/
├── core/           # Config, types, settings, memory
├── whatsapp/       # Baileys client, message handling
├── http/           # Express-like HTTP server, Web UI
├── open-connector/ # Open Connector API client
└── skills/         # Skill definitions and handlers

skills-pack/        # Pre-built skill configurations
data/              # Runtime data (gitignored)
```

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

The WhatsApp client only processes messages from the owner (messages to yourself). This is enforced in `src/whatsapp/client.ts`.

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

### New Skill Pack

Create `skills-pack/your-skill.json`:

```json
{
  "id": "your-skill",
  "name": "Your Skill",
  "description": "...",
  "requiredServices": ["service1"],
  "actions": ["service1.action"],
  "prompts": {},
  "confirmationRequired": []
}
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
