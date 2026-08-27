import pino from 'pino';
import { config } from './config.ts';

export const logger = pino({
  level: config.logLevel,
  transport: config.isProduction
    ? undefined
    : {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname',
        },
      },
});

export function createChildLogger(name: string) {
  return logger.child({ module: name });
}
