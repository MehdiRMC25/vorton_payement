import type { Request, Response } from 'express';
import { isPromoCodeInCampaignWindow, loadPromoCodeByCode } from '../services/promoCampaignService';

type ActiveCampaignResponse = {
  active: boolean;
  campaignId: string;
  title: string;
  message: string;
  promoCode?: string;
  ctaLabel?: string;
  ctaHref?: string;
  endsAt?: string;
};

function inactive(): ActiveCampaignResponse {
  return { active: false, campaignId: 'none', title: '', message: '' };
}

function isHttpsUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === 'https:';
  } catch {
    return false;
  }
}

function hasHtml(s: string): boolean {
  return /<\/?[a-z][\s\S]*>/i.test(s);
}

export async function getActiveCampaign(_req: Request, res: Response): Promise<void> {
  try {
    const raw = (process.env.PROMO_CAMPAIGN_JSON ?? '').trim();
    if (!raw) {
      res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=120');
      res.json(inactive());
      return;
    }

    const parsed = JSON.parse(raw) as Partial<ActiveCampaignResponse>;
    if (!parsed || typeof parsed !== 'object') {
      res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=120');
      res.json(inactive());
      return;
    }

    if (parsed.active !== true) {
      res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=120');
      res.json(inactive());
      return;
    }

    const campaignId = String(parsed.campaignId ?? '').trim();
    const title = String(parsed.title ?? '').trim();
    const message = String(parsed.message ?? '').trim();

    if (!campaignId || !title || !message || hasHtml(title) || hasHtml(message)) {
      res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=120');
      res.json(inactive());
      return;
    }

    const promoCode = parsed.promoCode != null ? String(parsed.promoCode).trim() : '';
    const ctaLabel = parsed.ctaLabel != null ? String(parsed.ctaLabel).trim() : '';
    const ctaHref = parsed.ctaHref != null ? String(parsed.ctaHref).trim() : '';
    const endsAt = parsed.endsAt != null ? String(parsed.endsAt).trim() : '';

    let resolvedPromoCode = promoCode;
    let resolvedEndsAt = endsAt;

    if (promoCode) {
      const row = await loadPromoCodeByCode(promoCode);
      if (!row || !isPromoCodeInCampaignWindow(row)) {
        res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=120');
        res.json(inactive());
        return;
      }
      resolvedPromoCode = String(row.code).trim();
      if (row.ends_at) {
        resolvedEndsAt = new Date(String(row.ends_at)).toISOString();
      }
    }

    if (ctaLabel && (!ctaHref || !isHttpsUrl(ctaHref))) {
      res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=120');
      res.json(inactive());
      return;
    }

    if (!promoCode && endsAt) {
      const t = Date.parse(endsAt);
      if (!Number.isFinite(t) || Date.now() > t) {
        res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=120');
        res.json(inactive());
        return;
      }
    }

    const body: ActiveCampaignResponse = {
      active: true,
      campaignId,
      title,
      message,
      ...(resolvedPromoCode ? { promoCode: resolvedPromoCode } : {}),
      ...(ctaLabel ? { ctaLabel } : {}),
      ...(ctaHref ? { ctaHref } : {}),
      ...(resolvedEndsAt ? { endsAt: resolvedEndsAt } : {}),
    };

    res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=120');
    res.json(body);
  } catch {
    res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=120');
    res.json(inactive());
  }
}