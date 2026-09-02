import { getWhatsAppClient } from './whatsapp/client.ts';
import { handleMessage } from './whatsapp/handler.ts';
import { startServer } from './http/server.ts';
import { createChildLogger } from './core/logger.ts';
import { closeDatabase, pruneMessages } from './core/memory.ts';

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

  // Bounded message log: prune at startup and once a day (#79).
  try {
    pruneMessages();
  } catch (err) {
    log.warn({ err }, 'Message prune at startup failed');
  }
  const pruneTimer = setInterval(() => {
    try {
      pruneMessages();
    } catch (err) {
      log.warn({ err }, 'Scheduled message prune failed');
    }
  }, 24 * 60 * 60 * 1000);
  pruneTimer.unref();

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
