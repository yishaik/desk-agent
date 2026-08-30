# Desk Agent Dockerfile
# Personal WhatsApp agent for SMB

FROM node:22-slim

# Install dependencies for Baileys (WhatsApp)
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    wget \
    util-linux \
    && rm -rf /var/lib/apt/lists/*

# Claude Code engine: the unmodified official binary; customers sign in with
# their own subscription (see src/agent/claude-code.ts for the compliance note)
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy source code
COPY src/ ./src/
COPY tsconfig.json ./

# Copy Pi skills directory if present
COPY .pi/ ./.pi/

# Copy skills-pack for resource loading
COPY skills-pack/ ./skills-pack/

# Create data directory with proper structure
RUN mkdir -p /app/data/pi-agent

# Set environment
# Claude Code must not self-update inside the container — versions are pinned
# by image builds, keeping the login TUI driver behavior predictable.
ENV DISABLE_AUTOUPDATER=1
ENV NODE_ENV=production
ENV DATA_DIR=/app/data
ENV HOST=0.0.0.0
ENV PORT=3001

# Expose port
EXPOSE 3001

# Health check using wget (curl not available in node:slim)
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD wget -q -O /dev/null http://localhost:3001/health || exit 1

# Run the agent
CMD ["node", "--experimental-strip-types", "src/index.ts"]
