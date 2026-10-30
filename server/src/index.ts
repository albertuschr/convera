import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { buildApp } from './app.js';

const cfg = loadConfig();
const db = createPool(cfg.databaseUrl);
const app = await buildApp(cfg, db);

const stop = async () => { await app.close(); await db.end(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

await app.listen({ port: cfg.port, host: cfg.host });
