import { getWhatsAppClient } from './whatsapp/client.ts';
import { handleMessage } from './whatsapp/handler.ts';
import { startServer } from './http/server.ts';
import { createChildLogger } from './core/logger.ts';
import { config } from './core/config.ts';
import { closeDatabase } from './core/memory.ts';

const log = createChildLogger('main');

async function main(): Promise<void> {
  log.info({ version: '1.0.0' }, 'Starting Desk Agent');

  console.log(`
╔═══════════════════════════════════════════════╗
║           🤖 Desk Agent v1.0.0                ║
║   Personal WhatsApp agent for your business   ║
╚═══════════════════════════════════════════════╝
`);

  startServer();

  const wa = getWhatsAppClient();
  wa.onMessage(handleMessage);

  try {
    await wa.connect();
    log.info('WhatsApp client started');
  } catch (err) {
    log.error({ err }, 'Failed to start WhatsApp client');
  }

  process.on('SIGINT', async () => {
    log.info('Shutting down...');
    await wa.disconnect();
    closeDatabase();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    log.info('Shutting down...');
    await wa.disconnect();
    closeDatabase();
    process.exit(0);
  });
}

main().catch((err) => {
  log.error({ err }, 'Fatal error');
  process.exit(1);
});
