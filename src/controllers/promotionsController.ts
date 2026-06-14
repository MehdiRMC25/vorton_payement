import type { Request, Response } from 'express';
import { isPromoCodeInCampaignWindow, loadFeaturedHomePromo } from '../services/promoCampaignService';

export async function getActiveCampaign(_req: Request, res: Response): Promise<void> {
  const cache = 'public, max-age=60, stale-while-revalidate=120';
  try {
    const row = await loadFeaturedHomePromo();
    const active = row != null && isPromoCodeInCampaignWindow(row);
    res.set('Cache-Control', cache);
    if (!active || row == null) {
      res.json({ active: false });
      return;
    }
    res.json({
      active: true,
      code: row.code,
      titleAz: row.home_title_az ?? '',
      titleEn: row.home_title_en ?? '',
      messageAz: row.home_message_az ?? '',
      messageEn: row.home_message_en ?? '',
    });
  } catch {
    res.set('Cache-Control', cache);
    res.json({ active: false });
  }
}