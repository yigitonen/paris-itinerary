export const COMMON_CURRENCIES = Object.freeze(['EUR', 'USD', 'GBP', 'TRY', 'JPY', 'CHF']);
export const BUDGET_MAX = 1e9;

const CODE = /^[A-Z]{3}$/;
const normalizeCode = (value) => typeof value === 'string' ? value.trim().toUpperCase() : '';
const money = (value) => Math.round(value * 100) / 100;

// Expenses created before they stored their own currency belong to the trip currency.
export const expenseCurrency = (expense, trip) => normalizeCode(expense?.currency) || normalizeCode(trip?.currency) || 'EUR';

export function currencyOptions(current) {
  const code = normalizeCode(current);
  return CODE.test(code) && !COMMON_CURRENCIES.includes(code) ? [...COMMON_CURRENCIES, code] : [...COMMON_CURRENCIES];
}

// Totals per currency, so amounts in different currencies are never added together.
export function spentByCurrency(trip) {
  const totals = {};
  for (const expense of trip?.expenses || []) {
    const amount = Number(expense?.amount);
    if (!Number.isFinite(amount)) continue;
    const code = expenseCurrency(expense, trip);
    totals[code] = money((totals[code] || 0) + amount);
  }
  return totals;
}

// `spent` only counts the trip currency; `others` lists what was left out as [{ currency, amount }].
export function budgetSummary(trip) {
  const totals = spentByCurrency(trip);
  const currency = normalizeCode(trip?.currency) || 'EUR';
  const budget = Number(trip?.budgetTotal) > 0 ? Number(trip.budgetTotal) : 0;
  const spent = totals[currency] || 0;
  delete totals[currency];
  return {
    currency,
    spent,
    budget,
    progress: budget ? Math.min(100, Math.round(spent / budget * 100)) : 0,
    others: Object.entries(totals).sort(([a], [b]) => a.localeCompare(b)).map(([code, amount]) => ({ currency: code, amount }))
  };
}

// Validates the budget edit form. An empty total means "no limit" (0).
// When the currency changes, expenses without their own currency are stamped with the old one first,
// so changing the trip currency never silently relabels money that was already spent.
export function applyBudgetSettings(trip, { total, currency } = {}) {
  const raw = typeof total === 'string' ? total.trim().replace(',', '.') : total;
  const budgetTotal = raw === '' || raw === null || raw === undefined ? 0 : typeof raw === 'number' || /^\d+(\.\d+)?$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isFinite(budgetTotal) || budgetTotal < 0 || budgetTotal > BUDGET_MAX) return { error: 'Bütçe 0 veya daha büyük bir sayı olmalı.' };
  const code = normalizeCode(currency);
  if (!CODE.test(code)) return { error: 'Geçerli bir para birimi seç.' };
  const previous = normalizeCode(trip?.currency) || 'EUR';
  return {
    budgetTotal: money(budgetTotal),
    currency: code,
    expenses: (trip?.expenses || []).map((expense) => normalizeCode(expense?.currency) ? expense : { ...expense, currency: previous })
  };
}
