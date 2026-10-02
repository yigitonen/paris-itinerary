import assert from 'node:assert/strict';
import test from 'node:test';
import { applyBudgetSettings, budgetSummary, currencyOptions, expenseCurrency, spentByCurrency } from './budget.js';

const trip = { currency: 'EUR', budgetTotal: 1000, expenses: [
  { id: 'a', amount: 100, currency: 'EUR' }, { id: 'b', amount: 50.5 }, { id: 'c', amount: 3000, currency: 'JPY' }, { id: 'd', amount: 'x', currency: 'EUR' }
] };

test('expenses without a currency belong to the trip currency', () => {
  assert.equal(expenseCurrency({}, trip), 'EUR');
  assert.equal(expenseCurrency({ currency: ' try ' }, trip), 'TRY');
});

test('spent totals are kept per currency and skip invalid amounts', () => {
  assert.deepEqual(spentByCurrency(trip), { EUR: 150.5, JPY: 3000 });
  assert.deepEqual(spentByCurrency({ currency: 'EUR' }), {});
});

test('the budget summary only counts the trip currency and lists the rest', () => {
  const summary = budgetSummary(trip);
  assert.equal(summary.spent, 150.5);
  assert.equal(summary.progress, 15);
  assert.deepEqual(summary.others, [{ currency: 'JPY', amount: 3000 }]);
  assert.equal(budgetSummary({ currency: 'EUR', expenses: [{ amount: 5000, currency: 'EUR' }], budgetTotal: 100 }).progress, 100);
  assert.equal(budgetSummary({ currency: 'EUR', expenses: [] }).progress, 0);
});

test('currency options always include the trip currency once', () => {
  assert.deepEqual(currencyOptions('USD'), ['EUR', 'USD', 'GBP', 'TRY', 'JPY', 'CHF']);
  assert.equal(currencyOptions('sek').at(-1), 'SEK');
  assert.equal(currencyOptions('???').length, 6);
});

test('budget settings are validated', () => {
  assert.equal(applyBudgetSettings(trip, { total: '-5', currency: 'EUR' }).error !== undefined, true);
  assert.equal(applyBudgetSettings(trip, { total: 'abc', currency: 'EUR' }).error !== undefined, true);
  assert.equal(applyBudgetSettings(trip, { total: '1e12', currency: 'EUR' }).error !== undefined, true);
  assert.equal(applyBudgetSettings(trip, { total: '100', currency: 'euro' }).error !== undefined, true);
  assert.deepEqual(
    (({ budgetTotal, currency }) => ({ budgetTotal, currency }))(applyBudgetSettings(trip, { total: '1250,5', currency: 'usd' })),
    { budgetTotal: 1250.5, currency: 'USD' }
  );
  assert.equal(applyBudgetSettings(trip, { total: '', currency: 'EUR' }).budgetTotal, 0);
  assert.equal(applyBudgetSettings(trip, { total: '0', currency: 'EUR' }).budgetTotal, 0);
});

test('changing currency keeps existing expenses in their original currency', () => {
  const next = applyBudgetSettings(trip, { total: '1000', currency: 'USD' });
  assert.deepEqual(next.expenses.map((expense) => expense.currency), ['EUR', 'EUR', 'JPY', 'EUR']);
  const summary = budgetSummary({ ...trip, currency: next.currency, expenses: next.expenses });
  assert.equal(summary.spent, 0);
  assert.deepEqual(summary.others, [{ currency: 'EUR', amount: 150.5 }, { currency: 'JPY', amount: 3000 }]);
  assert.equal(trip.expenses[1].currency, undefined);
});
