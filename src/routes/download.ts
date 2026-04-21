import { Request, Router } from 'express';

export const downloadRouter = Router();

function isLikelyAzerbaijan(req: Request): boolean {
    // Cloudflare country header (uppercase ISO2 like "AZ")
    const cfCountryRaw = req.header('cf-ipcountry') || '';
    const cfCountry = String(cfCountryRaw).trim().toUpperCase();

    if (cfCountry === 'AZ') return true;
    if (cfCountry && cfCountry !== 'XX' && cfCountry !== 'T1') return false;

    // Fallback when CF header is missing: Accept-Language hint
    const al = String(req.header('accept-language') || '').toLowerCase();
    return al.includes('az');
}

downloadRouter.get('/', (req, res) => {
    const ua = String(req.header('user-agent') || '');

    // Keep these in Render env vars so you can change links without code edits
    const androidUrl =
        process.env.ANDROID_STORE_URL ||
        'https://play.google.com/store/apps/details?id=YOUR_ANDROID_ID';

    const iosUrl =
        process.env.IOS_STORE_URL ||
        'https://apps.apple.com/app/idYOUR_IOS_ID';

    const siteUk = process.env.SITE_UK_URL || 'https://vorton.uk';
    const siteAz = process.env.SITE_AZ_URL || 'https://vorton.az';

    const site = isLikelyAzerbaijan(req) ? siteAz : siteUk;

    // Mobile first
    if (/android/i.test(ua)) {
        return res.redirect(302, androidUrl);
    }

    if (/iPhone|iPad|iPod/i.test(ua)) {
        return res.redirect(302, iosUrl);
    }

    // Desktop / unknown devices -> country-aware website
    return res.redirect(302, site);
});