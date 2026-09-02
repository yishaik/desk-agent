import pino from 'pino';
import { config } from './config.ts';

const isMcpServer = process.env['DESK_MCP_SERVER'] === '1';

function createLogger() {
  const transport = config.isProduction || isMcpServer
    ? undefined
    : {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname',
          destination: isMcpServer ? 2 : 1,
        },
      };

  if (isMcpServer) {
    return pino(
      { level: config.logLevel },
      pino.destination({ fd: 2 })
    );
  }

  return pino({
    level: config.logLevel,
    transport,
  });
}

export const logger = createLogger();

export function createChildLogger(name: string) {
  return logger.child({ module: name });
}
