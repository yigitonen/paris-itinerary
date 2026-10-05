import { createClient } from '@supabase/supabase-js';
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from './config.js';
import { deleteAccount, isDeleteConfirmation } from './account.js';

// Controller for the public /delete-account page (delete-account.html). It builds the same
// Supabase client as the app (same project, same PKCE settings and storage key) so an
// existing web session is reused, and signs in with the e-mail link like the app does.

const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce' }
});

const $ = (selector) => document.querySelector(selector);
const panels = { signin: $('#signin'), confirm: $('#confirm'), done: $('#done') };
const loading = $('#loading');
let deleting = false;
let finished = false;

function show(name) {
  loading.hidden = true;
  for (const [key, panel] of Object.entries(panels)) panel.hidden = key !== name;
}

function say(selector, message, kind = '') {
  const element = $(selector);
  element.textContent = message;
  element.className = `status ${kind}`.trim();
}

// The page URL without query or hash: the e-mail link and Google sign-in return here.
const returnUrl = () => `${location.origin}${location.pathname}`;

function signInErrorMessage(error) {
  const code = String(error?.code || '');
  if (code === 'over_email_send_rate_limit' || error?.status === 429) return 'Çok sık denedin. Lütfen birkaç dakika sonra tekrar dene.';
  if (code === 'email_address_invalid' || code === 'validation_failed') return 'Geçerli bir e-posta adresi gir.';
  return 'Giriş bağlantısı gönderilemedi. Lütfen tekrar dene.';
}

function render(session) {
  if (deleting || finished) return;
  if (!session?.user) { show('signin'); return; }
  $('#account-email').textContent = session.user.email || 'Bu';
  show('confirm');
}

$('#signin-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const email = $('#email').value.trim();
  if (!/^\S+@\S+\.\S+$/.test(email)) { say('#signin-status', 'Geçerli bir e-posta adresi gir.', 'error'); return; }
  const button = $('#send-link');
  button.disabled = true;
  say('#signin-status', 'Gönderiliyor…');
  // shouldCreateUser: false so this page can never create an account.
  const { error } = await supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: returnUrl(), shouldCreateUser: false } });
  button.disabled = false;
  // An address without an account gets the same answer, so the page does not reveal who has one.
  if (error && error.code !== 'otp_disabled' && error.code !== 'signup_disabled') { say('#signin-status', signInErrorMessage(error), 'error'); return; }
  say('#signin-status', 'Bu adreste bir hesap varsa giriş bağlantısı gönderildi. E-postanı kontrol et ve bağlantıyı bu tarayıcıda aç.', 'ok');
});

$('#google').addEventListener('click', async () => {
  say('#signin-status', 'Google’a yönlendiriliyor…');
  const { error } = await supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: returnUrl() } });
  if (error) say('#signin-status', 'Google ile giriş başlatılamadı. Lütfen tekrar dene.', 'error');
});

$('#confirm-input').addEventListener('input', () => {
  $('#delete').disabled = !isDeleteConfirmation($('#confirm-input').value);
});

$('#confirm-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (deleting || !isDeleteConfirmation($('#confirm-input').value)) return;
  deleting = true;
  $('#delete').disabled = true;
  $('#signout').disabled = true;
  say('#confirm-status', 'Hesabın siliniyor…');
  try {
    await deleteAccount(supabase, { includeGuest: false });
    finished = true;
    show('done');
  } catch (error) {
    say('#confirm-status', error?.message || 'Hesabın silinemedi. Lütfen tekrar dene.', 'error');
    $('#delete').disabled = !isDeleteConfirmation($('#confirm-input').value);
    $('#signout').disabled = false;
  } finally {
    deleting = false;
  }
});

$('#signout').addEventListener('click', async () => {
  await supabase.auth.signOut({ scope: 'local' }).catch(() => {});
  $('#confirm-input').value = '';
  say('#confirm-status', '');
  show('signin');
});

supabase.auth.onAuthStateChange((_event, session) => {
  // Deferred: supabase-js forbids awaiting other auth calls inside this callback.
  setTimeout(() => render(session), 0);
});

// Failed e-mail or OAuth callbacks come back as ?error_description=… or #error_description=….
const callbackParams = new URLSearchParams(`${location.search}&${location.hash.replace(/^#/, '')}`);
const callbackFailed = callbackParams.has('error') || callbackParams.has('error_description');

supabase.auth.getSession().then(({ data }) => {
  render(data.session);
  if (callbackFailed && !data.session) say('#signin-status', 'Giriş bağlantısı geçersiz veya süresi dolmuş. Yeni bir bağlantı iste.', 'error');
}).catch(() => {
  show('signin');
  say('#signin-status', 'Oturum kontrol edilemedi. Lütfen sayfayı yenile.', 'error');
});
