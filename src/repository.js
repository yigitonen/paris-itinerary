import { createClient } from '@supabase/supabase-js';
import { GUEST_STORAGE_KEY, SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from './config.js';
import { createDemoTrip } from './data.js';

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
});

const readGuestTrips = () => {
  try {
    const parsed = JSON.parse(localStorage.getItem(GUEST_STORAGE_KEY) || 'null');
    if (Array.isArray(parsed) && parsed.length) return parsed;
  } catch (error) {
    console.warn('Guest trips could not be read', error);
  }
  const demo = [createDemoTrip()];
  localStorage.setItem(GUEST_STORAGE_KEY, JSON.stringify(demo));
  return demo;
};

const writeGuestTrips = (trips) => localStorage.setItem(GUEST_STORAGE_KEY, JSON.stringify(trips));

const toRow = (trip, userId) => ({
  id: trip.id.startsWith('demo-') ? crypto.randomUUID() : trip.id,
  owner_id: userId,
  title: trip.title || trip.destination,
  destination: trip.destination,
  country: trip.country || '',
  start_date: trip.startDate,
  end_date: trip.endDate,
  status: trip.status || 'planning',
  style: trip.style || 'Dengeli',
  pace: trip.pace || 'Rahat',
  cover_key: trip.coverKey || 'default',
  budget_total: Number(trip.budgetTotal) || 0,
  currency: trip.currency || 'EUR',
  plan: {
    source: trip.source || 'manual',
    note: trip.note || '',
    summary: trip.summary || '',
    researchSummary: trip.researchSummary || '',
    researchSources: trip.researchSources || [],
    plannerMeta: trip.plannerMeta || null,
    days: trip.days || [],
    expenses: trip.expenses || [],
    journals: trip.journals || []
  }
});

const fromRow = (row) => ({
  id: row.id,
  title: row.title,
  destination: row.destination,
  country: row.country || '',
  startDate: row.start_date,
  endDate: row.end_date,
  durationDays: Math.max(1, Math.round((new Date(`${row.end_date}T12:00:00`) - new Date(`${row.start_date}T12:00:00`)) / 86400000) + 1),
  status: row.status,
  style: row.style,
  pace: row.pace,
  coverKey: row.cover_key,
  budgetTotal: Number(row.budget_total) || 0,
  currency: row.currency || 'EUR',
  source: row.plan?.source || 'manual',
  note: row.plan?.note || '',
  summary: row.plan?.summary || '',
  researchSummary: row.plan?.researchSummary || '',
  researchSources: row.plan?.researchSources || [],
  plannerMeta: row.plan?.plannerMeta || null,
  days: row.plan?.days || [],
  expenses: row.plan?.expenses || [],
  journals: row.plan?.journals || [],
  createdAt: row.created_at,
  updatedAt: row.updated_at
});

export async function getSession() {
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  return data.session;
}

export async function loadTrips(session) {
  if (!session) return readGuestTrips();
  const { data, error } = await supabase.from('trips').select('*').order('start_date', { ascending: true });
  if (error) throw error;
  return data.map(fromRow);
}

export async function saveTrip(trip, session, currentTrips) {
  const nextTrip = { ...trip, updatedAt: new Date().toISOString() };
  if (!session) {
    const next = currentTrips.some((item) => item.id === nextTrip.id)
      ? currentTrips.map((item) => item.id === nextTrip.id ? nextTrip : item)
      : [nextTrip, ...currentTrips];
    writeGuestTrips(next);
    return { trip: nextTrip, trips: next };
  }
  const row = toRow(nextTrip, session.user.id);
  const { data, error } = await supabase.from('trips').upsert(row).select().single();
  if (error) throw error;
  const saved = fromRow(data);
  const next = currentTrips.some((item) => item.id === nextTrip.id)
    ? currentTrips.map((item) => item.id === nextTrip.id ? saved : item)
    : [saved, ...currentTrips];
  return { trip: saved, trips: next };
}

export async function deleteTrip(tripId, session, currentTrips) {
  const next = currentTrips.filter((trip) => trip.id !== tripId);
  if (!session) {
    writeGuestTrips(next);
    return next;
  }
  const { error } = await supabase.from('trips').delete().eq('id', tripId);
  if (error) throw error;
  return next;
}

export async function migrateGuestTrips(session) {
  if (!session) return [];
  const guestTrips = readGuestTrips().filter((trip) => trip.source !== 'demo');
  if (!guestTrips.length) return [];
  const rows = guestTrips.map((trip) => toRow(trip, session.user.id));
  const { data, error } = await supabase.from('trips').upsert(rows).select();
  if (error) throw error;
  localStorage.removeItem(GUEST_STORAGE_KEY);
  return data.map(fromRow);
}

export async function joinLocalsWaitlist({ email, city, note }, session) {
  const { error } = await supabase.from('locals_waitlist').insert({
    user_id: session?.user?.id || null,
    email,
    city,
    note
  });
  if (error) throw error;
}
