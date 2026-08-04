import './styles.css';
import { ACTIVE_TRIP_STORAGE_KEY } from './src/config.js';
import { COVER_IMAGES, createManualTrip } from './src/data.js';
import { deleteTrip, getSession, joinLocalsWaitlist, loadTrips, migrateGuestTrips, saveTrip, supabase } from './src/repository.js';
import { generateTrip } from './src/planner.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const escapeHtml = (value = '') => String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
const icons = () => window.lucide?.createIcons({ attrs: { 'aria-hidden': 'true' } });
const isoToday = () => new Date().toISOString().slice(0, 10);
const uid = () => crypto.randomUUID();

const formatDate = (value, options = { day: 'numeric', month: 'short' }) => new Intl.DateTimeFormat('tr-TR', options).format(new Date(`${value}T12:00:00`));
const formatRange = (trip) => `${formatDate(trip.startDate)} – ${formatDate(trip.endDate, { day: 'numeric', month: 'short', year: 'numeric' })}`;
const dayCountText = (trip) => `${trip.durationDays || trip.days?.length || 1} gün`;
const coverUrl = (trip) => COVER_IMAGES[trip.coverKey] || COVER_IMAGES.default;
const totalSpent = (trip) => (trip.expenses || []).reduce((sum, expense) => sum + Number(expense.amount || 0), 0);
const completion = (trip) => {
  const planned = (trip.days || []).filter((day) => day.stops?.length).length;
  const budget = Number(trip.budgetTotal) > 0 ? 1 : 0;
  return Math.min(100, Math.round(((planned + budget) / ((trip.days?.length || 1) + 1)) * 100));
};

const state = {
  session: null,
  trips: [],
  route: 'home',
  activeTripId: null,
  activeDayId: null,
  filter: 'all',
  syncing: false
};

let toastTimer;

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

function openModal(id) {
  $$('.modal.open').forEach((modal) => closeModal(modal));
  const modal = $(id);
  if (!modal) return;
  modal.classList.add('open');
  modal.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
  icons();
  const focusTarget = $('input:not([type="hidden"]), textarea, select, button', modal);
  setTimeout(() => focusTarget?.focus(), 10);
}

function closeModal(modal = $('.modal.open')) {
  if (!modal) return;
  modal.classList.remove('open');
  modal.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
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
  card.innerHTML = `<div class="card-top"><div><span class="eyebrow">${statusLabel(trip)}</span><h2>${escapeHtml(trip.destination)} · ${escapeHtml(firstDay?.title || 'Plan')}</h2></div><button class="card-menu" data-trip-open="${trip.id}" aria-label="Planı aç"><i data-lucide="arrow-up-right"></i></button></div><div class="route-preview" aria-label="Rota önizlemesi"><span class="route-line"></span><span class="route-pin p1">1</span><span class="route-pin p2">2</span><span class="route-pin p3">3</span></div><div class="route-meta"><span><i data-lucide="calendar-days"></i><strong>${dayCountText(trip)}</strong></span><span><i data-lucide="map-pin"></i><strong>${stops.length}</strong> ilk gün durağı</span><span><i data-lucide="circle-check"></i><strong>%${completion(trip)}</strong> hazır</span></div>`;

  todayCard.innerHTML = `<div class="card-top"><div><span class="eyebrow">İLK GÜN</span><h2>Günün planı</h2></div><span class="weather-pill">${escapeHtml(trip.pace || 'Rahat')} tempo</span></div>${stops.length ? `<div class="today-list">${stops.slice(0, 5).map((stop, index) => `<div class="today-stop"><time>${escapeHtml(stop.time || '—')}</time><span>${index + 1}</span><div><strong>${escapeHtml(stop.title)}</strong><small>${escapeHtml(stop.category || '')}${stop.duration ? ` · ${escapeHtml(stop.duration)}` : ''}</small></div></div>`).join('')}</div>` : `<div class="empty-mini"><div><i data-lucide="map-pin-plus"></i><h3>İlk gün henüz boş.</h3><p>Planı açıp ilk durağını ekleyebilirsin.</p><button class="secondary-button" data-trip-open="${trip.id}">Günü planla</button></div></div>`}`;

  const plannedDays = trip.days.filter((day) => day.stops?.length).length;
  $('#homeLower').innerHTML = `<div class="section-row"><div><span class="eyebrow">YOLA ÇIKMADAN</span><h2 class="serif">Planın gerçekten hazır mı?</h2></div></div><div class="readiness-grid"><article class="readiness-card ${plannedDays === trip.days.length ? 'complete' : ''}"><span><i data-lucide="route"></i></span><h3>Günlük akış</h3><p>${plannedDays}/${trip.days.length} günün durakları var. Boş günleri yolda bırakabilir veya şimdiden doldurabilirsin.</p></article><article class="readiness-card ${trip.budgetTotal > 0 ? 'complete' : ''}"><span><i data-lucide="wallet-cards"></i></span><h3>Bütçe sınırı</h3><p>${trip.budgetTotal > 0 ? `${trip.currency} ${trip.budgetTotal.toLocaleString('tr-TR')} toplam bütçe belirlendi.` : 'Bir üst sınır belirle; harcamaların yolculuk boyunca anlamlı kalsın.'}</p></article><article class="readiness-card"><span><i data-lucide="cloud-download"></i></span><h3>${state.session ? 'Bulutta senkron' : 'Yalnız bu cihazda'}</h3><p>${state.session ? 'Değişikliklerin hesabına kaydedilir ve diğer cihazlarından açılabilir.' : 'Misafir planların bu tarayıcıda kalır. Hesapla buluta taşıyabilirsin.'}</p></article></div>`;
  icons();
}

