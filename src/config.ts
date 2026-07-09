import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

function envFloat(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Allows 0 (e.g. disable per-item international surcharge). */
function envNonNegativeFloat(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  port: parseInt(process.env.PORT ?? '3000', 10),
  apiPrefix: process.env.API_PREFIX ?? '/api/v1',
  corsOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:3000,http://localhost:5173,http://localhost:5174,https://vorton.uk,https://www.vorton.uk').split(',').map(s => s.trim()),
  apiKey: process.env.API_KEY ?? '',
  jwtSecret: process.env.JWT_SECRET ?? '',
  authSecret: process.env.AUTH_SECRET ?? '',
  /** Staff logins: edit this file (or set STAFF_ACCOUNTS_FILE) and restart the backend to apply. */
  staffAccountsFile: process.env.STAFF_ACCOUNTS_FILE ?? path.join(process.cwd(), 'config', 'staff-accounts.json'),
  authGitHub: {
    clientId: process.env.AUTH_GITHUB_ID ?? '',
    clientSecret: process.env.AUTH_GITHUB_SECRET ?? '',
  },
  // Kapital Bank E-commerce API (Basic Auth)
  bank: {
    gatewayUrl: process.env.KAPITAL_BASE_URL ?? process.env.BANK_GATEWAY_URL ?? '',
    /** Create order path; default /order. Override if Kapital docs specify different (e.g. /Order, /orders). */
    orderPath: process.env.KAPITAL_ORDER_PATH ?? '/order',
    username: process.env.KAPITAL_USERNAME ?? process.env.BANK_USERNAME ?? '',
    password: process.env.KAPITAL_PASSWORD ?? process.env.BANK_PASSWORD ?? '',
    callbackUrl: process.env.CALLBACK_URL ?? '',
  },
  business: {
    name: process.env.BUSINESS_NAME ?? 'Business',
    supportEmail: process.env.SUPPORT_EMAIL ?? '',
  },
  // MongoDB (products catalog; vorton_app database)
  mongodbUri: process.env.MONGODB_URI ?? '',
  cloudinaryCloudName: process.env.CLOUDINARY_CLOUD_NAME ?? '',
  cloudinary: {
    cloudName: process.env.CLOUDINARY_CLOUD_NAME ?? '',
    apiKey: process.env.CLOUDINARY_API_KEY ?? '',
    apiSecret: process.env.CLOUDINARY_API_SECRET ?? '',
  },
  // SMTP shared transport; different From addresses by flow.
  email: {
    host: process.env.EMAIL_HOST ?? '',
    port: parseInt(process.env.EMAIL_PORT ?? '587', 10),
    user: process.env.EMAIL_USER ?? process.env.EMAIL_FROM ?? '',
    pass: process.env.EMAIL_PASS ?? '',
    // Orders/staff notifications sender (e.g. orders@vorton.uk)
    fromOrders: process.env.EMAIL_FROM_ORDERS ?? process.env.EMAIL_FROM ?? "orders@vorton.uk",
    // OTP verification sender. Fallback to orders sender to avoid hard failure if EMAIL_FROM_OTP is unset.
    fromOtp:
        process.env.EMAIL_FROM_OTP ??
        process.env.EMAIL_FROM ??
        process.env.EMAIL_FROM_ORDERS ??
        "orders@vorton.uk",
    // Staff recipients for new order alerts
    to: process.env.EMAIL_TO ?? 'neworder@vorton.uk',
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
  /** Shipping: edit JSON files + optional env overrides; restart server to apply. */
  shipping: {
    internationalFeesFile:
      process.env.INTERNATIONAL_SHIPPING_FEES_FILE ?? path.join(process.cwd(), 'config', 'international-shipping-fees.json'),
    countryAliasesFile:
      process.env.SHIPPING_COUNTRY_ALIASES_FILE ?? path.join(process.cwd(), 'config', 'shipping-country-aliases.json'),
    /** Domestic & international USD → AZN settlement (Kapital). */
    aznPerUsd: envFloat('SHIPPING_AZN_PER_USD', 1.7),
    /** Azerbaijan domestic: AZN ↔ GBP display (fee_azn / this). */
    aznPerGbp: envFloat('SHIPPING_AZN_PER_GBP', 2.3),
    /** International: USD → GBP display only (independent of aznPerUsd). */
    gbpPerUsd: envFloat('SHIPPING_GBP_PER_USD', 0.7429),
    bakuFeeAzn: envFloat('SHIPPING_BAKU_FEE_AZN', 5),
    azOtherFeeAzn: envFloat('SHIPPING_AZ_OTHER_FEE_AZN', 10),
    /** International only: USD added for each merchandise unit after the first (sum of line qty, excl. __delivery__). */
    intlExtraUsdPerAdditionalUnit: envNonNegativeFloat('SHIPPING_INTL_EXTRA_USD_PER_ADDITIONAL_ITEM', 6),
    /** Days before a pending-deletion account is archived and removed. */
    accountDeletion: {
      graceDays: Math.max(1, parseInt(process.env.ACCOUNT_DELETION_GRACE_DAYS ?? '14', 10) || 14),
    },
    /** Days before a pending-deletion account is archived and removed. */
    accountDeletion: {
      graceDays: Math.max(1, parseInt(process.env.ACCOUNT_DELETION_GRACE_DAYS ?? '14', 10) || 14),
    },
  },
} as const;
