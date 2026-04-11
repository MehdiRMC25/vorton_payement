import fs from 'fs';
import { config } from '../config';

export interface InternationalFeesData {
  defaultFeeUsd: number;
  feesByCountryCode: Record<string, number>;
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

type FeeEntry = number | { feeUsd: number | null; name?: string };

type RawInternationalFeesFile = {
  defaultFeeUsd?: number;
  /** Per ISO2: plain number (legacy) or { feeUsd, name } so each line shows code + price + label. */
  feesByCountryCode?: Record<string, FeeEntry>;
  _readme?: string;
  aliases?: Record<string, string>;
};

function parseFeesByCountryCode(
  raw: Record<string, FeeEntry> | undefined,
  defaultFeeUsd: number
): { fees: Record<string, number>; unavailable: Set<string> } {
  const fees: Record<string, number> = {};
  const unavailable = new Set<string>();
  if (!raw) return { fees, unavailable };
  for (const [code, val] of Object.entries(raw)) {
    const k = String(code).trim().toUpperCase();
    if (!k || k === 'AZ') continue;
    if (typeof val === 'number') {
      fees[k] = Number.isFinite(val) && val >= 0 ? val : defaultFeeUsd;
      continue;
    }
    if (val && typeof val === 'object' && 'feeUsd' in val) {
      const rawFee = (val as { feeUsd: number | null }).feeUsd;
      if (rawFee === null) {
        unavailable.add(k);
        continue;
      }
      const n = Number(rawFee);
      fees[k] = Number.isFinite(n) && n >= 0 ? n : defaultFeeUsd;
    }
  }
  return { fees, unavailable };
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
  cached = {
    defaultFeeUsd: def,
    feesByCountryCode: parsed.fees,
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