function renderTrips() {
  const trips = state.trips.filter((trip) => state.filter === 'all' || tripStatus(trip) === state.filter);
  $('#tripGrid').innerHTML = trips.length ? trips.map((trip) => `<button class="trip-card" data-trip-open="${trip.id}"><span class="trip-cover" style="background-image:url('${coverUrl(trip)}')"><span class="trip-status">${statusLabel(trip)}</span><span class="trip-date-badge"><strong>${formatDate(trip.startDate, { day: 'numeric', month: 'short' })}</strong><small>${formatDate(trip.endDate, { day: 'numeric', month: 'short', year: 'numeric' })}</small></span></span><span class="trip-card-body"><h3>${escapeHtml(trip.destination)}</h3><p>${escapeHtml(trip.country || trip.style)} · ${formatRange(trip)}</p><span class="trip-card-foot"><span><i data-lucide="calendar-days"></i>${dayCountText(trip)}</span><span><i data-lucide="map-pin"></i>${trip.days.reduce((sum, day) => sum + (day.stops?.length || 0), 0)} durak</span><span><i data-lucide="circle-check"></i>%${completion(trip)}</span></span></span></button>`).join('') : `<div class="empty-state"><i data-lucide="luggage"></i><h2>Bu rafta henüz bir seyahat yok.</h2><p>Yeni bir plan oluştur veya diğer filtrelere göz at.</p><button class="primary-button" data-open="planner"><i data-lucide="plus"></i> Seyahat oluştur</button></div>`;
  icons();
}

