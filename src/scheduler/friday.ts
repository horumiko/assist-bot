import { Bot } from 'grammy';
import { TodoistService } from '../services/todoist';
import { CalendarService } from '../services/calendar';
import { FinanceService } from '../services/finance';
import { LLMClient } from '../llm/client';
import { formatDueDate } from '../bot/formatters';
import { formatMoney } from '../bot/finance-formatters';
import { logger } from '../utils/logger';

type AnalysisPeriod = 'month' | 'quarter' | 'year';
type AnalysisScope = 'tasks' | 'finance' | 'combined';

function getPeriodConfig(period: AnalysisPeriod): { months: number; label: string } {
  if (period === 'month') return { months: 1, label: 'месяц' };
  if (period === 'quarter') return { months: 3, label: 'квартал' };
  return { months: 12, label: 'год' };
}

function shiftMonth(year: number, month: number, delta: number): { year: number; month: number } {
  const index = year * 12 + (month - 1) + delta;
  const nextYear = Math.floor(index / 12);
  const nextMonth = (index % 12 + 12) % 12 + 1;
  return { year: nextYear, month: nextMonth };
}

function startOfAnalysisPeriod(period: AnalysisPeriod): Date {
  const now = new Date();
  const start = new Date(now);
  if (period === 'month') {
    start.setMonth(start.getMonth() - 1);
  } else if (period === 'quarter') {
    start.setMonth(start.getMonth() - 3);
  } else {
    start.setFullYear(start.getFullYear() - 1);
  }
  return start;
}

export async function generateStrategicAnalysis(
  todoist: TodoistService,
  llm: LLMClient,
  finance: FinanceService | undefined,
  period: AnalysisPeriod,
  scope: AnalysisScope = 'combined',
): Promise<string> {
  const now = new Date();
  const { months, label } = getPeriodConfig(period);
  const fromDate = startOfAnalysisPeriod(period);

  const [activeTasks, overdueTasks, completedTasks] = await Promise.all([
    todoist.getAllActiveTasks(),
    todoist.getOverdueTasks(),
    todoist.getCompletedTasksSince(fromDate),
  ]);

  const inProgressTasks = activeTasks.filter(t => !overdueTasks.find(o => o.id === t.id));
  const titleScope = scope === 'finance' ? 'по финансам' : scope === 'tasks' ? 'по задачам' : '';
  const parts: string[] = [
    `*Стратегическая аналитика ${titleScope} за ${label}*`,
    `Период: ${fromDate.toLocaleDateString('ru-RU')} — ${now.toLocaleDateString('ru-RU')}`,
  ];

  const contextParts: string[] = [`Период анализа: ${label}`];

  if (scope !== 'finance') {
    parts.push(
      `\n📌 *Задачи:*`,
      `• Выполнено: ${completedTasks.length}`,
      `• В работе: ${inProgressTasks.length}`,
      `• Просрочено сейчас: ${overdueTasks.length}`,
    );
    contextParts.push(
      `Выполнено задач: ${completedTasks.length}`,
      `В работе: ${inProgressTasks.length}`,
      `Просрочено: ${overdueTasks.length}`,
    );
    if (completedTasks.length > 0) {
      contextParts.push(`Примеры выполненных: ${completedTasks.slice(0, 12).map((t) => t.content).join(', ')}`);
    }
    if (overdueTasks.length > 0) {
      contextParts.push(`Просроченные: ${overdueTasks.slice(0, 12).map((t) => t.content).join(', ')}`);
    }
  }

  if (scope !== 'tasks' && finance) {
    try {
      let totalIncome = 0;
      let totalExpense = 0;
      const categoryTotals: Record<string, number> = {};
      const nowYear = now.getFullYear();
      const nowMonth = now.getMonth() + 1;
      const oldest = shiftMonth(nowYear, nowMonth, -(months - 1));

      for (let offset = 0; offset < months; offset++) {
        const current = shiftMonth(oldest.year, oldest.month, offset);
        const summary = await finance.getSummary(current.year, current.month);
        totalIncome += summary.totalIncome;
        totalExpense += summary.totalExpense;
        const monthData = await finance.getMonthData(current.year, current.month);
        for (const tx of monthData.transactions ?? []) {
          if (tx.type !== 'expense') continue;
          categoryTotals[tx.category] = (categoryTotals[tx.category] ?? 0) + tx.amount;
        }
      }

      const net = totalIncome - totalExpense;
      const topCats = Object.entries(categoryTotals)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([cat, amt]) => `${cat} (${formatMoney(amt)} ₽)`);

      parts.push(
        `\n💰 *Финансы за ${label}:*`,
        `• Доходы: ${formatMoney(totalIncome)} ₽`,
        `• Расходы: ${formatMoney(totalExpense)} ₽`,
        `• Итог: ${formatMoney(net)} ₽`,
      );
      if (topCats.length > 0) {
        parts.push(`• Топ категории расходов: ${topCats.join(', ')}`);
      }

      contextParts.push(
        `Доходы за период: ${formatMoney(totalIncome)} ₽`,
        `Расходы за период: ${formatMoney(totalExpense)} ₽`,
        `Итог за период: ${formatMoney(net)} ₽`,
      );
      if (topCats.length > 0) contextParts.push(`Крупные категории расходов: ${topCats.join(', ')}`);
    } catch (err) {
      logger.warn({ err, period }, 'Failed to aggregate finance data for strategic analysis');
      parts.push('\n💰 Финансовые данные за период недоступны.');
    }
  } else if (scope !== 'tasks') {
    parts.push('\n💰 Финансовые данные за период недоступны.');
  }

  try {
    const analysis = await llm.generateFridayReport(contextParts.join('. '), label, scope);
    if (analysis) {
      parts.push(`\n🧠 *Выводы и план:*\n${analysis}`);
    }
  } catch (err) {
    logger.warn({ err, period }, 'Failed to generate strategic LLM analysis');
  }

  return parts.join('\n');
}

