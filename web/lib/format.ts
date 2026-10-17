// Dates are shown European: dd/mm/yyyy (BRIEF 7.10), times in Belgian time.

/** "2026-10-16" -> "16/10/2026". */
export function formatDate(iso: string | null | undefined) {
  if (!iso) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : "";
}

const dateTime = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Brussels",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** Date -> "16/10/2026 14:05". */
export function formatDateTime(d: Date | string | null | undefined) {
  if (!d) return "";
  return dateTime.format(new Date(d)).replace(",", "");
}

/** Date -> "16/10/2026" (Belgian calendar day). */
export function formatDay(d: Date | string | null | undefined) {
  return formatDateTime(d).slice(0, 10);
}

export function formatBytes(n: number | null | undefined) {
  if (!n) return "";
  return n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}
