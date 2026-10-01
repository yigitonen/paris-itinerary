import { createManualTrip, destinationKey } from './data.js';
import { supabase } from './repository.js';

const validTrip = (trip) => trip && Array.isArray(trip.days) && trip.days.length > 0 && trip.days.every((day) => Array.isArray(day.stops));

const QUOTA_MESSAGES = {
  in_progress: 'Önceki AI planın hâlâ hazırlanıyor. Bitince yeniden dene.',
  cooldown: 'Yeni bir AI planı oluşturmadan önce bir dakika bekle.',
  daily_limit: 'Ücretsiz AI planı günlük sınırına ulaştın. 24 saat sonra yeniden deneyebilirsin.',
  attempt_limit: 'Bugün çok fazla AI planı denemesi yapıldı. Daha sonra yeniden dene.',
  global_budget: 'Roamly’nin bugünkü AI planlama kapasitesi doldu. Yarın yeniden dene veya boş planla devam et.'
};

// Maps a failed plan-trip response to an Error. Errors with `quota: true`
// carry a message that is already written for the user.
export function plannerError(status, body, transportMessage) {
  const code = typeof body?.code === 'string' ? body.code : '';
  if (Object.hasOwn(QUOTA_MESSAGES, code)) {
    return Object.assign(new Error(body?.error ? String(body.error) : QUOTA_MESSAGES[code]), { code, quota: true });
  }
  let message = body?.error ? String(body.error) : transportMessage || 'Plan oluşturulamadı.';
  if (!status && /fetch|network|connection|load failed/i.test(message)) {
    message = 'AI servisine ulaşılamadı. İnternet bağlantını kontrol edip yeniden dene.';
  } else if (status === 401) {
    message = 'Oturumun doğrulanamadı. Yeniden giriş yapıp tekrar dene.';
  } else if (status === 429) {
    message = 'Ücretsiz AI planı sınırına ulaştın. Bir süre sonra yeniden deneyebilirsin.';
  } else if (status >= 500 && /not configured|configuration/i.test(message)) {
    message = 'AI planlama şu anda kullanıma hazır değil. Biraz sonra yeniden dene.';
  }
  return Object.assign(new Error(message), { code, quota: status === 429 });
}

export async function generateTrip(input) {
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    throw new Error('AI planlama internet bağlantısı gerektiriyor. Bağlandığında yeniden deneyebilirsin.');
  }
  const { data, error } = await supabase.functions.invoke('plan-trip', { body: input });
  if (error) {
    let body = null;
    try {
      const response = error.context;
      if (response?.clone) body = await response.clone().json();
    } catch {
      // Keep the transport error when the response body is unavailable.
    }
    throw plannerError(error.context?.status, body, error.message);
  }
  if (!data?.trip || !validTrip(data.trip)) throw new Error(data?.error || 'Plan yanıtı doğrulanamadı.');
  const manual = createManualTrip(input);
  return {
    ...manual,
    ...data.trip,
    id: crypto.randomUUID(),
    destination: input.destination,
    title: data.trip.title || input.destination,
    startDate: input.startDate,
    endDate: manual.endDate,
    durationDays: manual.durationDays,
    style: input.style,
    pace: input.pace,
    note: input.note,
    coverKey: destinationKey(input.destination),
    source: 'gemini',
    status: 'planning',
    expenses: [],
    journals: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}
