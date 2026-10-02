import './styles.css';
import { COVER_IMAGES, createManualTrip } from './src/data.js';
import {
  completePkceCallback,
  deleteTrip,
  failedTripSyncCount,
  flushPendingTripChanges,
  getSession,
  joinLocalsWaitlist,
  loadTrips,
  migrateGuestTrips,
  pendingTripSyncCount,
  saveTrip,
  sendEmailSignInLink,
  startGoogleOAuth,
  supabase
} from './src/repository.js';
import { generateTrip } from './src/planner.js';
import { createPlacesClient, debounce, NEARBY_CATEGORIES, placeSearchMessage } from './src/places.js';
import { dayCenter, dayReadiness, googleDayRouteUrl, mealRole, moveStop, optimizeDay, shiftDay, tiktokSearchUrl } from './src/itinerary.js';
import { renderRouteMap } from './src/map.js';
import { ensureProfile, loadConnections, removeConnection, requestConnection, respondToConnection, searchProfiles } from './src/social.js';
import { createPostSignInGuard, createUserTracker, PENDING_PLAN_KEY, registerServiceWorker, takePendingPlan } from './src/lifecycle.js';
import { parseGoogleSavedPlaces } from './src/importers.js';
import { getTripWeather } from './src/weather.js';
import { coordinate, hasLocation } from './src/coords.js';
import { applyBudgetSettings, budgetSummary, currencyOptions } from './src/budget.js';
import { orphanedReminderIds, reminderIdFor, reminderIdsForStops, reminderIdsForTrip } from './src/reminders.js';
import { recapShareOptions } from './src/sharing.js';
import { BACKUP_MAX_BYTES, backupErrorMessage, parseBackup, serializeBackup, serializeTrip } from './src/backup.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const escapeHtml = (value = '') => String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
const icons = () => window.lucide?.createIcons({ attrs: { 'aria-hidden': 'true' } });
const isoToday = () => new Date().toISOString().slice(0, 10);
const uid = () => crypto.randomUUID();

const formatDate = (value, options = { day: 'numeric', month: 'short' }) => {
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat('tr-TR', options).format(date);
};
const formatDateTime = (value) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat('tr-TR', { day: 'numeric', month: 'long', year: 'numeric' }).format(date);
};
const formatRange = (trip) => `${formatDate(trip.startDate)} – ${formatDate(trip.endDate, { day: 'numeric', month: 'short', year: 'numeric' })}`;
const dayCountText = (trip) => `${Number(trip.durationDays) || trip.days?.length || 1} gün`;
// constant asset paths only; CSS url() context, never interpolate trip data here
const coverUrl = (trip) => Object.hasOwn(COVER_IMAGES, trip.coverKey) ? COVER_IMAGES[trip.coverKey] : COVER_IMAGES.default;
const completion = (trip) => {
  const planned = (trip.days || []).filter((day) => day.stops?.length).length;
  const budget = Number(trip.budgetTotal) > 0 ? 1 : 0;
  return Math.min(100, Math.round(((planned + budget) / ((trip.days?.length || 1) + 1)) * 100));
};
const safeHttpUrl = (value) => {
  try {
    const url = new URL(String(value));
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : '';
  } catch { return ''; }
};
const importanceLabel = (value) => ({ 'must-see': 'Önemli durak', local: 'Yerel seçim', optional: 'Esnek durak' }[value] || '');

const state = {
  session: null,
  trips: [],
  route: 'home',
  activeTripId: null,
  activeDayId: null,
  editingBudget: null,
  tripsUserId: null,
  filter: 'all',
  syncing: false,
  nearbyResults: [],
  nearbyCategory: '',
  placeSuggestions: [],
  connections: [],
  profileResults: []
};

const places = createPlacesClient();
let placeSearchController;

let toastTimer;
let modalReturnFocus = null;
let loadingReturnFocus = null;

function toast(message, tone = 'ok') {
  const element = $('#toast');
  $('span', element).textContent = message;
  element.dataset.tone = tone;
  element.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove('show'), 2800);
}

function setSync(label, tone = 'ready') {
  const element = $('#syncState');
  element.className = `sync-state ${tone === 'ready' ? '' : tone}`.trim();
  $('em', element).textContent = label;
}

function focusableElements(container) {
  return $$('a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])', container)
    .filter((element) => !element.hidden && element.getAttribute('aria-hidden') !== 'true' && element.offsetParent !== null);
}

function syncInteractionBlock() {
  const shell = $('#appShell');
  const blocked = Boolean($('.modal.open') || $('#loadingOverlay')?.classList.contains('open'));
  shell.inert = blocked;
  if (blocked) shell.setAttribute('aria-hidden', 'true');
  else shell.removeAttribute('aria-hidden');
}

function focusReturnTarget(candidate) {
  return candidate?.isConnected && candidate.offsetParent !== null && !candidate.closest('[inert]')
    ? candidate
    : $('#mainContent');
}

function openModal(id) {
  const current = $('.modal.open');
  if (current) closeModal(current, false);
  const modal = $(id);
  if (!modal) return;
  modalReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  modal.inert = false;
  modal.classList.add('open');
  modal.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
  syncInteractionBlock();
  icons();
  const focusTarget = $('[data-initial-focus]', modal) || focusableElements($('.modal-panel', modal))[0];
  setTimeout(() => focusTarget?.focus(), 10);
}

function closeModal(modal = $('.modal.open'), restoreFocus = true) {
  if (!modal) return;
  modal.classList.remove('open');
  modal.setAttribute('aria-hidden', 'true');
  modal.inert = true;
  document.body.style.overflow = '';
  syncInteractionBlock();
  if (restoreFocus) {
    const target = focusReturnTarget(modalReturnFocus);
    modalReturnFocus = null;
    setTimeout(() => target?.focus(), 0);
  }
}

function setLoading(open) {
  const overlay = $('#loadingOverlay');
  if (open) {
    loadingReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    overlay.inert = false;
    overlay.classList.add('open');
    overlay.setAttribute('aria-hidden', 'false');
    overlay.setAttribute('aria-busy', 'true');
    overlay.focus();
  } else {
    overlay.classList.remove('open');
    overlay.setAttribute('aria-hidden', 'true');
    overlay.setAttribute('aria-busy', 'false');
    overlay.inert = true;
  }
  syncInteractionBlock();
  if (!open && !$('.modal.open')) {
    const target = focusReturnTarget(loadingReturnFocus);
    loadingReturnFocus = null;
    setTimeout(() => target?.focus(), 0);
  }
}

function activeTrip() {
  return state.trips.find((trip) => trip.id === state.activeTripId) || state.trips[0] || null;
}

function nextTrip() {
  const today = isoToday();
  return [...state.trips].filter((trip) => trip.endDate >= today).sort((a, b) => a.startDate.localeCompare(b.startDate))[0] || state.trips[0] || null;
}

function tripStatus(trip) {
  const today = isoToday();
  if (trip.endDate < today) return 'past';
  if (trip.startDate <= today && trip.endDate >= today) return 'active';
  return trip.status === 'planning' ? 'planning' : 'upcoming';
}

const statusLabel = (trip) => ({ active: 'SEYAHATTESİN', past: 'TAMAMLANDI', planning: 'HAZIRLANIYOR', upcoming: 'YAKLAŞIYOR' }[tripStatus(trip)]);

function showRoute(route, { tripId } = {}) {
  if (tripId) {
    state.activeTripId = tripId;
    state.editingBudget = null;
    state.activeDayId = state.trips.find((trip) => trip.id === tripId)?.days?.[0]?.id || null;
    route = 'trip';
  }
  state.route = route;
  $$('.page').forEach((page) => page.classList.toggle('active', page.dataset.page === route));
  $$('[data-route]').forEach((button) => button.classList.toggle('active', button.dataset.route === route));
  if (route === 'trip') renderTripDetail();
  if (route === 'trips') renderTrips();
  if (route === 'memories') renderMemories();
  if (route === 'settings') renderSettings();
  if (route === 'friends') void renderFriends();
  window.scrollTo({ top: 0, behavior: 'smooth' });
  icons();
}

function renderAccount() {
  const user = state.session?.user;
  const button = $('#accountButton');
  const name = user?.user_metadata?.full_name || user?.user_metadata?.name || user?.email || 'Misafir modunda';
  const initials = name.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toLocaleUpperCase('tr-TR');
  $('.account-avatar', button).textContent = user ? initials : 'YÖ';
  $('.account-copy strong', button).textContent = user ? name : 'Misafir modunda';
  $('.account-copy small', button).textContent = user ? 'Bulut senkronu açık' : 'Bulut senkronu kapalı';

  const foot = $('#sidebarFoot');
  const trip = nextTrip();
  foot.innerHTML = trip ? `<div class="side-next"><span class="eyebrow">SIRADAKİ SEYAHAT</span><strong>${escapeHtml(trip.destination)}</strong><small>${formatRange(trip)} · plan %${completion(trip)}</small><div class="side-progress"><i style="width:${completion(trip)}%"></i></div></div>` : '';
}

