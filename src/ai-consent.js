// Explicit, versioned consent before trip details are sent to a third-party AI (Google Gemini).
// Bump AI_CONSENT_VERSION whenever what is sent, or to whom, changes: everyone is asked again.
export const AI_CONSENT_KEY = 'roamly-ai-consent';
export const AI_CONSENT_VERSION = 1;

const defaultStorage = () => { try { return globalThis.localStorage; } catch { return null; } };

// Returns the stored `{ version, acceptedAt }` record, or null when missing, unreadable or malformed.
export function getAiConsent(storage = defaultStorage()) {
  try {
    const raw = storage?.getItem(AI_CONSENT_KEY);
    if (!raw) return null;
    const record = JSON.parse(raw);
    if (!record || typeof record !== 'object' || !Number.isInteger(record.version) || record.version < 1) return null;
    return { version: record.version, acceptedAt: typeof record.acceptedAt === 'string' ? record.acceptedAt : '' };
  } catch { return null; }
}

// True when no consent is stored, or it was given for an older version than `version`.
export function needsAiConsent(storage = defaultStorage(), version = AI_CONSENT_VERSION) {
  const record = getAiConsent(storage);
  return !record || record.version < version;
}

// Stores consent for `version`. Returns the record, or null when storage is unavailable (the caller then asks again next time).
export function setAiConsent(storage = defaultStorage(), { version = AI_CONSENT_VERSION, now = new Date() } = {}) {
  const record = { version, acceptedAt: now.toISOString() };
  try {
    storage.setItem(AI_CONSENT_KEY, JSON.stringify(record));
    return record;
  } catch { return null; }
}

// Withdraws consent; the next AI request asks again. Returns false when storage could not be cleared.
export function clearAiConsent(storage = defaultStorage()) {
  try {
    storage.removeItem(AI_CONSENT_KEY);
    return true;
  } catch { return false; }
}
