import { getDb } from '../db/database';
import { logger } from '../utils/logger';
import { toApiCategory } from './finance-categories';

export interface Transaction {
  id: string;
  amount: number;
  type: 'income' | 'expense';
  category: string;
  description?: string;
  date: string;
  recurrence: string;
  recurrence_end?: string;
}

export interface AddTransactionPayload {
  amount: number;
  type: 'income' | 'expense';
  category: string;
  description?: string;
  date?: string;
  recurrence?: string;
  recurrence_end?: string;
}

export interface BudgetPayload {
  category: string;
  limit: number;
  year?: number;
  month?: number;
}

export interface CategoryBudget {
  category: string;
  limit: number;
  spent: number;
}

export interface MonthlySummary {
  balance: number;
  balanceToday: number;
  totalIncome: number;
  totalExpense: number;
  net: number;
  byCategory: Array<{
    category: string;
    type: 'income' | 'expense';
    amount: number;
    budget?: number;
  }>;
  budgets: CategoryBudget[];
}

export interface MonthData {
  transactions: Transaction[];
  balance: number;
}

function monthBounds(year: number, month: number): { from: string; to: string } {
  const mm = String(month).padStart(2, '0');
  const lastDay = new Date(year, month, 0).getDate();
  return {
    from: `${year}-${mm}-01`,
    to: `${year}-${mm}-${String(lastDay).padStart(2, '0')}`,
  };
}

function addMonthsClamped(date: Date, months: number): Date {
  const d = new Date(date);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + months);
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, lastDay));
  return d;
}

function toIsoDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getTodayIsoInTimezone(): string {
  const timeZone = process.env.TIMEZONE || 'Europe/Minsk';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());

  const year = parts.find((p) => p.type === 'year')?.value;
  const month = parts.find((p) => p.type === 'month')?.value;
  const day = parts.find((p) => p.type === 'day')?.value;
  if (!year || !month || !day) return toIsoDate(new Date());
  return `${year}-${month}-${day}`;
}

function nextOccurrence(date: Date, recurrence: string): Date {
  switch (recurrence) {
    case 'daily':
      return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1);
    case 'weekly':
      return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 7);
    case 'quarterly':
      return addMonthsClamped(date, 3);
    case 'monthly':
      return addMonthsClamped(date, 1);
    default:
      return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 10000);
  }
}

export class FinanceService {
  async getMonthData(year: number, month: number): Promise<MonthData> {
    const db = getDb();
    const { from, to } = monthBounds(year, month);

    const { data, error } = await db
      .from('finance_transactions')
      .select('*')
      .gte('date', from)
      .lte('date', to)
      .order('date', { ascending: true });

    if (error) throw new Error(error.message);

    const transactions: Transaction[] = (data ?? []).map(row => ({
      id: row.id,
      amount: Number(row.amount),
      type: row.type,
      category: row.category,
      description: row.description ?? undefined,
      date: row.date,
      recurrence: row.recurrence,
      recurrence_end: row.recurrence_end ?? undefined,
    }));

    const initialBalance = await this.getInitialBalance();
    const base = initialBalance ?? 0;

    // Balance = initial + all income - all expense up to and including this month
    const { data: allTxData } = await db
      .from('finance_transactions')
      .select('amount, type')
      .lte('date', to);

    const balance = (allTxData ?? []).reduce((acc, tx) => {
      return tx.type === 'income' ? acc + Number(tx.amount) : acc - Number(tx.amount);
    }, base);

    return { transactions, balance };
  }

