import { createApp } from './app';
import { loadConfig } from './config';
import { startHttpServer } from './http/server';

async function main(): Promise<void> {
  const config = loadConfig();
  const app = createApp(config);
  const server = startHttpServer(app);
  const stop = (): void => {
    server.close();
    app.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
