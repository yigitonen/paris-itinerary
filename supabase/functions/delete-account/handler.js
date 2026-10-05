// Core logic of the delete-account Edge Function, free of Deno and Supabase imports so
// it can be unit-tested with stubs. index.ts wires in the real Supabase clients.
//
// Order matters: personal data that does not cascade is removed first, and the auth
// user is deleted last. If cleanup fails the account is left intact so the caller can
// simply retry; once the auth user is gone the JWT stops validating, so a repeated
// call fails with 401 and never reaches the cleanup again.

export const CONFIRMATION = 'DELETE';

const MESSAGES = {
  unauthorized: 'Oturum doğrulanamadı. Lütfen tekrar giriş yap.',
  auth_unavailable: 'Oturum şu anda doğrulanamıyor. Lütfen biraz sonra tekrar dene.',
  confirmation_required: 'Hesabı silmek için onay gerekli.',
  cleanup_failed: 'Hesap verileri silinemedi. Hesabın silinmedi; lütfen tekrar dene.',
  delete_failed: 'Hesap silinemedi. Lütfen tekrar dene veya destek ile iletişime geç.'
};

const reply = (status, code, extra = {}) => ({
  status,
  body: code ? { error: MESSAGES[code], code } : { ok: true, ...extra }
});

export function bearerToken(authHeader) {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(String(authHeader || ''));
  return match ? match[1] : '';
}

function isUserAlreadyGone(error) {
  return error?.status === 404 || error?.code === 'user_not_found';
}

/**
 * @param {object} input
 * @param {string|null} input.authHeader  the raw Authorization header
 * @param {() => Promise<unknown>} input.readBody  resolves the parsed JSON body (may reject)
 * @param {(token: string) => Promise<{ user?: { id: string } | null, error?: { status?: number } | null }>} input.authenticate
 * @param {(userId: string) => Promise<{ error?: unknown }>} input.cleanup  runs public.delete_account_data
 * @param {(userId: string) => Promise<{ error?: { status?: number, code?: string } | null }>} input.deleteUser  auth.admin.deleteUser
 * @param {{ error: Function }} [input.log]
 * @returns {Promise<{ status: number, body: object }>}
 */
export async function handleDeleteAccount({ authHeader, readBody, authenticate, cleanup, deleteUser, log = console }) {
  const token = bearerToken(authHeader);
  if (!token) return reply(401, 'unauthorized');

  let user = null;
  try {
    const result = await authenticate(token);
    const status = Number(result?.error?.status);
    // Auth rejected the token (4xx) means "not signed in"; anything else is an outage.
    if (result?.error && !(status >= 400 && status < 500)) return reply(503, 'auth_unavailable');
    user = result?.user || null;
  } catch (error) {
    log.error('delete-account authentication failed', error?.message || error);
    return reply(503, 'auth_unavailable');
  }
  if (!user?.id) return reply(401, 'unauthorized');

  let body = null;
  try { body = await readBody(); } catch { body = null; }
  if (!body || typeof body !== 'object' || body.confirm !== CONFIRMATION) return reply(400, 'confirmation_required');

  try {
    const { error } = await cleanup(user.id);
    if (error) {
      log.error('delete-account cleanup failed', error?.message || error);
      return reply(500, 'cleanup_failed');
    }
  } catch (error) {
    log.error('delete-account cleanup failed', error?.message || error);
    return reply(500, 'cleanup_failed');
  }

  try {
    const { error } = await deleteUser(user.id);
    // A concurrent duplicate request may have deleted the user between our steps.
    if (error && !isUserAlreadyGone(error)) {
      log.error('delete-account user deletion failed', error?.message || error);
      return reply(500, 'delete_failed');
    }
  } catch (error) {
    log.error('delete-account user deletion failed', error?.message || error);
    return reply(500, 'delete_failed');
  }

  return reply(200);
}