  async getSummary(year: number, month: number): Promise<MonthlySummary> {
    const monthData = await this.getMonthData(year, month);
    const transactions = monthData.transactions;
    const todayIso = getTodayIsoInTimezone();
    const { to } = monthBounds(year, month);
    const cutoffDate = todayIso < to ? todayIso : to;

    const totalIncome = transactions
      .filter(t => t.type === 'income')
      .reduce((s, t) => s + t.amount, 0);

    const totalExpense = transactions
      .filter(t => t.type === 'expense')
      .reduce((s, t) => s + t.amount, 0);

    const net = totalIncome - totalExpense;
    const balance = monthData.balance;
    const initialBalance = await this.getInitialBalance();
    const base = initialBalance ?? 0;
    const db = getDb();
    const { data: txToCutoff, error: txToCutoffError } = await db
      .from('finance_transactions')
      .select('amount, type')
      .lte('date', cutoffDate);

    if (txToCutoffError) throw new Error(txToCutoffError.message);

    const balanceToday = (txToCutoff ?? []).reduce((acc, tx) => {
      return tx.type === 'income' ? acc + Number(tx.amount) : acc - Number(tx.amount);
    }, base);

    // By category
    const catMap: Record<string, { type: 'income' | 'expense'; amount: number }> = {};
    for (const tx of transactions) {
      if (!catMap[tx.category]) catMap[tx.category] = { type: tx.type, amount: 0 };
      catMap[tx.category].amount += tx.amount;
    }
    const byCategory = Object.entries(catMap).map(([category, v]) => ({
      category,
      type: v.type,
      amount: v.amount,
    }));

    const budgets = await this.getBudgets(year, month);

    return { balance, balanceToday, totalIncome, totalExpense, net, byCategory, budgets };
  }

  async getTransactions(year?: number, month?: number, limit?: number): Promise<Transaction[]> {
    const now = new Date();
    const y = year ?? now.getFullYear();
    const m = month ?? (now.getMonth() + 1);
    const monthData = await this.getMonthData(y, m);
    const txs = monthData.transactions ?? [];
    return limit ? txs.slice(-limit).reverse() : txs.slice().reverse();
  }

  async getRecentTransactions(limit = 10): Promise<Transaction[]> {
    const db = getDb();
    const since = new Date();
    since.setDate(since.getDate() - 30);
    const sinceIso = toIsoDate(since);
    const { data, error } = await db
      .from('finance_transactions')
      .select('*')
      .gte('date', sinceIso)
      .order('date', { ascending: false })
      .limit(limit);

    if (error) throw new Error(error.message);

    return (data ?? []).map((row) => ({
      id: row.id,
      amount: Number(row.amount),
      type: row.type,
      category: row.category,
      description: row.description ?? undefined,
      date: row.date,
      recurrence: row.recurrence,
      recurrence_end: row.recurrence_end ?? undefined,
    }));
  }

  async getTransactionsWithRecurring(year?: number, month?: number, limit?: number): Promise<Transaction[]> {
    const now = new Date();
    const y = year ?? now.getFullYear();
    const m = month ?? (now.getMonth() + 1);
    const { from, to } = monthBounds(y, m);

    const base = await this.getTransactions(y, m);
    const db = getDb();
    const { data: recurringRows, error } = await db
      .from('finance_transactions')
      .select('*')
      .neq('recurrence', 'once')
      .lte('date', to)
      .order('date', { ascending: true });

    if (error) throw new Error(error.message);

    const recurringTemplates: Transaction[] = (recurringRows ?? []).map((row) => ({
      id: row.id,
      amount: Number(row.amount),
      type: row.type,
      category: row.category,
      description: row.description ?? undefined,
      date: row.date,
      recurrence: row.recurrence,
      recurrence_end: row.recurrence_end ?? undefined,
    }));

    const fromDate = new Date(`${from}T00:00:00`);
    const toDate = new Date(`${to}T00:00:00`);
    const projected: Transaction[] = [];

    for (const tx of recurringTemplates) {
      const start = new Date(`${tx.date}T00:00:00`);
      const end = tx.recurrence_end ? new Date(`${tx.recurrence_end}T00:00:00`) : null;
      if (end && end < fromDate) continue;

      let cursor = new Date(start);
      while (cursor < fromDate) {
        cursor = nextOccurrence(cursor, tx.recurrence);
      }

      while (cursor <= toDate) {
        if (!end || cursor <= end) {
          const occ = toIsoDate(cursor);
          // If template row itself is already in this month, keep only the persisted row.
          const isTemplatePersistedThisMonth = occ === tx.date;
          if (!isTemplatePersistedThisMonth) {
            projected.push({
              ...tx,
              id: `${tx.id}:${occ}`,
              date: occ,
            });
          }
        }
        cursor = nextOccurrence(cursor, tx.recurrence);
      }
    }

    const mergedMap = new Map<string, Transaction>();
    for (const tx of [...base, ...projected]) {
      const key = `${tx.type}|${tx.category}|${tx.amount}|${tx.date}|${tx.description ?? ''}|${tx.recurrence}`;
      if (!mergedMap.has(key)) mergedMap.set(key, tx);
    }

    const merged = Array.from(mergedMap.values()).sort((a, b) => b.date.localeCompare(a.date));
    return limit ? merged.slice(0, limit) : merged;
  }

