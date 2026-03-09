import { MonthlySummary, CategoryBudget } from '../services/finance';

const MONTH_NAMES_RU = [
  'январь', 'февраль', 'март', 'апрель', 'май', 'июнь',
  'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь',
];

export function formatMoney(amount: number): string {
  return Math.round(amount).toLocaleString('ru-RU');
}

export function formatFinanceSummary(summary: MonthlySummary, year: number, month: number): string {
  const monthName = MONTH_NAMES_RU[month - 1] ?? String(month);
  const lines: string[] = [
    `📊 *Сводка за ${monthName} ${year}*\n`,
    `💰 Баланс на сегодня: *${formatMoney(summary.balanceToday)} ₽*`,
    `📅 Баланс на конец месяца: *${formatMoney(summary.balance)} ₽*`,
    `📈 Доходы: ${formatMoney(summary.totalIncome)} ₽`,
    `📉 Расходы: ${formatMoney(summary.totalExpense)} ₽`,
    `📊 Нетто: ${summary.net >= 0 ? '+' : ''}${formatMoney(summary.net)} ₽`,
  ];

  const expenses = (summary.byCategory ?? []).filter(c => c.type === 'expense');
  if (expenses.length > 0) {
    lines.push('\n📁 *Расходы по категориям:*');
    for (const cat of expenses) {
      const budget = summary.budgets?.find(b => b.category === cat.category);
      if (budget && budget.limit > 0) {
        const pct = Math.round((budget.spent / budget.limit) * 100);
        const indicator = pct > 100 ? '🔴' : pct >= 75 ? '⚠️' : '✅';
        lines.push(`  ${cat.category}: ${formatMoney(cat.amount)} / ${formatMoney(budget.limit)} ₽ (${pct}%) ${indicator}`);
      } else {
        lines.push(`  ${cat.category}: ${formatMoney(cat.amount)} ₽`);
      }
    }
  }

  // Budget warnings
  const overLimit = (summary.budgets ?? []).filter(b => b.limit > 0 && b.spent >= b.limit * 0.75);
  for (const b of overLimit) {
    const remaining = b.limit - b.spent;
    if (remaining <= 0) {
      lines.push(`\n🔴 Перерасход: «${b.category}» — превышен на ${formatMoney(Math.abs(remaining))} ₽`);
    } else {
      lines.push(`\n⚠️ Внимание: «${b.category}» — осталось ${formatMoney(remaining)} ₽ до лимита`);
    }
  }

  return lines.join('\n');
}

export function formatFinanceBalanceView(data: {
  balanceToday: number;
  balanceEndOfDay: number;
  todayOps: Array<{
    amount: number;
    type: 'income' | 'expense';
    category: string;
    description?: string;
  }>;
  budgetsText: string;
}): string {
  const lines: string[] = [
    '💰 *Баланс*\n',
    `💰 Баланс на сегодня: *${formatMoney(data.balanceToday)} ₽*`,
    `🌙 Баланс на конец дня: *${formatMoney(data.balanceEndOfDay)} ₽*`,
    '\n🕐 *Операции за сегодня:*',
  ];

  if (data.todayOps.length === 0) {
    lines.push('  Нет операций за сегодня.');
  } else {
    for (const tx of data.todayOps) {
      const sign = tx.type === 'income' ? '+' : '−';
      const desc = tx.description ? ` | ${tx.description}` : '';
      lines.push(`  ${sign}${formatMoney(tx.amount)} ₽ | ${tx.category}${desc}`);
    }
  }

  lines.push('\n' + data.budgetsText);
  return lines.join('\n');
}

export function formatBudgetStatus(budgets: CategoryBudget[]): string {
  if (budgets.length === 0) return '💳 Бюджеты не установлены.\n\nНапиши "поставь лимит 15000 на еду" или используй кнопку «💳 Бюджеты».';

  const lines = ['💳 *Бюджеты:*\n'];
  for (const b of budgets) {
    if (b.limit <= 0) continue;
    const pct = Math.round((b.spent / b.limit) * 100);
    const bar = buildProgressBar(pct);
    const indicator = pct > 100 ? '🔴' : pct >= 75 ? '⚠️' : '✅';
    lines.push(`${indicator} *${b.category}*`);
    lines.push(`   ${formatMoney(b.spent)} / ${formatMoney(b.limit)} ₽ (${pct}%)`);
    lines.push(`   ${bar}`);
  }

  return lines.join('\n');
}

