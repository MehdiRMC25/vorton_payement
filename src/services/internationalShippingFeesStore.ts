import fs from 'fs';
import { config } from '../config';

export interface InternationalFeesData {
  defaultFeeUsd: number;
  /** Optional file-level default $/extra unit (overrides config.ts when set). */
  defaultExtraUsdPerAdditionalUnit: number | null;
  feesByCountryCode: Record<string, number>;
  /** ISO2 → explicit $/extra unit when set on that country row. */
  extraUsdPerAdditionalUnitByCountry: Record<string, number>;
  /** ISO2 codes where feeUsd is null in JSON — delivery not offered. */
  unavailableCountryCodes: Set<string>;
  aliases: Record<string, string>;
}

let cached: InternationalFeesData | null = null;

function readJsonFile<T>(filePath: string): T {
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw) as T;
}

function normalizeAliasKey(s: string): string {
  return String(s)
    .trim()
    .toLowerCase()
    .normalize('NFKC');
}

type FeeEntry =
  | number
  | {
      feeUsd: number | null;
      name?: string;
      /** Optional: USD per merchandise unit after the first; omit = file default or config.ts */
      extraUsdPerAdditionalUnit?: number | null;
    };

type RawInternationalFeesFile = {
  defaultFeeUsd?: number;
  /** Optional: default $/extra unit for all countries in this file (overrides config.ts). */
  defaultExtraUsdPerAdditionalUnit?: number | null;
  feesByCountryCode?: Record<string, FeeEntry>;
  _readme?: string;
  aliases?: Record<string, string>;
};

function parseFeesByCountryCode(
  raw: Record<string, FeeEntry> | undefined,
  defaultFeeUsd: number
): { fees: Record<string, number>; unavailable: Set<string>; extraByCountry: Record<string, number> } {
  const fees: Record<string, number> = {};
  const unavailable = new Set<string>();
  const extraByCountry: Record<string, number> = {};
  if (!raw) return { fees, unavailable, extraByCountry };
  for (const [code, val] of Object.entries(raw)) {
    const k = String(code).trim().toUpperCase();
    if (!k || k === 'AZ') continue;
    if (typeof val === 'number') {
      fees[k] = Number.isFinite(val) && val >= 0 ? val : defaultFeeUsd;
      continue;
    }
    if (val && typeof val === 'object' && 'feeUsd' in val) {
      const obj = val as { feeUsd: number | null; extraUsdPerAdditionalUnit?: number | null };
      const rawFee = obj.feeUsd;
      if (rawFee === null) {
        unavailable.add(k);
        continue;
      }
      const n = Number(rawFee);
      fees[k] = Number.isFinite(n) && n >= 0 ? n : defaultFeeUsd;
      if ('extraUsdPerAdditionalUnit' in obj && obj.extraUsdPerAdditionalUnit != null) {
        const ex = Number(obj.extraUsdPerAdditionalUnit);
        if (Number.isFinite(ex) && ex >= 0) {
          extraByCountry[k] = ex;
        }
      }
    }
  }
  return { fees, unavailable, extraByCountry };
}

export function loadInternationalFeesData(): InternationalFeesData {
  if (cached) return cached;
  const data = readJsonFile<RawInternationalFeesFile>(config.shipping.internationalFeesFile);
  const def = Number.isFinite(data.defaultFeeUsd) && data.defaultFeeUsd! >= 0 ? data.defaultFeeUsd! : 50;
  const merged: Record<string, string> = {};
  try {
    const fromFile = readJsonFile<Record<string, string>>(config.shipping.countryAliasesFile);
    for (const [k, v] of Object.entries(fromFile)) {
      merged[normalizeAliasKey(k)] = String(v).toUpperCase();
    }
  } catch {
    /* optional */
  }
  const fromFeesAliases = data.aliases || {};
  for (const [k, v] of Object.entries(fromFeesAliases)) {
    merged[normalizeAliasKey(k)] = String(v).toUpperCase();
  }
  const parsed = parseFeesByCountryCode(data.feesByCountryCode, def);
  const fileDefaultExtra =
    data.defaultExtraUsdPerAdditionalUnit != null && Number.isFinite(Number(data.defaultExtraUsdPerAdditionalUnit))
      ? Math.max(0, Number(data.defaultExtraUsdPerAdditionalUnit))
      : null;
  cached = {
    defaultFeeUsd: def,
    defaultExtraUsdPerAdditionalUnit: fileDefaultExtra,
    feesByCountryCode: parsed.fees,
    extraUsdPerAdditionalUnitByCountry: parsed.extraByCountry,
    unavailableCountryCodes: parsed.unavailable,
    aliases: merged,
  };
  return cached;
}