function allJournals() {
  return state.trips.flatMap((trip) => (trip.journals || []).map((journal) => ({ ...journal, tripId: trip.id, destination: trip.destination }))).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function renderMemories() {
  const journals = allJournals();
  const latest = journals[0];
  $('#memoryHero').innerHTML = latest ? `<div><span class="eyebrow">SON KAYIT · ${escapeHtml(latest.destination.toLocaleUpperCase('tr-TR'))}</span><h2>${escapeHtml(latest.title)}</h2><p>${escapeHtml(latest.body.slice(0, 150))}${latest.body.length > 150 ? '…' : ''}</p></div>` : `<div><span class="eyebrow">İLK SAYFA</span><h2>Hatırlamak istediğin şeyle başla.</h2><p>Bir günlük notu, yolculuğun sayılardan daha uzun yaşamasını sağlar.</p></div>`;
  $('#journalGrid').innerHTML = journals.length ? journals.map((journal) => `<article class="journal-card"><time>${new Intl.DateTimeFormat('tr-TR', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(journal.createdAt))}</time><h3>${escapeHtml(journal.title)}</h3><p>${escapeHtml(journal.body)}</p><small>${escapeHtml(journal.destination)}</small></article>`).join('') : `<div class="empty-state"><i data-lucide="notebook-pen"></i><h2>Anıların için yer hazır.</h2><p>İlk seyahat notunu yazdığında burada görünür.</p><button class="primary-button" data-open="journal">İlk notu yaz</button></div>`;
  icons();
}

function renderSettings() {
  const user = state.session?.user;
  const name = user?.user_metadata?.full_name || user?.user_metadata?.name || user?.email;
  $('#accountSettings').innerHTML = user ? `<span class="settings-icon"><i data-lucide="cloud-check"></i></span><div><div class="account-profile"><span class="account-avatar">${escapeHtml((name || 'R').slice(0,2).toLocaleUpperCase('tr-TR'))}</span><div><strong>${escapeHtml(name || 'Roamly hesabı')}</strong><small>${escapeHtml(user.email || '')} · senkron açık</small></div></div><p>Seyahatlerin Supabase üzerinde yalnızca hesabın tarafından okunabilir ve düzenlenebilir.</p><button class="secondary-button" data-action="sign-out">Çıkış yap</button></div>` : `<span class="settings-icon"><i data-lucide="cloud"></i></span><div><h2>Bulut senkronu</h2><p>Planlarını bu cihazın dışına taşı, AI planlama kullan ve telefonunda kaldığın yerden devam et.</p><button class="primary-button" data-open="auth">Hesapla devam et</button></div>`;
  icons();
}

function renderTripDetail() {
  const trip = activeTrip();
  if (!trip) { showRoute('trips'); return; }
  const day = trip.days.find((item) => item.id === state.activeDayId) || trip.days[0];
  state.activeDayId = day?.id || null;
  const spent = totalSpent(trip);
  const budget = Number(trip.budgetTotal || 0);
  const progress = budget ? Math.min(100, Math.round(spent / budget * 100)) : 0;
  const mapsUrl = (stop) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(stop.address || `${stop.title} ${trip.destination}`)}`;
  $('#tripDetail').innerHTML = `<section class="trip-hero" style="background-image:url('${coverUrl(trip)}')"><button class="icon-button trip-back" data-route="trips" aria-label="Seyahatlere dön"><i data-lucide="arrow-left"></i></button><div class="trip-hero-tools"><button class="secondary-button" data-action="export-trip"><i data-lucide="download"></i><span>Yedekle</span></button><button class="secondary-button" data-action="delete-trip"><i data-lucide="trash-2"></i><span>Sil</span></button></div><div class="trip-hero-copy"><span class="eyebrow">${statusLabel(trip)} · ${escapeHtml(trip.style.toLocaleUpperCase('tr-TR'))}</span><h1>${escapeHtml(trip.destination)}</h1><p>${formatRange(trip)} · ${dayCountText(trip)} · ${escapeHtml(trip.pace)} tempo${trip.summary ? ` · ${escapeHtml(trip.summary)}` : ''}</p></div></section><div class="trip-summary"><section class="itinerary-card"><div class="day-tabs">${trip.days.map((item, index) => `<button class="day-tab ${item.id === day.id ? 'active' : ''}" data-day-id="${item.id}"><strong>${index + 1}. gün</strong><small>${formatDate(item.date, { weekday: 'short', day: 'numeric', month: 'short' })}</small></button>`).join('')}</div><div class="day-head"><div><h2>${escapeHtml(day.title)}</h2><p>${escapeHtml(day.theme || 'Kendi ritminde keşif')}</p></div><button class="secondary-button" data-open-stop="${day.id}"><i data-lucide="plus"></i> Durak ekle</button></div><div class="stop-list">${day.stops?.length ? day.stops.map((stop, index) => `<div class="stop-item"><time class="stop-time">${escapeHtml(stop.time || '—')}</time><span class="stop-dot">${index + 1}</span><article class="stop-card"><div><h3>${escapeHtml(stop.title)}</h3><p>${escapeHtml(stop.notes || stop.address || 'Not eklenmedi.')}</p><small>${escapeHtml(stop.category || 'Durak')}${stop.duration ? ` · ${escapeHtml(stop.duration)}` : ''}</small></div><div class="stop-tools"><a href="${mapsUrl(stop)}" target="_blank" rel="noopener" aria-label="Haritada aç"><i data-lucide="navigation"></i></a><button data-edit-stop="${stop.id}" data-day-id="${day.id}" aria-label="Durağı düzenle"><i data-lucide="pencil"></i></button></div></article></div>`).join('') : `<div class="empty-day"><i data-lucide="map-pin-plus"></i><h3>Bu gün sana ait.</h3><p>İlk durağı ekle veya gelişmiş rota stüdyosunda yerlerini optimize et.</p><button class="primary-button" data-open-stop="${day.id}">İlk durağı ekle</button></div>`}</div></section><aside class="trip-side"><section class="trip-side-card"><span class="eyebrow">BÜTÇE</span><h3>Harcamaların</h3><span class="budget-total">${trip.currency} ${spent.toLocaleString('tr-TR')}</span><p>${budget ? `${trip.currency} ${budget.toLocaleString('tr-TR')} bütçenin %${progress}'i` : 'Henüz bir bütçe sınırı belirlenmedi.'}</p><div class="budget-track"><i style="width:${progress}%"></i></div><form class="mini-form" id="expenseForm"><input name="title" required placeholder="Harcama"><input name="amount" type="number" min="0.01" step="0.01" required placeholder="Tutar"><button aria-label="Harcama ekle"><i data-lucide="plus"></i></button></form><div class="expense-list">${(trip.expenses || []).map((expense) => `<div class="expense-row"><span>${escapeHtml(expense.title)}</span><strong>${escapeHtml(expense.currency || trip.currency)} ${Number(expense.amount).toLocaleString('tr-TR')}</strong><button data-delete-expense="${expense.id}" aria-label="Harcamayı sil"><i data-lucide="x"></i></button></div>`).join('')}</div></section><section class="trip-side-card studio-card"><span class="eyebrow">GELİŞMİŞ ARAÇLAR</span><h3>Rota stüdyosu</h3><p>Durakları sürükle, gerçek haritada gör, yürüyüşleri sırala, rezervasyon ve anılarını aynı planla yönet.</p><button class="primary-button" data-action="open-studio"><i data-lucide="route"></i> Stüdyoyu aç</button></section><section class="trip-side-card"><span class="eyebrow">JOURNAL</span><h3>Yoldan bir şey kalsın.</h3><p>${trip.journals?.length ? `${trip.journals.length} not bu seyahatle birlikte saklanıyor.` : 'Henüz bir seyahat notu yok.'}</p><button class="secondary-button" data-open="journal"><i data-lucide="pen-line"></i> Not yaz</button></section></aside></div>`;
  icons();
}

function renderAll() {
  renderAccount();
  renderHome();
  renderTrips();
  renderMemories();
  renderSettings();
  if (state.route === 'trip') renderTripDetail();
  const select = $('#journalTripSelect');
  select.innerHTML = state.trips.map((trip) => `<option value="${trip.id}" ${trip.id === state.activeTripId ? 'selected' : ''}>${escapeHtml(trip.destination)}</option>`).join('');
  icons();
}

async function refreshTrips() {
  setSync('Senkronlanıyor', 'syncing');
  try {
    state.trips = await loadTrips(state.session);
    if (!state.activeTripId || !state.trips.some((trip) => trip.id === state.activeTripId)) state.activeTripId = state.trips[0]?.id || null;
    setSync(state.session ? 'Bulutta güncel' : 'Bu cihazda', 'ready');
    renderAll();
  } catch (error) {
    console.error(error);
    setSync('Bağlantı hatası', 'error');
    toast('Seyahatlerin yüklenemedi. Bağlantını kontrol et.', 'error');
  }
}

async function persistTrip(trip, successMessage) {
  setSync('Kaydediliyor', 'syncing');
  try {
    const result = await saveTrip(trip, state.session, state.trips);
    state.trips = result.trips;
    state.activeTripId = result.trip.id;
    setSync(state.session ? 'Bulutta güncel' : 'Bu cihazda', 'ready');
    renderAll();
    if (successMessage) toast(successMessage);
    return result.trip;
  } catch (error) {
    console.error(error);
    setSync('Kaydedilemedi', 'error');
    toast('Değişiklik kaydedilemedi.', 'error');
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
  if (!state.session) {
    sessionStorage.setItem('roamly-pending-plan', JSON.stringify(input));
    openModal('#authModal');
    toast('AI planlama için önce hesabınla devam et.');
    return;
  }
  closeModal();
  $('#loadingOverlay').classList.add('open');
  $('#loadingOverlay').setAttribute('aria-hidden', 'false');
  try {
    const trip = await generateTrip(input);
    const saved = await persistTrip(trip);
    state.activeTripId = saved.id;
    state.activeDayId = saved.days[0]?.id || null;
    showRoute('trip');
    toast(`${saved.destination} planın hazır.`);
  } catch (error) {
    console.error(error);
    toast(error.message.includes('non-2xx') ? 'AI servisi henüz yapılandırılmadı. Boş planla devam edebilirsin.' : error.message, 'error');
    openModal('#plannerModal');
  } finally {
    $('#loadingOverlay').classList.remove('open');
    $('#loadingOverlay').setAttribute('aria-hidden', 'true');
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
  form.elements.category.value = stop?.category || 'Kahve';
  form.elements.address.value = stop?.address || '';
  form.elements.notes.value = stop?.notes || '';
  $('#stopTitle').textContent = stop ? 'Durağı düzenle' : 'Yeni durak';
  $('[data-action="delete-stop"]', form).classList.toggle('hidden', !stop);
  openModal('#stopModal');
}

function seedAdvancedStudio(trip) {
  const studioTrip = {
    id: trip.id,
    name: trip.title || trip.destination,
    destination: trip.destination,
    emoji: '🧳',
    tz: 'Europe/Istanbul',
    start: trip.startDate,
    end: trip.endDate,
    participants: [],
    hotel: null,
    days: trip.days.map((day) => ({
      id: day.id,
      date: day.date,
      title: day.title,
      stops: day.stops.map((stop) => ({
        id: stop.id,
        time: stop.time,
        title: stop.title,
        cat: stop.category,
        duration: stop.duration || '',
        note: stop.notes || '',
        lat: stop.lat ?? null,
        lng: stop.lng ?? null
      }))
    }))
  };
  let studioStore = { version: 1, trips: [] };
  try { studioStore = JSON.parse(localStorage.getItem('tripline-v1')) || studioStore; } catch {}
  studioStore.trips = Array.isArray(studioStore.trips) ? studioStore.trips.filter((item) => item.id !== trip.id) : [];
  studioStore.trips.unshift(studioTrip);
  localStorage.setItem('tripline-v1', JSON.stringify(studioStore));
  localStorage.setItem(ACTIVE_TRIP_STORAGE_KEY, trip.id);
  location.href = `app.html?trip=${encodeURIComponent(trip.id)}`;
}

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
    if (control.dataset.open === 'auth') openModal('#authModal');
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
  if (control.dataset.filter) {
    state.filter = control.dataset.filter;
    $$('#tripFilters button').forEach((button) => button.classList.toggle('active', button === control));
    renderTrips();
    return;
  }

  const action = control.dataset.action;
  if (action === 'manual-trip') await createManualFromPlanner();
  if (action === 'delete-stop') {
    const form = $('#stopForm');
    const trip = activeTrip();
    const day = trip.days.find((item) => item.id === form.elements.dayId.value);
    day.stops = day.stops.filter((stop) => stop.id !== form.elements.stopId.value);
    closeModal();
    await persistTrip(trip, 'Durak silindi.');
    renderTripDetail();
  }
  if (action === 'delete-trip') {
    const trip = activeTrip();
    if (!trip || !window.confirm(`${trip.destination} seyahatini kalıcı olarak silmek istiyor musun?`)) return;
    try {
      state.trips = await deleteTrip(trip.id, state.session, state.trips);
      state.activeTripId = state.trips[0]?.id || null;
      renderAll();
      showRoute('trips');
      toast('Seyahat silindi.');
    } catch (error) { console.error(error); toast('Seyahat silinemedi.', 'error'); }
  }
  if (action === 'export-trip') {
    const trip = activeTrip();
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([JSON.stringify(trip, null, 2)], { type: 'application/json' }));
    link.download = `${trip.destination.toLocaleLowerCase('tr-TR').replace(/\s+/g, '-')}-roamly.json`;
    link.click();
    URL.revokeObjectURL(link.href);
  }
  if (action === 'export-data') {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([JSON.stringify({ version: 1, trips: state.trips }, null, 2)], { type: 'application/json' }));
    link.download = `roamly-yedek-${isoToday()}.json`;
    link.click();
    URL.revokeObjectURL(link.href);
  }
  if (action === 'open-studio') seedAdvancedStudio(activeTrip());
  if (action === 'sign-in-google') {
    const { error } = await supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: `${location.origin}${location.pathname}` } });
    if (error) toast(error.message, 'error');
  }
  if (action === 'sign-out') {
    await supabase.auth.signOut();
    state.session = null;
    showRoute('home');
    await refreshTrips();
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
    duration: ''
  };
  const existingIndex = day.stops.findIndex((item) => item.id === stopId);
  if (existingIndex >= 0) day.stops[existingIndex] = { ...day.stops[existingIndex], ...stop };
  else day.stops.push(stop);
  day.stops.sort((a, b) => String(a.time).localeCompare(String(b.time)));
  closeModal();
  await persistTrip(trip, existingIndex >= 0 ? 'Durak güncellendi.' : 'Durak rotana eklendi.');
  renderTripDetail();
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

$('#emailAuthForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const email = String(new FormData(event.currentTarget).get('email')).trim();
  const { error } = await supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: `${location.origin}${location.pathname}` } });
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
    const parsed = JSON.parse(await file.text());
    const trips = Array.isArray(parsed?.trips) ? parsed.trips : parsed?.destination ? [parsed] : [];
    if (!trips.length || trips.some((trip) => !trip.id || !Array.isArray(trip.days))) throw new Error('invalid');
    for (const trip of trips) await persistTrip(trip);
    renderAll();
    toast(`${trips.length} seyahat içe aktarıldı.`);
  } catch { toast('Bu dosya geçerli bir Roamly yedeği değil.', 'error'); }
  event.target.value = '';
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeModal();
});

function setOnlineState() { document.body.classList.toggle('offline', !navigator.onLine); }
window.addEventListener('online', setOnlineState);
window.addEventListener('offline', setOnlineState);
setOnlineState();

async function initialize() {
  icons();
  state.session = await getSession();
  await refreshTrips();
  if (state.session) {
    const migrated = await migrateGuestTrips(state.session).catch(() => []);
    if (migrated.length) await refreshTrips();
    const pending = sessionStorage.getItem('roamly-pending-plan');
    if (pending) {
      sessionStorage.removeItem('roamly-pending-plan');
      await runPlanner(JSON.parse(pending));
    }
  }
  supabase.auth.onAuthStateChange(async (_event, session) => {
    const wasSignedOut = !state.session;
    state.session = session;
    closeModal();
    await refreshTrips();
    if (session && wasSignedOut) toast('Hesabın hazır. Bulut senkronu açıldı.');
  });
  if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}

initialize().catch((error) => {
  console.error(error);
  setSync('Başlatılamadı', 'error');
  toast('Roamly başlatılamadı. Sayfayı yenilemeyi dene.', 'error');
});
