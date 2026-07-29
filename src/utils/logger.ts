export interface Logger {
  info(message: string, details?: Record<string, unknown>): void;
  warn(message: string, details?: Record<string, unknown>): void;
  error(message: string, details?: Record<string, unknown>): void;
}

function emit(level: string, message: string, details?: Record<string, unknown>): void {
  const payload = {
    level,
    time: new Date().toISOString(),
    message,
    ...(details ?? {}),
  };
  const line = JSON.stringify(payload);
  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export const consoleLogger: Logger = {
  info: (message, details) => emit('info', message, details),
  warn: (message, details) => emit('warn', message, details),
  error: (message, details) => emit('error', message, details),
};