function renderHome() {
  const date = new Intl.DateTimeFormat('tr-TR', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date());
  $('#todayLabel').textContent = date.toLocaleUpperCase('tr-TR');
  const hour = new Date().getHours();
  $('#greeting').textContent = hour < 12 ? 'Günaydın. Nereye gidiyoruz?' : hour < 18 ? 'Yeni bir yer görelim mi?' : 'Sıradaki yolculuğu düşünelim.';
  const dateInputs = $$('input[type="date"]');
  dateInputs.forEach((input) => { input.min = isoToday(); if (!input.value) input.value = new Date(Date.now() + 86400000 * 7).toISOString().slice(0, 10); });

  const trip = nextTrip();
  const card = $('#activeTripCard');
  const todayCard = $('#todayCard');
  if (!trip) {
    card.innerHTML = `<div class="empty-mini"><div><i data-lucide="map"></i><h3>İlk seyahatini aç.</h3><p>Şehir, tarih ve birkaç tercih yeterli.</p><button class="primary-button" data-open="planner">Plan oluşturmaya başla</button></div></div>`;
    todayCard.innerHTML = `<div class="empty-mini"><div><i data-lucide="calendar-check"></i><h3>Günün burada görünecek.</h3><p>Bir plan oluşturduğunda ilk durakların hazır olur.</p></div></div>`;
    $('#homeLower').innerHTML = '';
    icons();
    return;
  }

  const firstDay = trip.days?.find((day) => day.stops?.length) || trip.days?.[0];
  const stops = firstDay?.stops || [];
  card.innerHTML = `<div class="card-top"><div><span class="eyebrow">${statusLabel(trip)}</span><h2>${escapeHtml(trip.destination)} · ${escapeHtml(firstDay?.title || 'Plan')}</h2></div><button class="card-menu" data-trip-open="${escapeHtml(trip.id)}" aria-label="Planı aç"><i data-lucide="arrow-up-right"></i></button></div><div class="route-preview" aria-label="Rota önizlemesi"><span class="route-line"></span><span class="route-pin p1">1</span><span class="route-pin p2">2</span><span class="route-pin p3">3</span></div><div class="route-meta"><span><i data-lucide="calendar-days"></i><strong>${dayCountText(trip)}</strong></span><span><i data-lucide="map-pin"></i><strong>${stops.length}</strong> ilk gün durağı</span><span><i data-lucide="circle-check"></i><strong>%${completion(trip)}</strong> hazır</span></div>`;

  todayCard.innerHTML = `<div class="card-top"><div><span class="eyebrow">İLK GÜN</span><h2>Günün planı</h2></div><span class="weather-pill">${escapeHtml(trip.pace || 'Rahat')} tempo</span></div>${stops.length ? `<div class="today-list">${stops.slice(0, 5).map((stop, index) => `<div class="today-stop"><time>${escapeHtml(stop.time || '—')}</time><span>${index + 1}</span><div><strong>${escapeHtml(stop.title)}</strong><small>${escapeHtml(stop.category || '')}${stop.duration ? ` · ${escapeHtml(stop.duration)}` : ''}</small></div></div>`).join('')}</div>` : `<div class="empty-mini"><div><i data-lucide="map-pin-plus"></i><h3>İlk gün henüz boş.</h3><p>Planı açıp ilk durağını ekleyebilirsin.</p><button class="secondary-button" data-trip-open="${escapeHtml(trip.id)}">Günü planla</button></div></div>`}`;

  const plannedDays = trip.days.filter((day) => day.stops?.length).length;
  $('#homeLower').innerHTML = `<div class="section-row"><div><span class="eyebrow">YOLA ÇIKMADAN</span><h2 class="serif">Planın gerçekten hazır mı?</h2></div></div><div class="readiness-grid"><article class="readiness-card ${plannedDays === trip.days.length ? 'complete' : ''}"><span><i data-lucide="route"></i></span><h3>Günlük akış</h3><p>${plannedDays}/${trip.days.length} günün durakları var. Boş günleri yolda bırakabilir veya şimdiden doldurabilirsin.</p></article><article class="readiness-card ${trip.budgetTotal > 0 ? 'complete' : ''}"><span><i data-lucide="wallet-cards"></i></span><h3>Bütçe sınırı</h3><p>${trip.budgetTotal > 0 ? `${escapeHtml(trip.currency)} ${Number(trip.budgetTotal).toLocaleString('tr-TR')} toplam bütçe belirlendi.` : 'Bir üst sınır belirle; harcamaların yolculuk boyunca anlamlı kalsın.'}</p></article><article class="readiness-card"><span><i data-lucide="cloud-download"></i></span><h3>${state.session ? 'Bulutta senkron' : 'Yalnız bu cihazda'}</h3><p>${state.session ? 'Değişikliklerin hesabına kaydedilir ve diğer cihazlarından açılabilir.' : 'Misafir planların bu tarayıcıda kalır. Hesapla buluta taşıyabilirsin.'}</p></article></div>`;
  icons();
}

function renderTrips() {
  const trips = state.trips.filter((trip) => state.filter === 'all' || tripStatus(trip) === state.filter);
  $('#tripGrid').innerHTML = trips.length ? trips.map((trip) => `<button class="trip-card" data-trip-open="${escapeHtml(trip.id)}"><span class="trip-cover" style="background-image:url('${coverUrl(trip)}')"><span class="trip-status">${statusLabel(trip)}</span><span class="trip-date-badge"><strong>${formatDate(trip.startDate, { day: 'numeric', month: 'short' })}</strong><small>${formatDate(trip.endDate, { day: 'numeric', month: 'short', year: 'numeric' })}</small></span></span><span class="trip-card-body"><h3>${escapeHtml(trip.destination)}</h3><p>${escapeHtml(trip.country || trip.style)} · ${formatRange(trip)}</p><span class="trip-card-foot"><span><i data-lucide="calendar-days"></i>${dayCountText(trip)}</span><span><i data-lucide="map-pin"></i>${trip.days.reduce((sum, day) => sum + (day.stops?.length || 0), 0)} durak</span><span><i data-lucide="circle-check"></i>%${completion(trip)}</span></span></span></button>`).join('') : `<div class="empty-state"><i data-lucide="luggage"></i><h2>Bu rafta henüz bir seyahat yok.</h2><p>Yeni bir plan oluştur veya diğer filtrelere göz at.</p><button class="primary-button" data-open="planner"><i data-lucide="plus"></i> Seyahat oluştur</button></div>`;
  icons();
}

