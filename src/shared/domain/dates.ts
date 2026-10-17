/** Strict ISO calendar dates, including years 0000–0099 without Date.UTC coercion. */
export function isISODate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  try { return new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value; }
  catch { return false; }
}