export async function generateReport(
  todoist: TodoistService,
  calendar: CalendarService,
  llm: LLMClient,
  finance?: FinanceService,
): Promise<string> {
  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);

  const [activeTasks, overdueTasks, completedTasks, weekEvents] = await Promise.all([
    todoist.getAllActiveTasks(),
    todoist.getOverdueTasks(),
    todoist.getCompletedTasksSince(weekAgo),
    calendar.getWeekEvents().catch((err) => {
      logger.warn({ err }, 'Failed to fetch calendar events for friday report');
      return [];
    }),
  ]);

  const parts: string[] = [];
  const financeContextParts: string[] = [];

  const now = new Date();
  const dateStr = now.toLocaleDateString('ru-RU', {
    day: 'numeric', month: 'long', year: 'numeric',
    timeZone: process.env.TIMEZONE || 'Europe/Minsk',
  });

  parts.push(`*Пятничный отчёт за неделю* (${dateStr})\n`);

  // Completed tasks
  if (completedTasks.length > 0) {
    const lines = [`✅ *Выполнено за неделю* (${completedTasks.length}):`];
    for (const task of completedTasks) {
      lines.push(`• ${task.content}`);
    }
    parts.push(lines.join('\n'));
  } else {
    parts.push('✅ *Выполнено за неделю:* _пока пусто_');
  }

  // In progress
  const inProgressTasks = activeTasks.filter(t => !overdueTasks.find(o => o.id === t.id));
  if (inProgressTasks.length > 0) {
    const lines = [`🔄 *В работе* (${inProgressTasks.length}):`];
    for (const task of inProgressTasks) {
      const due = task.due ? ` — до ${formatDueDate(task.due.date)}` : '';
      lines.push(`• ${task.content}${due}`);
    }
    parts.push(lines.join('\n'));
  }

  // Overdue
  if (overdueTasks.length > 0) {
    const lines = [`⚠️ *Просроченные* (${overdueTasks.length}):`];
    for (const task of overdueTasks) {
      const due = task.due ? ` (${formatDueDate(task.due.date)})` : '';
      lines.push(`• ${task.content}${due}`);
    }
    parts.push(lines.join('\n'));
  }

  // Finance weekly block
  if (finance) {
    try {
      const now = new Date();
      const summary = await finance.getSummary(now.getFullYear(), now.getMonth() + 1);
      const weekAgoStr = weekAgo.toISOString().split('T')[0];
      const monthData = await finance.getMonthData(now.getFullYear(), now.getMonth() + 1);
      const weekTxs = (monthData.transactions ?? []).filter(tx => tx.date >= weekAgoStr);

      const weekIncome = weekTxs.filter(tx => tx.type === 'income').reduce((s, tx) => s + tx.amount, 0);
      const weekExpense = weekTxs.filter(tx => tx.type === 'expense').reduce((s, tx) => s + tx.amount, 0);

      // Top categories by spending
      const catTotals: Record<string, number> = {};
      for (const tx of weekTxs.filter(tx => tx.type === 'expense')) {
        catTotals[tx.category] = (catTotals[tx.category] ?? 0) + tx.amount;
      }
      const topCats = Object.entries(catTotals)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([cat, amt]) => `${cat} (${formatMoney(amt)}₽)`)
        .join(', ');

      const finLines = [
        '📊 *Финансы за неделю:*',
        `  Доходы: ${formatMoney(weekIncome)} ₽`,
        `  Расходы: ${formatMoney(weekExpense)} ₽`,
      ];
      if (topCats) finLines.push(`  Топ категории: ${topCats}`);
      financeContextParts.push(
        `Доходы за неделю: ${formatMoney(weekIncome)} ₽`,
        `Расходы за неделю: ${formatMoney(weekExpense)} ₽`,
      );
      if (topCats) financeContextParts.push(`Топ категорий расходов: ${topCats}`);

      const overBudget = (summary.budgets ?? []).filter((b) => b.limit > 0 && b.spent >= b.limit * 0.8);
      if (overBudget.length > 0) {
        financeContextParts.push(
          `Категории с риском/перерасходом: ${overBudget
            .map((b) => `${b.category} (${formatMoney(b.spent)} из ${formatMoney(b.limit)} ₽)`)
            .join(', ')}`,
        );
      }

      // Forecast for end of month
      try {
        const forecast = await finance.computeForecast('month');
        finLines.push(`  Форкаст на конец месяца: ~${formatMoney(forecast.realisticForecast)} ₽`);
        financeContextParts.push(`Форкаст на конец месяца: ${formatMoney(forecast.realisticForecast)} ₽`);
      } catch { /* best-effort */ }

      parts.push(finLines.join('\n'));
    } catch (err) {
      logger.warn({ err }, 'Failed to fetch finance data for friday report');
    }
  }

  // Generate LLM analysis
  const contextText = [
    `Выполнено за неделю: ${completedTasks.length} задач`,
    `В работе: ${inProgressTasks.length} задач`,
    `Просрочено: ${overdueTasks.length} задач`,
    `Событий на неделе: ${weekEvents.length}`,
    completedTasks.length > 0 ? `Выполненные: ${completedTasks.slice(0, 5).map(t => t.content).join(', ')}` : '',
    inProgressTasks.length > 0 ? `В работе: ${inProgressTasks.slice(0, 5).map(t => t.content).join(', ')}` : '',
    overdueTasks.length > 0 ? `Просроченные: ${overdueTasks.map(t => t.content).join(', ')}` : '',
    ...financeContextParts,
  ].filter(Boolean).join('. ');

  try {
    const analysis = await llm.generateFridayReport(contextText, 'неделя');
    if (analysis) {
      parts.push(`\n🤖 *Анализ недели:*\n${analysis}`);
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to generate LLM friday analysis');
  }

  return parts.join('\n\n');
}

export async function sendFridayReport(
  bot: Bot,
  userId: number,
  todoist: TodoistService,
  calendar: CalendarService,
  llm: LLMClient,
  finance?: FinanceService,
): Promise<void> {
  logger.info('Sending friday report');

  try {
    const report = await generateReport(todoist, calendar, llm, finance);
    await bot.api.sendMessage(userId, report, {
      parse_mode: 'Markdown',
      link_preview_options: { is_disabled: true },
    });
    logger.info('Friday report sent');
  } catch (err) {
    logger.error({ err }, 'Failed to send friday report');
    await bot.api.sendMessage(userId, 'Ошибка при генерации пятничного отчёта.').catch(() => {});
  }
}