  async addTransaction(payload: AddTransactionPayload): Promise<Transaction> {
    const db = getDb();
    const category = toApiCategory(payload.category, payload.type);
    const date = payload.date ?? getTodayIsoInTimezone();
    const recurrence = payload.recurrence ?? 'once';

    logger.info({ payload }, 'Adding transaction');

    const { data, error } = await db
      .from('finance_transactions')
      .insert({
        amount: payload.amount,
        type: payload.type,
        category,
        description: payload.description ?? null,
        date,
        recurrence,
        recurrence_end: payload.recurrence_end ?? null,
      })
      .select()
      .single();

    if (error) throw new Error(error.message);

    return {
      id: data.id,
      amount: Number(data.amount),
      type: data.type,
      category: data.category,
      description: data.description ?? undefined,
      date: data.date,
      recurrence: data.recurrence,
      recurrence_end: data.recurrence_end ?? undefined,
    };
  }

  async updateTransaction(id: string, updates: Partial<AddTransactionPayload>): Promise<Transaction> {
    const db = getDb();
    const patch: Record<string, unknown> = { ...updates };
    if (updates.category && updates.type) {
      patch.category = toApiCategory(updates.category, updates.type);
    }
    delete patch.type; // type is not updatable separately

    const { data, error } = await db
      .from('finance_transactions')
      .update(patch)
      .eq('id', id)
      .select()
      .single();

    if (error) throw new Error(error.message);

    return {
      id: data.id,
      amount: Number(data.amount),
      type: data.type,
      category: data.category,
      description: data.description ?? undefined,
      date: data.date,
      recurrence: data.recurrence,
      recurrence_end: data.recurrence_end ?? undefined,
    };
  }

  async deleteTransaction(id: string): Promise<void> {
    const db = getDb();
    const { error } = await db.from('finance_transactions').delete().eq('id', id);
    if (error) throw new Error(error.message);
  }

  async upsertBudget(payload: BudgetPayload): Promise<void> {
    const db = getDb();
    const now = new Date();
    const year = payload.year ?? now.getFullYear();
    const month = payload.month ?? (now.getMonth() + 1);

    const { error } = await db.from('finance_budgets').upsert(
      {
        category: payload.category,
        limit_amount: payload.limit,
        year,
        month,
      },
      { onConflict: 'category,year,month' }
    );

    if (error) throw new Error(error.message);
  }

  async getBudgets(year?: number, month?: number, upToDate?: string): Promise<CategoryBudget[]> {
    const db = getDb();
    const now = new Date();
    const y = year ?? now.getFullYear();
    const m = month ?? (now.getMonth() + 1);

    const { data: budgetRows, error } = await db
      .from('finance_budgets')
      .select('*')
      .eq('year', y)
      .eq('month', m);

    if (error) throw new Error(error.message);

    if (!budgetRows || budgetRows.length === 0) return [];

    // Get spending per category for this month
    const { from, to } = monthBounds(y, m);
    const budgetTo = upToDate && upToDate < to ? upToDate : to;
    const { data: txData } = await db
      .from('finance_transactions')
      .select('category, amount')
      .eq('type', 'expense')
      .gte('date', from)
      .lte('date', budgetTo);

    const spentMap: Record<string, number> = {};
    for (const tx of txData ?? []) {
      spentMap[tx.category] = (spentMap[tx.category] ?? 0) + Number(tx.amount);
    }

    return budgetRows.map(row => ({
      category: row.category,
      limit: Number(row.limit_amount),
      spent: spentMap[row.category] ?? 0,
    }));
  }

  async getMinBalance(): Promise<number> {
    const val = await this._getSetting('min_balance');
    return val ? Number(val) : 0;
  }

  async setMinBalance(value: number): Promise<void> {
    await this._setSetting('min_balance', String(value));
  }