/** Fee in USD for international shipping (non-Azerbaijan). `available: false` when feeUsd is null in config. */
export function getInternationalShippingFeeUsd(countryInput: string): {
  feeUsd: number | null;
  iso2: string | null;
  available: boolean;
} {
  const data = loadInternationalFeesData();
  const iso = resolveCountryToIso2(countryInput, data);
  if (!iso) {
    return { feeUsd: data.defaultFeeUsd, iso2: null, available: true };
  }
  if (data.unavailableCountryCodes.has(iso)) {
    return { feeUsd: null, iso2: iso, available: false };
  }
  const fee = data.feesByCountryCode[iso];
  return {
    feeUsd: fee !== undefined && Number.isFinite(fee) ? fee : data.defaultFeeUsd,
    iso2: iso,
    available: true,
  };
}

/**
 * USD per merchandise unit after the first (international only).
 * Priority: country row → file defaultExtraUsdPerAdditionalUnit → config.shipping.intlExtraUsdPerAdditionalUnit
 */
export function resolveInternationalExtraUsdPerAdditionalUnit(iso2: string | null): number {
  const globalDefault = config.shipping.intlExtraUsdPerAdditionalUnit;
  const data = loadInternationalFeesData();
  if (iso2 && Object.prototype.hasOwnProperty.call(data.extraUsdPerAdditionalUnitByCountry, iso2)) {
    return data.extraUsdPerAdditionalUnitByCountry[iso2];
  }
  if (data.defaultExtraUsdPerAdditionalUnit != null && Number.isFinite(data.defaultExtraUsdPerAdditionalUnit)) {
    return data.defaultExtraUsdPerAdditionalUnit;
  }
  return globalDefault;
}

function resolveCountryToIso2(countryInput: string, data: InternationalFeesData): string | null {
  const t = String(countryInput ?? '').trim();
  if (!t) return null;
  if (/^[A-Za-z]{2}$/.test(t)) {
    return t.toUpperCase();
  }
  if (/^[A-Za-z]{3}$/.test(t)) {
    const iso3 = t.toUpperCase();
    const iso2From3: Record<string, string> = {
      USA: 'US',
      GBR: 'GB',
      ARE: 'AE',
      RUS: 'RU',
      KOR: 'KR',
      PRK: 'KP',
      VNM: 'VN',
      TUR: 'TR',
      UKR: 'UA',
      DEU: 'DE',
      FRA: 'FR',
      ITA: 'IT',
      ESP: 'ES',
      NLD: 'NL',
      BEL: 'BE',
      CHE: 'CH',
      AUT: 'AT',
      SWE: 'SE',
      NOR: 'NO',
      DNK: 'DK',
      FIN: 'FI',
      POL: 'PL',
      CZE: 'CZ',
      HUN: 'HU',
      ROU: 'RO',
      BGR: 'BG',
      HRV: 'HR',
      SVK: 'SK',
      SVN: 'SI',
      LTU: 'LT',
      LVA: 'LV',
      EST: 'EE',
      IRL: 'IE',
      PRT: 'PT',
      GRC: 'GR',
    };
    if (iso2From3[iso3]) return iso2From3[iso3];
  }
  const key = normalizeAliasKey(t);
  const code = data.aliases[key];
  return code ? code.toUpperCase() : null;
}
