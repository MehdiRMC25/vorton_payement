import dotenv from 'dotenv';

dotenv.config();

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  port: parseInt(process.env.PORT ?? '3000', 10),
  apiPrefix: process.env.API_PREFIX ?? '/api/v1',
  corsOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:3000,http://localhost:5173,http://localhost:5174,https://vorton.uk').split(',').map(s => s.trim()),
  apiKey: process.env.API_KEY ?? '',
  jwtSecret: process.env.JWT_SECRET ?? '',
  authSecret: process.env.AUTH_SECRET ?? '',
  authGitHub: {
    clientId: process.env.AUTH_GITHUB_ID ?? '',
    clientSecret: process.env.AUTH_GITHUB_SECRET ?? '',
  },
  // Kapital Bank E-commerce API (Basic Auth)
  bank: {
    gatewayUrl: process.env.KAPITAL_BASE_URL ?? process.env.BANK_GATEWAY_URL ?? '',
    username: process.env.KAPITAL_USERNAME ?? process.env.BANK_USERNAME ?? '',
    password: process.env.KAPITAL_PASSWORD ?? process.env.BANK_PASSWORD ?? '',
    callbackUrl: process.env.CALLBACK_URL ?? '',
  },
  business: {
    name: process.env.BUSINESS_NAME ?? 'Business',
    supportEmail: process.env.SUPPORT_EMAIL ?? '',
  },
  // PostgreSQL (optional; used for customers/auth when set)
  database: {
    url: process.env.DATABASE_URL ?? '',
    host: process.env.PGHOST ?? 'localhost',
    port: parseInt(process.env.PGPORT ?? '5432', 10),
    user: process.env.PGUSER ?? 'postgres',
    password: process.env.PGPASSWORD ?? '',
    database: process.env.PGDATABASE ?? 'Vorton',
  },
} as const;
