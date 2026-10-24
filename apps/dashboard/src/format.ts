import { describePeriod, formatAmount } from "@monavisa/react";

export const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

export function formatDate(unixSec: number): string {
  return new Date(unixSec * 1000).toLocaleDateString("tr-TR", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

const PERIOD_TR: Record<string, string> = {
  month: "ay",
  year: "yıl",
  week: "hafta",
  day: "gün",
  hour: "saat",
};

export const periodTr = (seconds: number) => {
  const label = describePeriod(seconds);
  return PERIOD_TR[label] ?? label.replace("days", "gün").replace("hours", "saat");
};

/** Trial and grace periods read best as a day count: "7 gün". */
export const daysTr = (seconds: number) => `${Math.round(seconds / 86_400)} gün`;

/** Settlement tokens are USDC (6 decimals) until other tokens are allowlisted. */
export const USDC_DECIMALS = 6;

export const usdc = (amount: string | bigint) => formatAmount(BigInt(amount), USDC_DECIMALS);

export const STATUS_TR: Record<string, string> = {
  none: "Yok",
  active: "Aktif",
  past_due: "Ödeme bekliyor",
  canceled: "İptal edildi",
  expired: "Sona erdi",
};

export async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
