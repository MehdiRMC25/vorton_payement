/**
 * Shipping: Azerbaijan = fixed AZN (Baku vs rest); international = USD fee per country from config file,
 * settled to AZN via SHIPPING_AZN_PER_USD. Display quotes use env rates (see config.shipping).
 */

import type { OrderItem } from './orderService';
import { shippingFeeAznFromItems } from './rewardPointsPolicy';
import { getInternationalShippingFeeUsd } from './internationalShippingFeesStore';
import { config } from '../config';

export type ShippingZone = 'baku' | 'azerbaijan_other' | 'international';

export type CheckoutCurrency = 'AZN' | 'USD' | 'GBP';

const AZ_COUNTRY_RE =
  /^(az|aze|azerbaijan|azərbaycan|republic\s+of\s+azerbaijan|azerbaijan\s+republic)$/iu;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function normalizeCheckoutCurrency(raw: string | null | undefined): CheckoutCurrency | null {
  const s = String(raw ?? '')
    .trim()
    .toUpperCase();
  if (s === 'AZN' || s === '₼') return 'AZN';
  if (s === 'USD' || s === '$') return 'USD';
  if (s === 'GBP' || s === '£') return 'GBP';
  return null;
}

function normalizeCountryKey(raw: string): string {
  return String(raw)
    .trim()
    .toLowerCase()
    .normalize('NFKC');
}

export function isAzerbaijanCountry(raw: string | null | undefined): boolean {
  const key = normalizeCountryKey(String(raw ?? ''));
  if (!key) return false;
  if (AZ_COUNTRY_RE.test(key)) return true;
  return key === 'az' || key === 'aze';
}

export function isBakuCity(raw: string | null | undefined): boolean {
  const t = String(raw ?? '').trim();
  if (!t) return false;
  const lower = t.toLowerCase();
  if (lower === 'baku' || lower === 'baki' || lower === 'bakı' || lower === 'баку') {
    return true;
  }
  const nk = lower.normalize('NFD').replace(/\p{M}/gu, '');
  return nk === 'baku' || nk === 'baki';
}

export function resolveShippingZone(
  deliveryCity: string | null | undefined,
  deliveryCountry: string | null | undefined
): ShippingZone {
  const country = String(deliveryCountry ?? '').trim();
  if (!isAzerbaijanCountry(country)) {
    return 'international';
  }
  if (isBakuCity(deliveryCity)) {
    return 'baku';
  }
  return 'azerbaijan_other';
}

export function hasCompleteShippingPolicyInput(shipping: {
  delivery_country?: string | null;
  checkout_currency?: string | null;
}): boolean {
  const country = String(shipping.delivery_country ?? '').trim();
  const ccy = normalizeCheckoutCurrency(shipping.checkout_currency);
  return country.length > 0 && ccy != null;
}

export type ShippingResolution =
  | {
      source: 'policy';
      shippingAzn: number;
      currency: CheckoutCurrency;
      zone: ShippingZone;
      /** International catalog fee in USD (from JSON). */
      internationalFeeUsd: number | null;
      /** 5 or 10 for Azerbaijan zones. */
      domesticFeeAzn: number | null;
      countryIso2: string | null;
      shippingQuoteAmount: number;
      shippingQuoteCurrency: CheckoutCurrency;
    }
  | { source: 'lines'; shippingAzn: number }
  | { source: 'unavailable'; zone: 'international'; countryIso2: string | null; currency: CheckoutCurrency };

type SettledZone =
  | { shippingUnavailable: true; countryIso2: string | null }
  | {
      shippingUnavailable: false;
      shippingAzn: number;
      internationalFeeUsd: number | null;
      domesticFeeAzn: number | null;
      countryIso2: string | null;
    };

