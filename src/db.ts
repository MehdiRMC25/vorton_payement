import { Pool } from 'pg';
import { config } from './config';

/**
 * PostgreSQL connection pool.
 * Uses DATABASE_URL if set (e.g. on Render), otherwise uses PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE.
 * Import and use: const { pool } = await import('./db');
 */
function createPool(): Pool {
  if (config.database.url) {
    return new Pool({
      connectionString: config.database.url,
      ssl: config.env === 'production' ? { rejectUnauthorized: true } : false,
    });
  }
  return new Pool({
    host: config.database.host,
    port: config.database.port,
    user: config.database.user,
    password: config.database.password,
    database: config.database.database,
  });
}

export const pool = createPool();