  async getInitialBalance(): Promise<number | null> {
    const val = await this._getSetting('initial_balance');
    return val !== null ? Number(val) : null;
  }

  async setInitialBalance(value: number): Promise<void> {
    await this._setSetting('initial_balance', String(value));
  }

  async setCurrentBalance(value: number, asOfDate?: string): Promise<void> {
    const db = getDb();
    const cutoff = asOfDate ?? getTodayIsoInTimezone();

    const { data, error } = await db
      .from('finance_transactions')
      .select('amount, type')
      .lte('date', cutoff);

    if (error) throw new Error(error.message);

    const netToDate = (data ?? []).reduce((acc, tx) => {
      return tx.type === 'income' ? acc + Number(tx.amount) : acc - Number(tx.amount);
    }, 0);

    const initialBalance = value - netToDate;
    await this._setSetting('initial_balance', String(initialBalance));
  }

  async isOnboardingDone(): Promise<boolean> {
    try {
      const balance = await this.getInitialBalance();
      return balance !== null;
    } catch {
      return true;
    }
  }

  private async _getSetting(key: string): Promise<string | null> {
    const db = getDb();
    const { data, error } = await db
      .from('finance_settings')
      .select('value')
      .eq('key', key)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data?.value ?? null;
  }

  private async _setSetting(key: string, value: string): Promise<void> {
    const db = getDb();
    const { error } = await db
      .from('finance_settings')
      .upsert({ key, value }, { onConflict: 'key' });
    if (error) throw new Error(error.message);
  }