function settledAznForZone(zone: ShippingZone, deliveryCountry: string | null | undefined): SettledZone {
  const { bakuFeeAzn, azOtherFeeAzn, aznPerUsd } = config.shipping;
  if (zone === 'baku') {
    return {
      shippingUnavailable: false,
      shippingAzn: round2(bakuFeeAzn),
      internationalFeeUsd: null,
      domesticFeeAzn: round2(bakuFeeAzn),
      countryIso2: null,
    };
  }
  if (zone === 'azerbaijan_other') {
    return {
      shippingUnavailable: false,
      shippingAzn: round2(azOtherFeeAzn),
      internationalFeeUsd: null,
      domesticFeeAzn: round2(azOtherFeeAzn),
      countryIso2: null,
    };
  }
  const r = getInternationalShippingFeeUsd(String(deliveryCountry ?? ''));
  if (!r.available) {
    return { shippingUnavailable: true, countryIso2: r.iso2 };
  }
  const feeUsd = r.feeUsd ?? 0;
  const shippingAzn = round2(feeUsd * aznPerUsd);
  return {
    shippingUnavailable: false,
    shippingAzn,
    internationalFeeUsd: feeUsd,
    domesticFeeAzn: null,
    countryIso2: r.iso2,
  };
}

function shippingDisplayQuote(
  zone: ShippingZone,
  currency: CheckoutCurrency,
  settledShippingAzn: number,
  internationalFeeUsd: number | null,
  domesticFeeAzn: number | null
): { quoteAmount: number; quoteCurrency: CheckoutCurrency } {
  const { aznPerUsd, aznPerGbp, gbpPerUsd } = config.shipping;
  if (zone === 'international' && internationalFeeUsd != null) {
    if (currency === 'USD') {
      return { quoteAmount: round2(internationalFeeUsd), quoteCurrency: 'USD' };
    }
    if (currency === 'GBP') {
      return { quoteAmount: round2(internationalFeeUsd * gbpPerUsd), quoteCurrency: 'GBP' };
    }
    return { quoteAmount: round2(settledShippingAzn), quoteCurrency: 'AZN' };
  }
  const base = domesticFeeAzn;
  if (base == null) {
    return { quoteAmount: round2(settledShippingAzn), quoteCurrency: 'AZN' };
  }
  if (currency === 'AZN') {
    return { quoteAmount: round2(base), quoteCurrency: 'AZN' };
  }
  if (currency === 'USD') {
    return { quoteAmount: round2(base / aznPerUsd), quoteCurrency: 'USD' };
  }
  return { quoteAmount: round2(base / aznPerGbp), quoteCurrency: 'GBP' };
}

export function resolveShippingAmount(
  items: OrderItem[],
  shipping?: {
    delivery_city?: string | null;
    delivery_country?: string | null;
    checkout_currency?: string | null;
  } | null
): ShippingResolution {
  if (!shipping || !hasCompleteShippingPolicyInput(shipping)) {
    return { source: 'lines', shippingAzn: shippingFeeAznFromItems(items) };
  }
  const ccy = normalizeCheckoutCurrency(shipping.checkout_currency);
  if (!ccy) {
    return { source: 'lines', shippingAzn: shippingFeeAznFromItems(items) };
  }
  const zone = resolveShippingZone(shipping.delivery_city, shipping.delivery_country);
  const settled = settledAznForZone(zone, shipping.delivery_country);
  if (settled.shippingUnavailable) {
    return { source: 'unavailable', zone: 'international', countryIso2: settled.countryIso2, currency: ccy };
  }
  const { shippingAzn, internationalFeeUsd, domesticFeeAzn, countryIso2 } = settled;
  const q = shippingDisplayQuote(zone, ccy, shippingAzn, internationalFeeUsd, domesticFeeAzn);
  return {
    source: 'policy',
    shippingAzn,
    currency: ccy,
    zone,
    internationalFeeUsd,
    domesticFeeAzn,
    countryIso2,
    shippingQuoteAmount: q.quoteAmount,
    shippingQuoteCurrency: q.quoteCurrency,
  };
}
