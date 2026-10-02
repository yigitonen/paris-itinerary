// Number(null), Number('') and Number(' ') are all 0, so a missing coordinate must be rejected before coercion.
// A real 0 (equator / prime meridian) is a valid coordinate and is kept.
export function coordinate(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export const hasLocation = (item) => coordinate(item?.lat) !== null && coordinate(item?.lng) !== null;