  async computeForecast(period: 'week' | 'month' | 'quarter' | 'year'): Promise<{
    currentBalance: number;
    minForecast: number;
    realisticForecast: number;
    recurringItems: Array<{
      label: string;
      amount: number;
      type: 'income' | 'expense';
      category: string;
      recurrence: string;
      dates: string[];
    }>;
    plannedItems: Array<{ label: string; amount: number; type: 'income' | 'expense'; date: string }>;
    avgItems: Array<{ label: string; amount: number }>;
    alertDate: string | null;
    minBalance: number;
    periodStart: string;
    periodEnd: string;
  }> {
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth() + 1;

    const todayIso = getTodayIsoInTimezone();
    const horizon = new Date(now);
    if (period === 'month') {
      // Month forecast should stay within the current calendar month.
      horizon.setMonth(horizon.getMonth() + 1, 0);
    } else {
      const fallbackDays = period === 'week' ? 7 : period === 'quarter' ? 90 : 365;
      horizon.setDate(horizon.getDate() + fallbackDays);
    }
    const periodDays = Math.max(1, Math.ceil((horizon.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)));
    const horizonIso = toIsoDate(horizon);

    const [summary, monthData, monthTxWithRecurring] = await Promise.all([
      this.getSummary(currentYear, currentMonth),
      this.getMonthData(currentYear, currentMonth),
      this.getTransactionsWithRecurring(currentYear, currentMonth),
    ]);
    const netToDate = (txs: Array<{ date: string; type: 'income' | 'expense'; amount: number }>) => txs
      .filter((tx) => tx.date <= todayIso)
      .reduce((sum, tx) => sum + (tx.type === 'income' ? tx.amount : -tx.amount), 0);

    const persistedToDate = netToDate(monthData.transactions ?? []);
    const withRecurringToDate = netToDate(monthTxWithRecurring ?? []);
    const recurringDelta = withRecurringToDate - persistedToDate;
    const currentBalance = (summary.balanceToday ?? 0) + recurringDelta;
    const minBalance = await this.getMinBalance();

    const db = getDb();
    const { data: recurringRows, error: recurringError } = await db
      .from('finance_transactions')
      .select('amount, type, category, description, date, recurrence, recurrence_end, created_at')
      .neq('recurrence', 'once')
      .lte('date', horizonIso)
      .order('date', { ascending: true });

    if (recurringError) throw new Error(recurringError.message);

    const rangeStart = new Date(`${todayIso}T00:00:00`);
    const rangeEnd = new Date(`${horizonIso}T00:00:00`);
    const recurringItems: Array<{
      label: string;
      amount: number;
      type: 'income' | 'expense';
      category: string;
      recurrence: string;
      dates: string[];
    }> = [];

    const dedupedRecurring = new Map<string, (typeof recurringRows extends Array<infer T> ? T : never)>();
    for (const tx of recurringRows ?? []) {
      const key = [
        tx.type,
        tx.category,
        (tx.description ?? '').trim().toLowerCase(),
        tx.recurrence,
      ].join('|');

      const prev = dedupedRecurring.get(key);
      if (!prev) {
        dedupedRecurring.set(key, tx);
        continue;
      }

      // Prefer template with later start date (it represents a newer effective schedule).
      // If start dates are equal, fallback to the most recently created template.
      const prevStart = Date.parse(`${prev.date}T00:00:00`);
      const nextStart = Date.parse(`${tx.date}T00:00:00`);
      if (Number.isFinite(nextStart) && Number.isFinite(prevStart) && nextStart > prevStart) {
        dedupedRecurring.set(key, tx);
        continue;
      }
      if (Number.isFinite(nextStart) && Number.isFinite(prevStart) && nextStart < prevStart) {
        continue;
      }

      const prevCreated = Date.parse(prev.created_at ?? '');
      const nextCreated = Date.parse(tx.created_at ?? '');
      if (Number.isFinite(nextCreated) && (!Number.isFinite(prevCreated) || nextCreated >= prevCreated)) {
        dedupedRecurring.set(key, tx);
      }
    }

    for (const tx of dedupedRecurring.values()) {
      const start = new Date(`${tx.date}T00:00:00`);
      const end = tx.recurrence_end ? new Date(`${tx.recurrence_end}T00:00:00`) : null;
      if (end && end <= rangeStart) continue;

      let cursor = new Date(start);
      while (cursor <= rangeStart) {
        cursor = nextOccurrence(cursor, tx.recurrence);
      }

      let occurrences = 0;
      const occurrenceDates: string[] = [];
      while (cursor <= rangeEnd) {
        if (!end || cursor <= end) {
          occurrences += 1;
          occurrenceDates.push(toIsoDate(cursor));
        }
        cursor = nextOccurrence(cursor, tx.recurrence);
      }

      if (occurrences > 0) {
        recurringItems.push({
          label: tx.description || tx.category,
          amount: Number(tx.amount) * occurrences,
          type: tx.type,
          category: tx.category,
          recurrence: tx.recurrence,
          dates: occurrenceDates,
        });
      }

    }

    const recurringIncome = recurringItems.filter(r => r.type === 'income').reduce((s, r) => s + r.amount, 0);
    const recurringExpense = recurringItems.filter(r => r.type === 'expense').reduce((s, r) => s + r.amount, 0);

    const { data: plannedRows, error: plannedError } = await db
      .from('finance_transactions')
      .select('amount, type, category, description, date, recurrence')
      .eq('recurrence', 'once')
      .gt('date', todayIso)
      .lte('date', horizonIso)
      .order('date', { ascending: true });

    if (plannedError) throw new Error(plannedError.message);

    const plannedItems: Array<{ label: string; amount: number; type: 'income' | 'expense'; date: string }> = (plannedRows ?? []).map((tx) => ({
      label: tx.description || tx.category,
      amount: Number(tx.amount),
      type: tx.type,
      date: tx.date,
    }));

    const plannedIncome = plannedItems.filter(r => r.type === 'income').reduce((s, r) => s + r.amount, 0);
    const plannedExpense = plannedItems.filter(r => r.type === 'expense').reduce((s, r) => s + r.amount, 0);

    const minForecast = currentBalance + recurringIncome - recurringExpense + plannedIncome - plannedExpense;

    const avgItems: Array<{ label: string; amount: number }> = [];
    const categoryTotals: Record<string, number[]> = {};
    const monthsToCheck = 3;

    for (let i = 1; i <= monthsToCheck; i++) {
      const date = new Date(currentYear, currentMonth - 1 - i, 1);
      const y = date.getFullYear();
      const m = date.getMonth() + 1;
      try {
        const pastData = await this.getMonthData(y, m);
        const irregular = (pastData.transactions ?? []).filter(
          tx => tx.type === 'expense' && (!tx.recurrence || tx.recurrence === 'once'),
        );
        for (const tx of irregular) {
          if (!categoryTotals[tx.category]) categoryTotals[tx.category] = [];
          categoryTotals[tx.category].push(tx.amount);
        }
      } catch {
        // month may not exist
      }
    }

    const periodFactor = periodDays / 30;
    for (const [cat, amounts] of Object.entries(categoryTotals)) {
      const avg = amounts.reduce((s, a) => s + a, 0) / monthsToCheck;
      avgItems.push({ label: cat, amount: Math.round(avg * periodFactor) });
    }

    const avgTotal = avgItems.reduce((s, a) => s + a.amount, 0);
    const realisticForecast = minForecast - avgTotal;

    let alertDate: string | null = null;
    if (minBalance > 0 && realisticForecast <= minBalance) {
      const dailyBurn = avgTotal / periodDays;
      const daysUntilThreshold = dailyBurn > 0
        ? Math.floor((currentBalance + recurringIncome - recurringExpense - minBalance) / dailyBurn)
        : null;
      if (daysUntilThreshold !== null && daysUntilThreshold > 0) {
        const alertD = new Date();
        alertD.setDate(alertD.getDate() + daysUntilThreshold);
        alertDate = alertD.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
      } else if (realisticForecast <= minBalance) {
        alertDate = 'уже сейчас';
      }
    }

    return {
      currentBalance,
      minForecast,
      realisticForecast,
      recurringItems,
      plannedItems,
      avgItems,
      alertDate,
      minBalance,
      periodStart: todayIso,
      periodEnd: horizonIso,
    };
  }

