import { finalizeDueAccountDeletions } from './customerService';

const TICK_MS = 60 * 60 * 1000;

export function startAccountDeletionScheduler(): void {
  const tick = async (): Promise<void> => {
    try {
      const count = await finalizeDueAccountDeletions();
      if (count > 0) {
        console.log(`[AccountDeletion] Finalized ${count} account(s)`);
      }
    } catch (e) {
      console.warn('[AccountDeletion] Scheduler tick failed:', e instanceof Error ? e.message : e);
    }
  };

  void tick();
  setInterval(() => {
    void tick();
  }, TICK_MS);
}