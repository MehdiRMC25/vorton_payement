/**
 * Manually sync staff accounts from config/staff-accounts.json into the customers table.
 * Run from project root (same place as package.json).
 *
 * Usage: npm run sync-staff
 *
 * Requires: .env with DATABASE_URL (or PGHOST, etc.) so the app can connect to your Postgres.
 * The file config/staff-accounts.json must exist in the project root.
 */
import '../src/config';
import { syncStaffAccounts } from '../src/services/staffAccountsService';

async function main(): Promise<void> {
  console.log('Syncing staff accounts from config/staff-accounts.json to Postgres...');
  const result = await syncStaffAccounts();
  console.log('Result:', result.synced, 'account(s) synced.', result.errors.length ? 'Errors:' : '');
  if (result.errors.length > 0) {
    result.errors.forEach((e) => console.error(e));
    process.exit(1);
  }
  if (result.synced === 0) {
    console.log('No accounts synced. Check that config/staff-accounts.json exists and has valid entries.');
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
