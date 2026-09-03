export function escapeHtml(str: string | undefined | null): string {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function escapeAttr(str: string | undefined | null): string {
  return escapeHtml(str);
}

const PREFERRED_TIMEZONES = [
  'Asia/Jerusalem',
  'UTC',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'America/New_York',
  'America/Los_Angeles',
  'America/Chicago',
  'Asia/Dubai',
  'Asia/Tokyo',
];

export function timezoneSelectHtml(selected: string, id = 'timezone'): string {
  let zones: string[] = PREFERRED_TIMEZONES;
  try {
    zones = Intl.supportedValuesOf('timeZone');
  } catch {
    // keep preferred list
  }
  const preferred = PREFERRED_TIMEZONES.filter((z) => zones.includes(z));
  const rest = zones.filter((z) => !preferred.includes(z));
  const options = [...preferred, ...rest]
    .map((z) => `<option value="${escapeAttr(z)}"${z === selected ? ' selected' : ''}>${escapeHtml(z)}</option>`)
    .join('');
  return `<select id="${escapeAttr(id)}" name="timezone">${options}</select>`;
}