export function formatForecast(
  data: {
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
  },
  period: 'week' | 'month' | 'quarter' | 'year',
): string {
  const periodLabel = period === 'week' ? 'неделю' : period === 'month' ? 'месяц' : period === 'quarter' ? 'квартал' : 'год';
  const start = formatShortDate(data.periodStart);
  const end = formatShortDate(data.periodEnd);
  const lines: string[] = [`📈 *Форкаст на ${periodLabel} (${start}-${end})*\n`, `💰 Текущий баланс: *${formatMoney(data.currentBalance)} ₽*\n`];

  lines.push('📋 *Минимальный (только регулярные):*');
  const recurringSorted = [...data.recurringItems].sort((a, b) => {
    const aFirst = a.dates[0] ?? '9999-12-31';
    const bFirst = b.dates[0] ?? '9999-12-31';
    return aFirst.localeCompare(bFirst);
  });

  if (recurringSorted.length > 0) {
    for (const item of recurringSorted) {
      const sign = item.type === 'income' ? '+' : '−';
      lines.push(`  ${sign} ${item.label}: ${formatMoney(item.amount)} ₽, ${formatDateList(item.dates)}`);
    }
  } else {
    lines.push('  Нет регулярных операций в этом диапазоне.');
  }

  if (data.plannedItems.length > 0) {
    const plannedSorted = [...data.plannedItems].sort((a, b) => a.date.localeCompare(b.date));
    lines.push('\n🗓 *Запланированные разовые операции:*');
    for (const item of plannedSorted) {
      const sign = item.type === 'income' ? '+' : '−';
      lines.push(`  ${sign} ${item.label}: ${formatMoney(item.amount)} ₽, ${formatShortDate(item.date)}`);
    }
  }

  lines.push(`  = *${formatMoney(data.minForecast)} ₽*\n`);

  if (data.avgItems.length > 0) {
    lines.push('📊 *Реалистичный (с учётом средних трат):*');
    for (const item of data.avgItems) {
      lines.push(`  − ${item.label} (среднее): ~${formatMoney(item.amount)} ₽`);
    }
    lines.push(`  = *~${formatMoney(data.realisticForecast)} ₽*\n`);
  }

  if (data.minBalance > 0 && data.realisticForecast <= data.minBalance) {
    if (data.alertDate === 'уже сейчас') {
      lines.push(`🚨 При текущих тратах прогноз уже ниже порога ${formatMoney(data.minBalance)} ₽.`);
    } else if (data.alertDate) {
      lines.push(`🚨 При текущих тратах баланс упадёт ниже ${formatMoney(data.minBalance)} ₽ примерно *${data.alertDate}*.`);
    } else {
      lines.push(`🚨 При текущих тратах прогноз ниже порога ${formatMoney(data.minBalance)} ₽.`);
    }
  } else if (data.minBalance > 0) {
    lines.push(`✅ При текущих тратах баланс не упадёт ниже порога (${formatMoney(data.minBalance)} ₽)`);
  }

  return lines.join('\n');
}

function formatShortDate(iso: string): string {
  const [year, month, day] = iso.split('-');
  if (!year || !month || !day) return iso;
  return `${day}.${month}.${year.slice(-2)}`;
}

function formatDateList(dates: string[]): string {
  if (dates.length === 0) return 'нет дат';
  return dates.map(formatShortDate).join(', ');
}

function buildProgressBar(pct: number): string {
  const filled = Math.min(10, Math.round(pct / 10));
  return '█'.repeat(filled) + '░'.repeat(10 - filled) + ` ${pct}%`;
}

export function formatRecurrenceLabel(r: string): string {
  switch (r) {
    case 'daily': return 'Ежедневная';
    case 'weekly': return 'Еженедельная';
    case 'monthly': return 'Ежемесячная';
    case 'quarterly': return 'Ежеквартальная';
    default: return 'Разовая';
  }
}

export function formatTxCard(tx: {
  amount: number;
  type: 'income' | 'expense';
  category: string;
  description?: string;
  date: string;
  recurrence?: string;
  recurrence_end?: string;
}): string {
  const typeLabel = tx.type === 'expense' ? '💸 Расход' : '💰 Доход';
  const dateStr = new Date(tx.date).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const lines = [
    `${typeLabel}: *${formatMoney(tx.amount)} ₽*`,
    `📁 Категория: ${tx.category}`,
  ];
  if (tx.description) lines.push(`📝 ${tx.description}`);
  lines.push(`📅 ${dateStr}`);
  const recLabel = formatRecurrenceLabel(tx.recurrence ?? 'once');
  if (tx.recurrence && tx.recurrence !== 'once' && tx.recurrence_end) {
    const endStr = new Date(tx.recurrence_end).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
    lines.push(`🔁 ${recLabel} (до ${endStr})`);
  } else {
    lines.push(`🔁 ${recLabel}`);
  }
  return lines.join('\n');
}
