/** Grant timestamps are local to the computer that observed the credential. */
export function formatDeviceGrantTime(value: string, locale: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(date);
}