function allJournals() {
  return state.trips.flatMap((trip) => (trip.journals || []).map((journal) => ({ ...journal, tripId: trip.id, destination: trip.destination }))).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function renderMemories() {
  const journals = allJournals();
  const latest = journals[0];
  $('#memoryHero').innerHTML = latest ? `<div><span class="eyebrow">SON KAYIT · ${escapeHtml(latest.destination.toLocaleUpperCase('tr-TR'))}</span><h2>${escapeHtml(latest.title)}</h2><p>${escapeHtml(latest.body.slice(0, 150))}${latest.body.length > 150 ? '…' : ''}</p></div>` : `<div><span class="eyebrow">İLK SAYFA</span><h2>Hatırlamak istediğin şeyle başla.</h2><p>Bir günlük notu, yolculuğun sayılardan daha uzun yaşamasını sağlar.</p></div>`;
  $('#journalGrid').innerHTML = journals.length ? journals.map((journal) => `<article class="journal-card"><time>${formatDateTime(journal.createdAt)}</time><h3>${escapeHtml(journal.title)}</h3><p>${escapeHtml(journal.body)}</p><small>${escapeHtml(journal.destination)}</small></article>`).join('') : `<div class="empty-state"><i data-lucide="notebook-pen"></i><h2>Anıların için yer hazır.</h2><p>İlk seyahat notunu yazdığında burada görünür.</p><button class="primary-button" data-open="journal">İlk notu yaz</button></div>`;
  icons();
}

function renderSettings() {
  const user = state.session?.user;
  const name = user?.user_metadata?.full_name || user?.user_metadata?.name || user?.email;
  $('#accountSettings').innerHTML = user ? `<span class="settings-icon"><i data-lucide="cloud-check"></i></span><div><div class="account-profile"><span class="account-avatar">${escapeHtml((name || 'R').slice(0,2).toLocaleUpperCase('tr-TR'))}</span><div><strong>${escapeHtml(name || 'Roamly hesabı')}</strong><small>${escapeHtml(user.email || '')} · senkron açık</small></div></div><p>Seyahatlerin Supabase üzerinde yalnızca hesabın tarafından okunabilir ve düzenlenebilir.</p><button class="secondary-button" data-action="sign-out">Çıkış yap</button></div>` : `<span class="settings-icon"><i data-lucide="cloud"></i></span><div><h2>Bulut senkronu</h2><p>Planlarını bu cihazın dışına taşı, AI planlama kullan ve telefonunda kaldığın yerden devam et.</p><button class="primary-button" data-open="auth">Hesapla devam et</button></div>`;
  icons();
}

const profileCard = (profile, action = '') => {
  const name = profile?.display_name || profile?.handle || 'Gezgin';
  const initials = name.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toLocaleUpperCase('tr-TR');
  return `<article class="profile-card"><span class="profile-avatar">${profile?.avatar_url ? `<img src="${escapeHtml(profile.avatar_url)}" alt="">` : escapeHtml(initials)}</span><div><strong>${escapeHtml(name)}</strong><small>@${escapeHtml(profile?.handle || 'roamly')}</small></div>${action}</article>`;
};

async function renderFriends({ refresh = true } = {}) {
  const root = $('#friendsContent');
  if (!root) return;
  if (!state.session) {
    root.innerHTML = `<div class="friends-gate"><span class="brand-symbol large"><i data-lucide="users"></i></span><h2>Arkadaşların gerçek hesaplarla başlar.</h2><p>İstek göndermek ve arkadaşlarını cihazların arasında tutmak için hesabınla devam et.</p><button class="primary-button" data-open="auth">Hesapla devam et</button></div>`;
    icons();
    return;
  }
  if (refresh) {
    root.innerHTML = `<div class="friends-loading"><i data-lucide="loader-circle"></i>Arkadaşların yükleniyor…</div>`;
    icons();
    const sessionAtStart = state.session;
    try {
      await ensureProfile(sessionAtStart);
      const connections = await loadConnections(sessionAtStart);
      if (state.session?.user?.id !== sessionAtStart.user.id) return;
      state.connections = connections;
    } catch (error) {
      if (state.session?.user?.id !== sessionAtStart.user.id) return;
      console.error(error);
      root.innerHTML = `<div class="empty-state"><i data-lucide="wifi-off"></i><h2>Arkadaşlar yüklenemedi.</h2><p>Bağlantını kontrol edip yeniden dene.</p><button class="secondary-button" data-action="reload-friends">Yeniden dene</button></div>`;
      icons();
      return;
    }
  }
  const userId = state.session.user.id;
  const accepted = state.connections.filter((item) => item.status === 'accepted');
  const incoming = state.connections.filter((item) => item.status === 'pending' && item.addressee_id === userId);
  const outgoing = state.connections.filter((item) => item.status === 'pending' && item.requester_id === userId);
  const otherProfile = (connection) => connection.requester_id === userId ? connection.addressee : connection.requester;
  root.innerHTML = `<section class="friend-search-card"><div><span class="eyebrow coral-text">GEZGİN BUL</span><h2>Birlikte gideceğin kişiyi ara.</h2><p>İsim veya Roamly kullanıcı adıyla ara. Sahte örnek profiller göstermiyoruz.</p></div><form id="friendSearchForm"><span class="field"><i data-lucide="search"></i><input name="query" minlength="2" required placeholder="İsim veya @kullanıcıadı" autocomplete="off"></span><button class="primary-button">Ara</button></form>${state.profileResults.length ? `<div class="profile-results">${state.profileResults.map((profile) => profileCard(profile, `<button class="secondary-button" data-action="request-friend" data-profile-id="${escapeHtml(profile.user_id)}"><i data-lucide="user-plus"></i>İstek gönder</button>`)).join('')}</div>` : ''}</section>
  ${incoming.length ? `<section class="friends-section"><span class="eyebrow">BEKLEYEN İSTEKLER · ${incoming.length}</span><div class="friends-grid">${incoming.map((connection) => profileCard(otherProfile(connection), `<span class="profile-actions"><button class="primary-button" data-action="respond-friend" data-connection-id="${escapeHtml(connection.id)}" data-status="accepted">Kabul et</button><button class="secondary-button" data-action="respond-friend" data-connection-id="${escapeHtml(connection.id)}" data-status="declined">Reddet</button></span>`)).join('')}</div></section>` : ''}
  <section class="friends-section"><div class="section-row"><div><span class="eyebrow">ARKADAŞLARIN · ${accepted.length}</span><h2 class="serif">Bir sonraki rota daha iyi birlikte.</h2></div></div><div class="friends-grid">${accepted.length ? accepted.map((connection) => profileCard(otherProfile(connection), `<button class="profile-menu" data-action="remove-friend" data-connection-id="${escapeHtml(connection.id)}" aria-label="Arkadaşlığı kaldır"><i data-lucide="user-minus"></i></button>`)).join('') : `<div class="empty-state"><i data-lucide="users-round"></i><h2>Henüz arkadaşın yok.</h2><p>Yukarıdan gerçek bir Roamly hesabı ara ve bağlantı isteği gönder.</p></div>`}</div></section>
  ${outgoing.length ? `<section class="friends-section"><span class="eyebrow">GÖNDERDİĞİN İSTEKLER</span><div class="friends-grid">${outgoing.map((connection) => profileCard(otherProfile(connection), `<span class="pending-label">Yanıt bekleniyor</span>`)).join('')}</div></section>` : ''}`;
  icons();
}

function stopMapsUrl(stop, trip) {
  const groundedUrl = safeHttpUrl(stop.mapsSourceUrl);
  if (groundedUrl) return groundedUrl;
  const query = hasLocation(stop)
    ? `${stop.lat},${stop.lng}`
    : stop.address || `${stop.title} ${trip.destination}`;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

function renderStop(stop, index, trip, day) {
  const importance = importanceLabel(stop.importance);
  const meal = mealRole(stop);
  const mealLabel = ({ breakfast: 'Kahvaltı', lunch: 'Öğle yemeği', dinner: 'Akşam yemeği' })[meal];
  const bookingLabel = ({ needed: 'Rezervasyon gerekli', booked: 'Rezervasyon tamam' })[stop.bookingStatus];
  const reviews = Number(stop.reviewCount) > 0 ? ` · ${Number(stop.reviewCount).toLocaleString('tr-TR')} değerlendirme` : '';
  const rating = Number(stop.rating) > 0 ? `<span class="stop-badge rating-badge"><i data-lucide="star"></i>${Number(stop.rating).toLocaleString('tr-TR', { maximumFractionDigits: 1 })}${reviews}</span>` : '';
  const travel = Number(stop.travelFromPreviousMinutes) > 0
    ? `<span class="stop-leg"><i data-lucide="footprints"></i>${Number(stop.travelFromPreviousMinutes)} dk · ${Number(stop.travelFromPreviousKm).toLocaleString('tr-TR', { maximumFractionDigits: 1 })} km tahmini yürüyüş</span>`
    : '';
  const mapsSourceUrl = safeHttpUrl(stop.mapsSourceUrl);
  const mapsAttribution = mapsSourceUrl ? `<a class="maps-attribution" href="${escapeHtml(mapsSourceUrl)}" target="_blank" rel="noopener"><span translate="no">Google Maps</span> · ${escapeHtml(stop.mapsSourceName || stop.title)}<i data-lucide="arrow-up-right"></i></a>` : '';
  return `<div class="stop-item"><time class="stop-time">${escapeHtml(stop.time || '—')}</time><span class="stop-dot">${index + 1}</span><article class="stop-card"><div class="stop-content">${travel}<div class="stop-badges">${mealLabel ? `<span class="stop-badge meal-badge"><i data-lucide="utensils"></i>${mealLabel}</span>` : ''}${bookingLabel ? `<span class="stop-badge ${stop.bookingStatus === 'booked' ? 'booked-badge' : 'booking-needed-badge'}"><i data-lucide="calendar-check"></i>${bookingLabel}</span>` : ''}${stop.reminderAt ? '<span class="stop-badge reminder-badge"><i data-lucide="bell-ring"></i>Hatırlatıcı</span>' : ''}${importance ? `<span class="stop-badge importance-${escapeHtml(stop.importance)}">${escapeHtml(importance)}</span>` : ''}${stop.verified ? '<span class="stop-badge verified-badge"><i data-lucide="badge-check"></i>Google Maps yeriyle eşleşti</span>' : ''}${rating}</div><h3>${escapeHtml(stop.title)}</h3>${mapsAttribution}<p class="stop-note">${escapeHtml(stop.notes || stop.address || 'Not eklenmedi.')}</p>${stop.confirmation ? `<p class="stop-insight"><strong>Rezervasyon onayı</strong>${escapeHtml(stop.confirmation)}</p>` : ''}${stop.why ? `<p class="stop-insight"><strong>Neden burada?</strong>${escapeHtml(stop.why)}</p>` : ''}${stop.travelerNote ? `<p class="stop-insight traveler-insight"><strong>Gezginlerden ortak not</strong>${escapeHtml(stop.travelerNote)}</p>` : ''}<small>${escapeHtml(stop.category || 'Durak')}${stop.duration ? ` · ${escapeHtml(stop.duration)}` : ''}${stop.address ? ` · ${escapeHtml(stop.address)}` : ''}</small></div><div class="stop-tools"><button data-action="move-stop" data-stop-id="${escapeHtml(stop.id)}" data-direction="-1" aria-label="Durağı yukarı taşı" ${index === 0 ? 'disabled' : ''}><i data-lucide="arrow-up"></i></button><button data-action="move-stop" data-stop-id="${escapeHtml(stop.id)}" data-direction="1" aria-label="Durağı aşağı taşı" ${index === day.stops.length - 1 ? 'disabled' : ''}><i data-lucide="arrow-down"></i></button><a href="${escapeHtml(stopMapsUrl(stop, trip))}" target="_blank" rel="noopener" aria-label="Google Maps'te aç"><i data-lucide="navigation"></i></a><a href="${escapeHtml(tiktokSearchUrl(stop.title, trip.destination))}" target="_blank" rel="noopener" aria-label="TikTok'ta gezgin videolarını ara"><i data-lucide="search"></i></a><button data-edit-stop="${escapeHtml(stop.id)}" data-day-id="${escapeHtml(day.id)}" aria-label="Durağı düzenle"><i data-lucide="pencil"></i></button></div></article></div>`;
}

function renderEvidenceCard(trip) {
  const sources = (trip.researchSources || []).map((source) => ({ ...source, url: safeHttpUrl(source.url) })).filter((source) => source.url);
  if (!trip.plannerMeta?.researched && !sources.length) return '';
  const verified = Number(trip.plannerMeta?.verifiedPlaces || 0);
  const total = Number(trip.plannerMeta?.totalPlaces || 0);
  return `<section class="trip-side-card evidence-card"><span class="eyebrow">PLAN GÜVENİ</span><h3>Araştırıldı, sonra sıralandı.</h3><p>${escapeHtml(trip.researchSummary || 'Önemli yerler, yerel öneriler ve gezgin deneyimleri kaynaklarla birlikte değerlendirildi.')}</p><div class="evidence-facts"><span><i data-lucide="search-check"></i>Kaynak destekli araştırma</span><span><i data-lucide="map-pinned"></i>${verified}/${total || verified} Maps kaynağıyla eşleşti</span><span><i data-lucide="route"></i>Mahallelere göre rota sıralandı</span></div>${sources.length ? `<div class="source-list">${sources.slice(0, 5).map((source) => `<a href="${escapeHtml(source.url)}" target="_blank" rel="noopener"><span>${escapeHtml(source.title || new URL(source.url).hostname)}<small>${escapeHtml(source.provider || 'Web')}</small></span><i data-lucide="arrow-up-right"></i></a>`).join('')}</div>` : ''}<p class="evidence-caveat"><i data-lucide="info"></i>Saat, bilet ve kapanış bilgilerini gitmeden önce yeniden kontrol et. Gezgin notları tekil alıntı değil, tekrar eden deneyimlerin özetidir.</p></section>`;
}

async function renderTripWeather(trip) {
  const root = $('#tripWeatherCard');
  const center = dayCenter({ stops: trip.days.flatMap((day) => day.stops || []) });
  if (!root || !center) { if (root) root.hidden = true; return; }
  try {
    const forecast = await getTripWeather({ ...center, startDate: trip.startDate, endDate: trip.endDate });
    if (!root.isConnected || activeTrip()?.id !== trip.id || !forecast.length) { root.hidden = true; return; }
    root.innerHTML = `<span class="eyebrow">HAVA DURUMU</span><h3>Valiz ve rota için kısa bakış</h3><div class="weather-days">${forecast.map((day) => `<span><strong>${formatDate(day.date, { weekday: 'short', day: 'numeric' })}</strong><em>${escapeHtml(day.label)}</em><b>${Number(day.max)}° / ${Number(day.min)}°</b><small>%${Number(day.rain)} yağış</small></span>`).join('')}</div><p>Open-Meteo tahmini · Seyahate yaklaşınca yeniden kontrol et.</p>`;
  } catch { if (root.isConnected) root.hidden = true; }
}

function renderTripDetail() {
  const trip = activeTrip();
  if (!trip) { showRoute('trips'); return; }
  const day = trip.days.find((item) => item.id === state.activeDayId) || trip.days[0];
  state.activeDayId = day?.id || null;
  if (!day) return;
  const { spent, budget, progress, others } = budgetSummary(trip);
  const editingBudget = state.editingBudget === trip.id;
  const ready = dayReadiness(day, trip.pace);
  const mapsUrl = googleDayRouteUrl(day);
  const nearby = state.nearbyResults || [];
  const savedPlaces = trip.savedPlaces || [];
  $('#tripDetail').innerHTML = `<section class="trip-hero" style="background-image:url('${coverUrl(trip)}')"><button class="icon-button trip-back" data-route="trips" aria-label="Seyahatlere dön"><i data-lucide="arrow-left"></i></button><div class="trip-hero-tools"><button class="secondary-button" data-action="share-trip"><i data-lucide="share-2"></i><span>Paylaş</span></button><button class="secondary-button" data-action="export-trip"><i data-lucide="download"></i><span>Yedekle</span></button><button class="secondary-button" data-action="delete-trip"><i data-lucide="trash-2"></i><span>Sil</span></button></div><div class="trip-hero-copy"><span class="eyebrow">${statusLabel(trip)} · ${escapeHtml(String(trip.style || '').toLocaleUpperCase('tr-TR'))}</span><h1>${escapeHtml(trip.destination)}</h1><p>${formatRange(trip)} · ${dayCountText(trip)} · ${escapeHtml(trip.pace)} tempo${trip.summary ? ` · ${escapeHtml(trip.summary)}` : ''}</p></div></section>
  <section class="route-studio" aria-label="Rota Stüdyosu"><div class="studio-heading"><div><span class="eyebrow coral-text">ROTA STÜDYOSU · TEK PLAN</span><h2>Günü haritada gör, ritmini burada düzelt.</h2><p>Bu çalışma alanı artık ayrı bir eski uygulamaya gitmez; yaptığın her değişiklik aynı seyahate kaydolur.</p></div><div class="readiness-pill ${ready.complete ? 'complete' : ''}"><i data-lucide="${escapeHtml(ready.complete ? 'circle-check' : 'circle-dashed')}"></i><span><strong>${ready.complete ? 'Gün tamam' : `${ready.stopCount}/${ready.target} durak`}</strong><small>${ready.hasBreakfast ? 'Kahvaltı' : 'Kahvaltı eksik'} · ${ready.hasLunch ? 'Öğle' : 'Öğle eksik'} · ${ready.hasDinner ? 'Akşam' : 'Akşam eksik'}</small></span></div></div>
  <div class="route-map" id="routeMap" role="img" aria-label="Seçili günün rota haritası"></div>
  <div class="studio-toolbar"><button class="secondary-button" data-action="optimize-day"><i data-lucide="route"></i> Rotayı sırala</button><button class="secondary-button" data-action="shift-day" data-minutes="-30"><i data-lucide="clock-arrow-down"></i> 30 dk erkene</button><button class="secondary-button" data-action="shift-day" data-minutes="15"><i data-lucide="clock-arrow-up"></i> +15 dk gecikme</button><button class="secondary-button" data-action="shift-day" data-minutes="30"><i data-lucide="clock-arrow-up"></i> +30 dk gecikme</button>${mapsUrl ? `<a class="primary-button" href="${escapeHtml(mapsUrl)}" target="_blank" rel="noopener"><i data-lucide="navigation"></i> Tam günü Google Maps'te aç</a>` : ''}</div>
  <div class="nearby-studio"><div><span class="eyebrow">YAKINDA NE VAR?</span><h3>Akıştaki boşluğu doğru yerle doldur.</h3></div><div class="nearby-chips">${Object.keys(NEARBY_CATEGORIES).map((category) => `<button class="${escapeHtml(state.nearbyCategory === category ? 'active' : '')}" data-action="nearby" data-category="${category}">${({ breakfast: 'Kahvaltı', lunch: 'Öğle', dinner: 'Akşam', cafe: 'Kahve', attractions: 'Gezilecek yerler' })[category]}</button>`).join('')}<a href="${escapeHtml(tiktokSearchUrl(`${day.theme || 'gezilecek yerler'} önerileri`, trip.destination))}" target="_blank" rel="noopener"><i data-lucide="search"></i>TikTok’ta gezgin videoları</a><label class="secondary-button file-button"><i data-lucide="bookmark-plus"></i>Google kayıtlarını getir<input data-google-saved-input type="file" accept="application/json,.json,.geojson"></label></div>${nearby.length ? `<div class="nearby-results">${nearby.map((place, index) => `<article><div><strong>${escapeHtml(place.name)}</strong><small>${escapeHtml(place.address || place.primaryType)} · Google Places</small></div><button class="secondary-button" data-action="add-nearby" data-place-index="${index}"><i data-lucide="plus"></i>Ekle</button></article>`).join('')}</div>` : ''}${savedPlaces.length ? `<div class="saved-places"><div><span class="eyebrow">GOOGLE KAYITLARIN · ${savedPlaces.length}</span><button data-action="clear-saved-places">Listeyi temizle</button></div><div class="nearby-results">${savedPlaces.slice(0, 20).map((place, index) => `<article><div><strong>${escapeHtml(place.name)}</strong><small>${escapeHtml(place.address || 'Kaydedilen yer')}</small></div><button class="secondary-button" data-action="add-saved-place" data-place-index="${index}"><i data-lucide="plus"></i>Güne ekle</button></article>`).join('')}</div></div>` : ''}</div></section>
  <div class="trip-summary"><section class="itinerary-card"><div class="day-tabs">${trip.days.map((item, index) => { const itemReady = dayReadiness(item, trip.pace); return `<button class="day-tab ${item.id === day.id ? 'active' : ''}" data-day-id="${escapeHtml(item.id)}"><strong>${index + 1}. gün ${itemReady.complete ? '✓' : ''}</strong><small>${formatDate(item.date, { weekday: 'short', day: 'numeric', month: 'short' })} · ${itemReady.stopCount}/${itemReady.target}</small></button>`; }).join('')}</div><div class="day-head"><div><h2>${escapeHtml(day.title)}</h2><p>${escapeHtml(day.theme || 'Kendi ritminde keşif')}</p></div><button class="secondary-button" data-open-stop="${escapeHtml(day.id)}"><i data-lucide="plus"></i> Yer ara ve ekle</button></div><div class="stop-list">${day.stops?.length ? day.stops.map((stop, index) => renderStop(stop, index, trip, day)).join('') : `<div class="empty-day"><i data-lucide="map-pin-plus"></i><h3>Bu gün boş kalmamalı.</h3><p>AI planını yeniden oluştur veya arama ile kahvaltıdan akşam yemeğine kadar günü doldur.</p><button class="primary-button" data-open-stop="${escapeHtml(day.id)}">İlk yeri ara</button></div>`}</div></section><aside class="trip-side" aria-label="Seyahat özeti ve araçları">${renderEvidenceCard(trip)}<section class="trip-side-card weather-card" id="tripWeatherCard"><span class="eyebrow">HAVA DURUMU</span><h3>Tahmin yükleniyor…</h3></section><section class="trip-side-card"><div class="card-top"><span class="eyebrow">BÜTÇE</span><button class="icon-button" data-action="edit-budget" aria-label="Bütçeyi ve para birimini düzenle"><i data-lucide="pencil"></i></button></div><h3>Harcamaların</h3><span class="budget-total">${escapeHtml(trip.currency)} ${spent.toLocaleString('tr-TR')}</span><p>${budget ? `${escapeHtml(trip.currency)} ${budget.toLocaleString('tr-TR')} bütçenin %${progress}'i` : 'Henüz bir bütçe sınırı belirlenmedi.'}</p><div class="budget-track"><i style="width:${progress}%"></i></div>${others.length ? `<p class="budget-note"><i data-lucide="info"></i>Toplama ${escapeHtml(trip.currency)} dışındaki harcamalar dahil değil: ${others.map((item) => `${escapeHtml(item.currency)} ${item.amount.toLocaleString('tr-TR')}`).join(', ')}</p>` : ''}${editingBudget ? `<form class="budget-form" id="budgetForm" aria-label="Bütçeyi düzenle"><label class="form-field"><span>Toplam bütçe <em>boş = sınır yok</em></span><input name="total" type="number" min="0" max="1000000000" step="0.01" inputmode="decimal" value="${escapeHtml(budget || '')}" placeholder="0"></label><label class="form-field"><span>Para birimi</span><select name="currency">${currencyOptions(trip.currency).map((code) => `<option ${code === trip.currency ? 'selected' : ''}>${escapeHtml(code)}</option>`).join('')}</select></label><p class="budget-note"><i data-lucide="info"></i>Mevcut harcamalar kendi para biriminde kalır; toplam yalnız seçili para birimindekileri sayar.</p><div class="budget-actions"><button class="secondary-button" type="button" data-action="cancel-budget">Vazgeç</button><button class="primary-button" type="submit">Kaydet</button></div></form>` : ''}<form class="mini-form" id="expenseForm" aria-label="Harcama ekle"><input name="title" required placeholder="Harcama" aria-label="Harcama adı"><input name="amount" type="number" min="0.01" step="0.01" required placeholder="Tutar" aria-label="Harcama tutarı"><button aria-label="Harcama ekle"><i data-lucide="plus"></i></button></form><div class="expense-list">${(trip.expenses || []).map((expense) => `<div class="expense-row"><span>${escapeHtml(expense.title)}</span><strong>${escapeHtml(expense.currency || trip.currency)} ${Number(expense.amount).toLocaleString('tr-TR')}</strong><button data-delete-expense="${escapeHtml(expense.id)}" aria-label="Harcamayı sil"><i data-lucide="x"></i></button></div>`).join('')}</div></section><section class="trip-side-card"><span class="eyebrow">JOURNAL</span><h3>Yoldan bir şey kalsın.</h3><p>${trip.journals?.length ? `${trip.journals.length} not bu seyahatle birlikte saklanıyor.` : 'Henüz bir seyahat notu yok.'}</p><button class="secondary-button" data-open="journal"><i data-lucide="pen-line"></i> Not yaz</button></section></aside></div>`;
  icons();
  requestAnimationFrame(() => renderRouteMap($('#routeMap'), day.stops));
  void renderTripWeather(trip);
}

function renderAll() {
  renderAccount();
  renderHome();
  renderTrips();
  renderMemories();
  renderSettings();
  if (state.route === 'trip') renderTripDetail();
  const select = $('#journalTripSelect');
  select.innerHTML = state.trips.map((trip) => `<option value="${escapeHtml(trip.id)}" ${trip.id === state.activeTripId ? 'selected' : ''}>${escapeHtml(trip.destination)}</option>`).join('');
  icons();
}

// Removes native reminders of deleted stops/trips. Failures are logged and never block the deletion.
async function cancelReminders(ids) {
  if (!window.RoamlyNative?.isNative) return;
  for (const id of ids) {
    try { await window.RoamlyNative.cancelTripReminder(id); } catch (error) { console.error(error); }
  }
}

async function refreshTrips() {
  setSync('Senkronlanıyor', 'syncing');
  const userId = state.session?.user?.id ?? null;
  try {
    const trips = await loadTrips(state.session);
    if ((state.session?.user?.id ?? null) !== userId) return;
    // Trips or reminders removed elsewhere (another device) no longer need their local notification; never compare across accounts.
    const orphaned = state.tripsUserId === userId ? orphanedReminderIds(state.trips, trips) : [];
    state.trips = trips;
    state.tripsUserId = userId;
    cancelReminders(orphaned);
    if (!state.activeTripId || !state.trips.some((trip) => trip.id === state.activeTripId)) state.activeTripId = state.trips[0]?.id || null;
    const pending = pendingTripSyncCount(state.session);
    setSync(state.session
      ? pending ? `${pending} değişiklik eşitlenecek` : navigator.onLine ? 'Bulutta güncel' : 'Çevrimdışı kopya'
      : 'Bu cihazda', pending ? 'syncing' : 'ready');
    renderAll();
  } catch (error) {
    if ((state.session?.user?.id ?? null) !== userId) return;
    console.error(error);
    setSync('Bağlantı gerekli', 'error');
    toast(error.message || 'Seyahatlerin yüklenemedi. Bağlantını kontrol et.', 'error');
  }
}

async function persistTrip(trip, successMessage) {
  setSync('Kaydediliyor', 'syncing');
  const userId = state.session?.user?.id ?? null;
  try {
    const result = await saveTrip(trip, state.session, state.trips);
    if ((state.session?.user?.id ?? null) !== userId) return result.trip;
    state.trips = result.trips;
    state.activeTripId = result.trip.id;
    setSync(result.pendingSync ? 'Çevrimdışı kaydedildi' : state.session ? 'Bulutta güncel' : 'Bu cihazda', result.pendingSync ? 'syncing' : 'ready');
    renderAll();
    if (successMessage) toast(result.pendingSync ? `${successMessage} Bağlantı gelince eşitlenecek.` : successMessage);
    return result.trip;
  } catch (error) {
    console.error(error);
    setSync('Kaydedilemedi', 'error');
    toast(!navigator.onLine && state.session
      ? 'Çevrimdışıyken bulut planındaki değişiklik kaydedilemez. Bağlantı gelince yeniden dene.'
      : 'Değişiklik kaydedilemedi. Bağlantını kontrol edip yeniden dene.', 'error');
    throw error;
  }
}

const planInputFromForm = (form) => {
  const data = new FormData(form);
  return {
    destination: String(data.get('destination') || '').trim(),
    startDate: String(data.get('startDate') || ''),
    days: Number(data.get('days') || 4),
    style: String(data.get('style') || 'Dengeli'),
    pace: String(data.get('pace') || 'Rahat'),
    note: String(data.get('note') || '').trim()
  };
};

async function createManualFromPlanner() {
  const form = $('#plannerForm');
  if (!form.reportValidity()) return;
  const trip = createManualTrip(planInputFromForm(form));
  closeModal();
  await persistTrip(trip, 'Boş seyahat planın hazır.');
  showRoute('trip', { tripId: state.activeTripId });
}

async function runPlanner(input) {
  if (!navigator.onLine) {
    openModal('#plannerModal');
    toast('Çevrimdışıyken AI planı oluşturulamaz. Boş planla devam edebilir veya bağlantı gelince yeniden deneyebilirsin.', 'error');
    return;
  }
  if (!state.session) {
    sessionStorage.setItem('roamly-pending-plan', JSON.stringify(input));
    openModal('#authModal');
    toast('AI planlama için önce hesabınla devam et.');
    return;
  }
  closeModal();
  setLoading(true);
  try {
    const trip = await generateTrip(input);
    const saved = await persistTrip(trip);
    state.activeTripId = saved.id;
    state.activeDayId = saved.days[0]?.id || null;
    showRoute('trip');
    toast(`${saved.destination} planın hazır.`);
  } catch (error) {
    console.error(error);
    const message = String(error?.message || '');
    const userMessage = error?.quota ? error.message : !navigator.onLine || /failed to fetch|network|functionsfetcherror/i.test(message)
      ? 'AI planlama için bağlantı gerekiyor. Boş planla devam edebilir veya bağlantı gelince yeniden deneyebilirsin.'
      : /quota|kota|429|resource exhausted/i.test(message)
        ? 'Bugünkü AI planlama sınırına ulaşıldı. Bir süre sonra yeniden dene veya boş planla devam et.'
        : /timeout|time.?out|zaman aşımı/i.test(message)
          ? 'AI planlama beklenenden uzun sürdü. Yeniden dene veya boş planla devam et.'
          : /configuration|configured|yapılandır/i.test(message)
            ? 'AI planlama şu anda hazır değil. Boş planla devam edebilirsin.'
            : /non-2xx/i.test(message)
              ? 'AI planlama şu anda yanıt vermedi. Yeniden dene veya boş planla devam et.'
              : 'Plan oluşturulamadı. Yeniden dene veya boş planla devam et.';
    toast(userMessage, 'error');
    openModal('#plannerModal');
  } finally {
    setLoading(false);
  }
}

function fillPlanner(input) {
  const form = $('#plannerForm');
  Object.entries(input).forEach(([key, value]) => {
    const field = form.elements.namedItem(key);
    if (!field) return;
    if (field instanceof RadioNodeList) field.value = value;
    else field.value = value;
  });
}

function openStopForm(dayId, stopId) {
  const trip = activeTrip();
  const day = trip?.days.find((item) => item.id === dayId);
  if (!day) return;
  const stop = day.stops.find((item) => item.id === stopId);
  const form = $('#stopForm');
  form.reset();
  form.elements.dayId.value = dayId;
  form.elements.stopId.value = stop?.id || '';
  form.elements.time.value = stop?.time || '10:00';
  form.elements.title.value = stop?.title || '';
  form.elements.category.value = [...form.elements.category.options].some((option) => option.value === stop?.category) ? stop.category : 'Diğer';
  form.elements.address.value = stop?.address || '';
  form.elements.duration.value = stop?.duration || '';
  form.elements.notes.value = stop?.notes || '';
  form.elements.bookingStatus.value = stop?.bookingStatus || 'none';
  form.elements.confirmation.value = stop?.confirmation || '';
  form.elements.reminderAt.value = stop?.reminderAt ? String(stop.reminderAt).slice(0, 16) : '';
  form.elements.placeId.value = stop?.placeId || '';
  form.elements.lat.value = coordinate(stop?.lat) ?? '';
  form.elements.lng.value = coordinate(stop?.lng) ?? '';
  form.elements.provider.value = stop?.provider || '';
  form.elements.googleMapsUrl.value = stop?.googleMapsUrl || stop?.mapsSourceUrl || '';
  form.elements.rating.value = stop?.rating ?? '';
  form.elements.reviewCount.value = stop?.reviewCount ?? '';
  state.placeSuggestions = [];
  $('#placeSuggestions').innerHTML = '';
  $('#stopTitle').textContent = stop ? 'Durağı düzenle' : 'Yeni durak';
  $('[data-action="delete-stop"]', form).classList.toggle('hidden', !stop);
  openModal('#stopModal');
}

function renderPlaceSuggestions() {
  const root = $('#placeSuggestions');
  if (!root) return;
  root.innerHTML = state.placeSuggestions.map((place, index) => `<button type="button" role="option" data-place-suggestion="${index}"><span><strong>${escapeHtml(place.name)}</strong><small>${escapeHtml(place.address || 'Ayrıntıları görmek için seç')}</small></span><em>Google</em></button>`).join('');
}

function applyPlaceToStopForm(place) {
  const form = $('#stopForm');
  form.elements.title.value = place.name || '';
  form.elements.address.value = place.address || '';
  form.elements.placeId.value = place.id || '';
  form.elements.lat.value = place.lat ?? '';
  form.elements.lng.value = place.lng ?? '';
  form.elements.provider.value = place.provider || '';
  form.elements.googleMapsUrl.value = place.googleMapsUrl || '';
  form.elements.rating.value = place.rating ?? '';
  form.elements.reviewCount.value = place.reviewCount ?? '';
  $('#placeProviderNote').textContent = place.provider === 'google' ? 'Google Places sonucu seçildi.' : 'Kayıtlı yer seçildi.';
  state.placeSuggestions = [];
  renderPlaceSuggestions();
}

const searchStopPlaces = debounce(async (query) => {
  placeSearchController?.abort();
  placeSearchController = new AbortController();
  if (String(query).trim().length < 3) { state.placeSuggestions = []; renderPlaceSuggestions(); return; }
  if (!state.session) { state.placeSuggestions = []; renderPlaceSuggestions(); $('#placeProviderNote').textContent = placeSearchMessage('signed_out'); return; }
  try {
    $('#placeProviderNote').textContent = 'Yerler aranıyor…';
    state.placeSuggestions = await places.autocomplete(`${query} ${activeTrip()?.destination || ''}`, { limit: 7, locationBias: dayCenter(activeTrip()?.days.find((item) => item.id === state.activeDayId)), signal: placeSearchController.signal });
    renderPlaceSuggestions();
    $('#placeProviderNote').textContent = 'Google Places sonuçları';
  } catch (error) {
    if (error.name !== 'AbortError') { state.placeSuggestions = []; renderPlaceSuggestions(); $('#placeProviderNote').textContent = placeSearchMessage(error); }
  }
}, 300);

document.addEventListener('click', async (event) => {
  const control = event.target.closest('button, a');
  if (!control) return;
  if (control.dataset.route) { event.preventDefault(); showRoute(control.dataset.route); return; }
  if (control.dataset.open) {
    event.preventDefault();
    if (control.dataset.open === 'planner') openModal('#plannerModal');
    if (control.dataset.open === 'journal') {
      if (!state.trips.length) { toast('Önce bir seyahat oluştur.'); return; }
      renderAll(); openModal('#journalModal');
    }
    if (control.dataset.open === 'auth') {
      if (state.session) showRoute('settings');
      else openModal('#authModal');
    }
    if (control.dataset.open === 'locals') {
      const email = state.session?.user?.email || '';
      $('#localsForm').elements.email.value = email;
      openModal('#localsModal');
    }
    return;
  }
  if (control.dataset.close === 'modal') { closeModal(); return; }
  if (control.dataset.tripOpen) { showRoute('trip', { tripId: control.dataset.tripOpen }); return; }
  if (control.dataset.dayId && control.classList.contains('day-tab')) { state.activeDayId = control.dataset.dayId; renderTripDetail(); return; }
  if (control.dataset.openStop) { openStopForm(control.dataset.openStop); return; }
  if (control.dataset.editStop) { openStopForm(control.dataset.dayId, control.dataset.editStop); return; }
  if (control.dataset.placeSuggestion !== undefined) {
    const suggestion = state.placeSuggestions[Number(control.dataset.placeSuggestion)];
    if (!suggestion) return;
    try {
      applyPlaceToStopForm(suggestion.provider === 'google' && (suggestion.lat === null || suggestion.lng === null)
        ? await places.details(suggestion, { query: suggestion.name })
        : suggestion);
    } catch (error) { console.error(error); toast(placeSearchMessage(error), 'error'); }
    return;
  }
  if (control.dataset.filter) {
    state.filter = control.dataset.filter;
    $$('#tripFilters button').forEach((button) => button.classList.toggle('active', button === control));
    renderTrips();
    return;
  }

  const action = control.dataset.action;
  if (action === 'manual-trip') await createManualFromPlanner();
  if (action === 'edit-budget' || action === 'cancel-budget') {
    state.editingBudget = action === 'edit-budget' ? state.activeTripId : null;
    renderTripDetail();
  }
  if (action === 'optimize-day') {
    const trip = activeTrip();
    const index = trip.days.findIndex((item) => item.id === state.activeDayId);
    const optimized = optimizeDay(trip.days[index]);
    if (optimized === trip.days[index]) { toast('Rotayı sıralamak için en az iki konumlu durak gerekli.'); return; }
    trip.days[index] = optimized;
    await persistTrip(trip, 'Rota öğün saatlerini koruyarak yakınlığa göre sıralandı.');
  }
  if (action === 'shift-day') {
    const trip = activeTrip();
    const index = trip.days.findIndex((item) => item.id === state.activeDayId);
    trip.days[index] = shiftDay(trip.days[index], Number(control.dataset.minutes));
    await persistTrip(trip, 'Günün saatleri güncellendi.');
  }
  if (action === 'move-stop') {
    const trip = activeTrip();
    const index = trip.days.findIndex((item) => item.id === state.activeDayId);
    trip.days[index] = moveStop(trip.days[index], control.dataset.stopId, Number(control.dataset.direction));
    await persistTrip(trip, 'Durak sırası güncellendi.');
  }
  if (action === 'nearby') {
    const trip = activeTrip();
    const day = trip.days.find((item) => item.id === state.activeDayId);
    const center = dayCenter(day);
    if (!center) { toast('Yakındakileri bulmak için önce aramadan konumlu bir durak ekle.', 'error'); return; }
    if (!state.session) { toast(placeSearchMessage('signed_out'), 'error'); return; }
    state.nearbyCategory = control.dataset.category;
    state.nearbyResults = [];
    renderTripDetail();
    try {
      state.nearbyResults = await places.nearby({ ...center, category: state.nearbyCategory, radiusMeters: 1800, limit: 8 });
      renderTripDetail();
      if (!state.nearbyResults.length) toast('Yakında bu kategoride bir yer bulunamadı.');
    } catch (error) { console.error(error); toast(placeSearchMessage(error), 'error'); }
  }
  if (action === 'add-nearby') {
    const place = state.nearbyResults[Number(control.dataset.placeIndex)];
    if (!place) return;
    openStopForm(state.activeDayId);
    applyPlaceToStopForm(place);
    const category = ({ breakfast: 'Kahvaltı', lunch: 'Öğle yemeği', dinner: 'Akşam yemeği', cafe: 'Kahve', attractions: 'Tarih' })[state.nearbyCategory] || 'Diğer';
    $('#stopForm').elements.category.value = category;
    $('#stopForm').elements.time.value = ({ breakfast: '08:30', lunch: '13:00', dinner: '19:30', cafe: '16:00', attractions: '10:30' })[state.nearbyCategory] || '10:00';
  }
  if (action === 'add-saved-place') {
    const place = activeTrip()?.savedPlaces?.[Number(control.dataset.placeIndex)];
    if (!place) return;
    openStopForm(state.activeDayId);
    applyPlaceToStopForm(place);
  }
  if (action === 'clear-saved-places') {
    const trip = activeTrip();
    trip.savedPlaces = [];
    await persistTrip(trip, 'Google kayıtları bu seyahatten kaldırıldı.');
  }
  if (action === 'delete-stop') {
    const form = $('#stopForm');
    const trip = activeTrip();
    const day = trip.days.find((item) => item.id === form.elements.dayId.value);
    const removedReminders = reminderIdsForStops(day.stops.filter((stop) => stop.id === form.elements.stopId.value));
    day.stops = day.stops.filter((stop) => stop.id !== form.elements.stopId.value);
    closeModal();
    await persistTrip(trip, 'Durak silindi.');
    await cancelReminders(removedReminders);
    renderTripDetail();
  }
  if (action === 'delete-trip') {
    const trip = activeTrip();
    if (!trip || !window.confirm(`${trip.destination} seyahatini kalıcı olarak silmek istiyor musun?`)) return;
    try {
      state.trips = await deleteTrip(trip.id, state.session, state.trips);
      await cancelReminders(reminderIdsForTrip(trip));
      state.activeTripId = state.trips[0]?.id || null;
      renderAll();
      showRoute('trips');
      toast('Seyahat silindi.');
    } catch (error) { console.error(error); toast('Seyahat silinemedi.', 'error'); }
  }
  if (action === 'export-trip') {
    const trip = activeTrip();
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([serializeTrip(trip)], { type: 'application/json' }));
    const slug = trip.destination.toLocaleLowerCase('tr-TR').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'seyahat';
    link.download = `${slug}-roamly.json`;
    link.click();
    URL.revokeObjectURL(link.href);
  }
  if (action === 'share-trip') {
    const trip = activeTrip();
    const stopCount = trip.days.reduce((sum, day) => sum + (day.stops?.length || 0), 0);
    const shareData = recapShareOptions({ title: `${trip.destination} · Roamly`, text: `${formatRange(trip)} · ${trip.days.length} gün · ${stopCount} durak. ${trip.summary || ''}`.trim(), url: window.RoamlyNative?.isNative ? undefined : location.origin });
    try {
      if (window.RoamlyNative?.isNative) await window.RoamlyNative.shareRecap(shareData);
      else if (navigator.share) await navigator.share(shareData);
      else { await navigator.clipboard.writeText([shareData.title, shareData.text, shareData.url].filter(Boolean).join('\n')); toast('Seyahat özeti panoya kopyalandı.'); }
    } catch (error) { if (error?.name !== 'AbortError') { console.error(error); toast('Seyahat özeti paylaşılamadı.', 'error'); } }
  }
  if (action === 'export-data') {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([serializeBackup(state.trips)], { type: 'application/json' }));
    link.download = `roamly-yedek-${isoToday()}.json`;
    link.click();
    URL.revokeObjectURL(link.href);
  }
  if (action === 'reload-friends') await renderFriends();
  if (action === 'request-friend') {
    try { await requestConnection(control.dataset.profileId, state.session); state.profileResults = []; await renderFriends(); toast('Arkadaşlık isteği gönderildi.'); }
    catch (error) { console.error(error); toast(error.message || 'İstek gönderilemedi.', 'error'); }
  }
  if (action === 'respond-friend') {
    try { await respondToConnection(control.dataset.connectionId, control.dataset.status, state.session); await renderFriends(); toast(control.dataset.status === 'accepted' ? 'Artık arkadaşsınız.' : 'İstek reddedildi.'); }
    catch (error) { console.error(error); toast(error.message || 'İstek güncellenemedi.', 'error'); }
  }
  if (action === 'remove-friend') {
    if (!window.confirm('Bu arkadaşlığı kaldırmak istiyor musun?')) return;
    try { await removeConnection(control.dataset.connectionId, state.session); await renderFriends(); toast('Arkadaşlık kaldırıldı.'); }
    catch (error) { console.error(error); toast(error.message || 'Arkadaşlık kaldırılamadı.', 'error'); }
  }
  if (action === 'sign-in-google') {
    if (!navigator.onLine) { toast('Giriş yapmak için internet bağlantısı gerekiyor.', 'error'); return; }
    const { data, error } = await startGoogleOAuth(location.href);
    if (!error && data?.url && window.Capacitor?.isNativePlatform?.()) {
      const { Browser } = await import('@capacitor/browser');
      await Browser.open({ url: data.url, presentationStyle: 'popover' });
    }
    if (error) toast(error.message, 'error');
  }
  if (action === 'sign-out') {
    await supabase.auth.signOut();
    sessionStorage.removeItem(PENDING_PLAN_KEY);
    await applySession(null);
    showRoute('home');
    toast('Çıkış yapıldı. Misafir modundasın.');
  }
  if (control.dataset.deleteExpense) {
    const trip = activeTrip();
    trip.expenses = trip.expenses.filter((expense) => expense.id !== control.dataset.deleteExpense);
    await persistTrip(trip, 'Harcama silindi.');
    renderTripDetail();
  }
});

$('#quickPlanForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  fillPlanner({ destination: data.get('destination'), startDate: data.get('startDate'), days: data.get('days') });
  openModal('#plannerModal');
});

$('#plannerForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  await runPlanner(planInputFromForm(event.currentTarget));
});

$('#stopForm').elements.title.addEventListener('input', (event) => {
  const form = event.currentTarget.form;
  for (const name of ['placeId', 'lat', 'lng', 'provider', 'googleMapsUrl', 'rating', 'reviewCount']) form.elements[name].value = '';
  searchStopPlaces(event.currentTarget.value);
});

$('#stopForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  const trip = activeTrip();
  const day = trip.days.find((item) => item.id === data.get('dayId'));
  const stopId = data.get('stopId') || uid();
  const stop = {
    id: stopId,
    title: String(data.get('title')).trim(),
    time: String(data.get('time')),
    category: String(data.get('category')),
    address: String(data.get('address') || '').trim(),
    notes: String(data.get('notes') || '').trim(),
    bookingStatus: String(data.get('bookingStatus') || 'none'),
    confirmation: String(data.get('confirmation') || '').trim(),
    reminderAt: String(data.get('reminderAt') || ''),
    duration: String(data.get('duration') || '').trim().slice(0, 40),
    mealRole: ({ Kahvaltı: 'Breakfast', 'Öğle yemeği': 'Lunch', 'Akşam yemeği': 'Dinner' })[String(data.get('category'))] || 'None',
    placeId: String(data.get('placeId') || ''),
    lat: coordinate(data.get('lat')),
    lng: coordinate(data.get('lng')),
    provider: String(data.get('provider') || ''),
    googleMapsUrl: String(data.get('googleMapsUrl') || ''),
    mapsSourceUrl: String(data.get('googleMapsUrl') || ''),
    rating: data.get('rating') === '' ? null : Number(data.get('rating')),
    reviewCount: data.get('reviewCount') === '' ? null : Number(data.get('reviewCount')),
    verified: String(data.get('provider')) === 'google'
  };
  const existingIndex = day.stops.findIndex((item) => item.id === stopId);
  const previousReminder = existingIndex >= 0 ? day.stops[existingIndex].reminderAt : '';
  if (existingIndex >= 0) day.stops[existingIndex] = { ...day.stops[existingIndex], ...stop };
  else day.stops.push(stop);
  day.stops.sort((a, b) => String(a.time).localeCompare(String(b.time)));
  closeModal();
  await persistTrip(trip, existingIndex >= 0 ? 'Durak güncellendi.' : 'Durak rotana eklendi.');
  if (window.RoamlyNative?.isNative && previousReminder !== stop.reminderAt) {
    const reminderId = reminderIdFor(stop.id);
    try {
      if (previousReminder) await window.RoamlyNative.cancelTripReminder(reminderId);
      if (stop.reminderAt && new Date(stop.reminderAt).getTime() > Date.now()) {
        await window.RoamlyNative.scheduleTripReminder({ id: reminderId, title: `${stop.time} · ${stop.title}`, body: stop.address || `${trip.destination} planındaki durağın yaklaşıyor.`, at: stop.reminderAt, extra: { tripId: trip.id, dayId: day.id, stopId: stop.id } });
        toast('Durak kaydedildi ve telefon hatırlatıcısı kuruldu.');
      }
    } catch (error) { console.error(error); toast('Durak kaydedildi; bildirim izni verilmediği için hatırlatıcı kurulamadı.', 'error'); }
  }
  renderTripDetail();
});

document.addEventListener('submit', async (event) => {
  if (event.target.id !== 'friendSearchForm') return;
  event.preventDefault();
  const query = String(new FormData(event.target).get('query') || '').trim();
  try {
    state.profileResults = await searchProfiles(query, state.session);
    await renderFriends({ refresh: false });
    if (!state.profileResults.length) toast('Bu aramayla eşleşen Roamly hesabı bulunamadı.');
  } catch (error) { console.error(error); toast(error.message || 'Arama yapılamadı.', 'error'); }
});

$('#journalForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  const trip = state.trips.find((item) => item.id === data.get('tripId'));
  if (!trip) return;
  trip.journals = [{ id: uid(), title: String(data.get('title')).trim(), body: String(data.get('body')).trim(), createdAt: new Date().toISOString() }, ...(trip.journals || [])];
  closeModal();
  event.currentTarget.reset();
  await persistTrip(trip, 'Not anılarına kaydedildi.');
  showRoute('memories');
});

$('#expenseForm')?.addEventListener('submit', () => {});
document.addEventListener('submit', async (event) => {
  if (event.target.id !== 'expenseForm') return;
  event.preventDefault();
  const data = new FormData(event.target);
  const trip = activeTrip();
  trip.expenses = [...(trip.expenses || []), { id: uid(), title: String(data.get('title')).trim(), category: 'Diğer', amount: Number(data.get('amount')), currency: trip.currency, createdAt: new Date().toISOString() }];
  await persistTrip(trip, 'Harcama eklendi.');
  renderTripDetail();
});

document.addEventListener('submit', async (event) => {
  if (event.target.id !== 'budgetForm') return;
  event.preventDefault();
  const data = new FormData(event.target);
  const trip = activeTrip();
  const next = applyBudgetSettings(trip, { total: String(data.get('total') || ''), currency: String(data.get('currency') || '') });
  if (next.error) { toast(next.error, 'error'); return; }
  state.editingBudget = null;
  try { await persistTrip({ ...trip, budgetTotal: next.budgetTotal, currency: next.currency, expenses: next.expenses }, 'Bütçe güncellendi.'); } catch { state.editingBudget = trip.id; }
  renderTripDetail();
});

$('#emailAuthForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const email = String(new FormData(event.currentTarget).get('email')).trim();
  if (!navigator.onLine) { toast('E-posta bağlantısı göndermek için internet gerekiyor.', 'error'); return; }
  const { error } = await sendEmailSignInLink(email, location.href);
  if (error) toast(error.message, 'error');
  else { closeModal(); toast('Giriş bağlantısı e-postana gönderildi.'); }
});

$('#localsForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  try {
    await joinLocalsWaitlist({ email: String(data.get('email')).trim(), city: String(data.get('city')).trim(), note: String(data.get('note') || '').trim() }, state.session);
    closeModal();
    event.currentTarget.reset();
    toast('Erken erişim listesine katıldın.');
  } catch (error) { console.error(error); toast('Kayıt alınamadı. Lütfen tekrar dene.', 'error'); }
});

$('#importInput').addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    if (file.size > BACKUP_MAX_BYTES) { toast(backupErrorMessage({ code: 'too_large' }), 'error'); return; }
    let trips;
    try { ({ trips } = parseBackup(await file.text())); } catch (error) { toast(backupErrorMessage(error), 'error'); return; }
    let saved = 0;
    try { for (const trip of trips) { await persistTrip(trip); saved += 1; } } catch { /* persistTrip already reported the failure */ }
    renderAll();
    if (saved === trips.length) toast(`${saved} seyahat içe aktarıldı.`);
    else toast(`${saved}/${trips.length} seyahat içe aktarıldı; kalanlar kaydedilemedi.`, 'error');
  } finally { event.target.value = ''; }
});

document.addEventListener('change', async (event) => {
  if (!event.target.matches('[data-google-saved-input]')) return;
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const places = parseGoogleSavedPlaces(JSON.parse(await file.text()));
    if (!places.length) throw new Error('no places');
    const trip = activeTrip();
    const existing = new Set((trip.savedPlaces || []).map((place) => `${place.name}|${place.lat}|${place.lng}`));
    trip.savedPlaces = [...(trip.savedPlaces || []), ...places.filter((place) => !existing.has(`${place.name}|${place.lat}|${place.lng}`))].slice(0, 500);
    await persistTrip(trip, `${places.length} Google kaydı seyahatine getirildi.`);
  } catch (error) { console.error(error); toast('Bu dosyada okunabilir Google kayıtlı yerleri bulunamadı.', 'error'); }
  event.target.value = '';
});

document.addEventListener('keydown', (event) => {
  const modal = $('.modal.open');
  if (!modal) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    closeModal(modal);
    return;
  }
  if (event.key !== 'Tab') return;
  const panel = $('.modal-panel', modal);
  const focusable = focusableElements(panel);
  if (!focusable.length) {
    event.preventDefault();
    panel.focus();
    return;
  }
  const first = focusable[0];
  const last = focusable.at(-1);
  if (event.shiftKey && (document.activeElement === first || !panel.contains(document.activeElement))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (document.activeElement === last || !panel.contains(document.activeElement))) {
    event.preventDefault();
    first.focus();
  }
});

let reportedSyncFailures = { userId: null, count: 0 };
function reportSyncFailures() {
  if (!state.session) return;
  const userId = state.session.user.id;
  const failed = failedTripSyncCount(state.session);
  const previous = reportedSyncFailures.userId === userId ? reportedSyncFailures.count : 0;
  if (failed) setSync(`${failed} değişiklik eşitlenemedi`, 'error');
  if (failed > previous) toast('Bulut bazı değişiklikleri kabul etmedi. Yerel kopyaları bu cihazda duruyor; seyahati düzenleyip yeniden kaydet.', 'error');
  reportedSyncFailures = { userId, count: failed };
}

function setOnlineState() { document.body.classList.toggle('offline', !navigator.onLine); }
async function handleOnline() {
  setOnlineState();
  if (!state.session) return;
  const pending = pendingTripSyncCount(state.session);
  if (!pending) { await refreshTrips(); reportSyncFailures(); return; }
  setSync('Değişiklikler eşitleniyor', 'syncing');
  try {
    const completed = await flushPendingTripChanges(state.session);
    await refreshTrips();
    reportSyncFailures();
    if (completed) toast(`${completed} çevrimdışı değişiklik bulutla eşitlendi.`);
  } catch (error) {
    console.error(error);
    setSync('Eşitleme bekliyor', 'error');
    toast('Çevrimdışı değişiklikler henüz eşitlenemedi. Tekrar denenecek.', 'error');
    reportSyncFailures();
  }
}
window.addEventListener('online', handleOnline);
window.addEventListener('offline', setOnlineState);
window.addEventListener('roamly:network', (event) => event.detail?.connected ? handleOnline() : setOnlineState());
window.addEventListener('roamly:auth-callback', async (event) => {
  try {
    const { data, error } = await completePkceCallback(event.detail?.url);
    if (error) throw error;
    if (data?.session) await applySession(data.session, { announce: true });
  } catch (error) {
    console.error(error);
    toast('Giriş tamamlanamadı. Lütfen yeniden dene.', 'error');
  }
});
setOnlineState();
registerServiceWorker({ nav: navigator, doc: document, win: window, location });

const userTracker = createUserTracker();
const postSignIn = createPostSignInGuard();

function resetUserState() {
  Object.assign(state, { trips: [], activeTripId: null, activeDayId: null, nearbyResults: [], nearbyCategory: '', placeSuggestions: [], connections: [], profileResults: [] });
}

async function runPostSignIn(session, { announce }) {
  const userId = session.user.id;
  const stillCurrent = () => state.session?.user?.id === userId;
  let migrated = [];
  try { migrated = await migrateGuestTrips(session); } catch (error) { console.warn('Guest trip migration will retry', error); }
  if (!stillCurrent()) return;
  await handleOnline();
  if (!stillCurrent()) return;
  if (announce) toast(migrated.length ? `Hesabın hazır. ${migrated.length} seyahat hesabına taşındı.` : 'Hesabın hazır. Bulut senkronu açıldı.');
  const plan = takePendingPlan(sessionStorage);
  if (plan) await runPlanner(plan);
}

async function applySession(session, { announce = false } = {}) {
  state.session = session || null;
  const { changed, previousUserId, userId } = userTracker.change(session);
  if (!changed) return;
  resetUserState();
  renderAll();
  if (!userId) {
    postSignIn.reset();
    await refreshTrips();
  } else {
    if ($('#authModal')?.classList.contains('open')) closeModal($('#authModal'));
    if (state.route === 'trip') showRoute('trips');
    await postSignIn.run(userId, () => runPostSignIn(session, { announce: announce && previousUserId === null }));
  }
  if (state.route === 'friends') void renderFriends();
}

async function initialize() {
  icons();
  // Supabase holds its auth lock while this callback runs, so defer the work instead of awaiting Supabase inside it.
  supabase.auth.onAuthStateChange((_event, session) => {
    setTimeout(() => { applySession(session, { announce: true }).catch(console.error); }, 0);
  });
  await applySession(await getSession());
}

initialize().catch((error) => {
  console.error(error);
  setSync('Başlatılamadı', 'error');
  toast('Roamly başlatılamadı. Sayfayı yenilemeyi dene.', 'error');
});