  // ── Recurring confirmations ──────────────────────────────────────────────

  /**
   * Returns recurring transaction templates that have an occurrence on the given date
   * and have NOT yet been confirmed or skipped.
   */
  async getRecurringDueOn(date: string): Promise<Transaction[]> {
    const db = getDb();
    const { data, error } = await db
      .from('finance_transactions')
      .select('*')
      .neq('recurrence', 'once')
      .lte('date', date)
      .order('date', { ascending: true });

    if (error) throw new Error(error.message);

    const templates: Transaction[] = (data ?? []).map((row) => ({
      id: row.id,
      amount: Number(row.amount),
      type: row.type,
      category: row.category,
      description: row.description ?? undefined,
      date: row.date,
      recurrence: row.recurrence,
      recurrence_end: row.recurrence_end ?? undefined,
    }));

    const targetDate = new Date(`${date}T00:00:00`);
    const due: Transaction[] = [];

    for (const tx of templates) {
      const end = tx.recurrence_end ? new Date(`${tx.recurrence_end}T00:00:00`) : null;
      if (end && end < targetDate) continue;

      // Walk occurrences until we reach targetDate
      let cursor = new Date(`${tx.date}T00:00:00`);
      while (cursor < targetDate) {
        cursor = nextOccurrence(cursor, tx.recurrence);
      }

      if (toIsoDate(cursor) === date) {
        // Check if already handled
        const handled = await this.isOccurrenceHandled(tx.id, date);
        if (!handled) due.push(tx);
      }
    }

    return due;
  }

  async isOccurrenceHandled(recurringTxId: string, date: string): Promise<boolean> {
    const db = getDb();
    const { data, error } = await db
      .from('recurring_confirmations')
      .select('id')
      .eq('recurring_tx_id', recurringTxId)
      .eq('date', date)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return !!data;
  }

  async confirmOccurrence(recurringTxId: string, date: string, amount: number, tx: Pick<Transaction, 'type' | 'category' | 'description'>): Promise<Transaction> {
    const db = getDb();
    // Record confirmation
    await db.from('recurring_confirmations').upsert(
      { recurring_tx_id: recurringTxId, date, action: 'confirmed', amount },
      { onConflict: 'recurring_tx_id,date' },
    );
    // Add as one-time persisted transaction
    return this.addTransaction({
      amount,
      type: tx.type,
      category: tx.category,
      description: tx.description,
      date,
      recurrence: 'once',
    });
  }

  async skipOccurrence(recurringTxId: string, date: string): Promise<void> {
    const db = getDb();
    await db.from('recurring_confirmations').upsert(
      { recurring_tx_id: recurringTxId, date, action: 'skipped' },
      { onConflict: 'recurring_tx_id,date' },
    );
  }
}
