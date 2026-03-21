import pino from 'pino';

export const logger = pino({
  level: 'debug',
  timestamp: () => `,"time":"${new Date().toISOString()}"`,
});
