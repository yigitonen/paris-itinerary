import test from 'node:test';
import assert from 'node:assert/strict';
import { plannerError } from './planner.js';

test('quota codes become quota errors with the server message', () => {
  for (const code of ['in_progress', 'cooldown', 'daily_limit', 'attempt_limit', 'global_budget']) {
    const error = plannerError(429, { error: `Sunucu mesajı ${code}`, code }, 'Edge Function returned a non-2xx status code');
    assert.ok(error instanceof Error);
    assert.equal(error.quota, true);
    assert.equal(error.code, code);
    assert.equal(error.message, `Sunucu mesajı ${code}`);
  }
});

test('quota codes without a server message use Turkish defaults', () => {
  const expected = {
    in_progress: 'Önceki AI planın hâlâ hazırlanıyor. Bitince yeniden dene.',
    cooldown: 'Yeni bir AI planı oluşturmadan önce bir dakika bekle.',
    daily_limit: 'Ücretsiz AI planı günlük sınırına ulaştın. 24 saat sonra yeniden deneyebilirsin.',
    attempt_limit: 'Bugün çok fazla AI planı denemesi yapıldı. Daha sonra yeniden dene.',
    global_budget: 'Roamly’nin bugünkü AI planlama kapasitesi doldu. Yarın yeniden dene veya boş planla devam et.'
  };
  for (const [code, message] of Object.entries(expected)) {
    const error = plannerError(429, { code }, 'non-2xx');
    assert.equal(error.quota, true);
    assert.equal(error.message, message);
  }
});

test('existing mappings for sign-in, network and configuration are kept', () => {
  assert.equal(plannerError(401, { error: 'Authentication required' }, 'x').message, 'Oturumun doğrulanamadı. Yeniden giriş yapıp tekrar dene.');
  assert.equal(plannerError(undefined, null, 'Failed to fetch').message, 'AI servisine ulaşılamadı. İnternet bağlantını kontrol edip yeniden dene.');
  assert.equal(plannerError(503, { error: 'Gemini is not configured', code: 'configuration_missing' }, 'x').message, 'AI planlama şu anda kullanıma hazır değil. Biraz sonra yeniden dene.');
  assert.equal(plannerError(429, null, 'x').message, 'Ücretsiz AI planı sınırına ulaştın. Bir süre sonra yeniden deneyebilirsin.');
  const plain = plannerError(400, { error: 'Geçerli bir şehir gir.' }, 'x');
  assert.equal(plain.message, 'Geçerli bir şehir gir.');
  assert.equal(Boolean(plain.quota), false);
});
