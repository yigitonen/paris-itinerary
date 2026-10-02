import { GUEST_STORAGE_KEY } from './config.js';
import { PENDING_PLAN_KEY } from './lifecycle.js';

// Client side of in-app and web account deletion. The server work (data cleanup, then
// deleting the auth user) happens in the delete-account Edge Function; this module calls
// it, turns failures into Turkish messages, and removes what the app keeps on the device.

export const DELETE_ACCOUNT_FUNCTION = 'delete-account';
export const DELETE_ACCOUNT_CONFIRMATION = 'DELETE';

// Per-user localStorage prefixes written by src/offline.js (cloud cache, queued edits,
// failed edits). account.test.js reads offline.js to make sure these stay in sync.
export const USER_STORAGE_PREFIXES = Object.freeze([
  'roamly-cloud-cache-v1:',
  'roamly-cloud-queue-v1:',
  'roamly-cloud-failed-v1:'
]);

// Accepts the Turkish or English confirmation word, in any case ("sil", "SİL", "Delete").
export function isDeleteConfirmation(value) {
  const text = String(value ?? '').trim().toLocaleUpperCase('tr-TR');
  return text === 'SİL' || text === 'SIL' || text === 'DELETE';
}

const MESSAGES = {
  unauthorized: 'Oturumun doğrulanamadı. Lütfen çıkış yapıp tekrar giriş yap, sonra yeniden dene.',
  auth_unavailable: 'Oturum şu anda doğrulanamıyor. Lütfen biraz sonra tekrar dene.',
  confirmation_required: 'Hesabı silmek için onay gerekli.',
  cleanup_failed: 'Hesap verilerin silinemedi. Hesabın silinmedi; lütfen tekrar dene.',
  delete_failed: 'Hesabın silinemedi. Lütfen tekrar dene veya destek ile iletişime geç.',
  not_configured: 'Hesap silme şu anda kullanılamıyor. Lütfen biraz sonra tekrar dene.',
  signed_out: 'Hesabı silmek için giriş yapman gerekiyor.',
  offline: 'İnternet bağlantısı yok. Bağlandığında hesabı silmeyi tekrar dene.',
  unknown: 'Hesabın silinemedi. Lütfen tekrar dene veya destek ile iletişime geç.'
};

const STATUS_CODES = { 400: 'confirmation_required', 401: 'unauthorized', 503: 'auth_unavailable' };

export class AccountDeletionError extends Error {
  constructor(code, cause) {
    super(MESSAGES[code] || MESSAGES.unknown);
    this.name = 'AccountDeletionError';
    this.code = MESSAGES[code] ? code : 'unknown';
    if (cause !== undefined) this.cause = cause;
  }
}

// Turkish message for an error from supabase.functions.invoke (or an AccountDeletionError).
export async function accountDeletionError(error) {
  if (error instanceof AccountDeletionError) return error;
  const response = error?.context;
  if (response && typeof response.status === 'number') {
    let code = '';
    try { code = String((await (response.clone?.() ?? response).json())?.code || ''); } catch { /* body is optional */ }
    if (!MESSAGES[code]) code = STATUS_CODES[response.status] || 'unknown';
    return new AccountDeletionError(code, error);
  }
  if (error?.name === 'FunctionsFetchError' || error?.name === 'FunctionsRelayError' || error instanceof TypeError) {
    return new AccountDeletionError('offline', error);
  }
  return new AccountDeletionError('unknown', error);
}

function safeStorage(kind) {
  try { return globalThis[kind] || null; } catch { return null; }
}

// Removes everything the app stores on this device for the given user: cached cloud trips,
// queued and failed sync entries, and a pending AI plan. Guest trips are device-local and
// not tied to the account, so they are kept unless includeGuest is set. Never throws.
export function clearLocalAccountData(userId, {
  storage = safeStorage('localStorage'),
  session = safeStorage('sessionStorage'),
  includeGuest = false
} = {}) {
  const removed = [];
  const remove = (store, key) => {
    try { store.removeItem(key); removed.push(key); } catch { /* storage may be blocked */ }
  };
  if (storage) {
    if (userId) for (const prefix of USER_STORAGE_PREFIXES) remove(storage, `${prefix}${userId}`);
    if (includeGuest) remove(storage, GUEST_STORAGE_KEY);
  }
  if (session) remove(session, PENDING_PLAN_KEY);
  return removed;
}

/**
 * Permanently deletes the signed-in account and signs out on this device.
 * Resolves only when the server confirmed the deletion; otherwise throws an
 * AccountDeletionError whose message is safe to show to the user.
 */
export async function deleteAccount(supabase, options = {}) {
  const { data: sessionData } = await supabase.auth.getSession();
  const userId = sessionData?.session?.user?.id;
  if (!userId) throw new AccountDeletionError('signed_out');

  let result;
  try {
    result = await supabase.functions.invoke(DELETE_ACCOUNT_FUNCTION, { body: { confirm: DELETE_ACCOUNT_CONFIRMATION } });
  } catch (error) {
    throw await accountDeletionError(error);
  }
  if (result?.error) throw await accountDeletionError(result.error);
  if (result?.data?.ok !== true) throw new AccountDeletionError('unknown');

  // The account is gone. Drop the local session without a server call (the server no longer
  // knows this user), then wipe what the device cached for it. Failures here must not turn
  // a successful deletion into an error.
  try { await supabase.auth.signOut({ scope: 'local' }); } catch { /* the stored session is cleared below */ }
  clearLocalAccountData(userId, options);
  return { ok: true };
}
