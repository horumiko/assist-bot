import cron from 'node-cron';
import { Bot } from 'grammy';
import { TodoistService } from '../services/todoist';
import { CalendarService } from '../services/calendar';
import { BitrixService } from '../services/bitrix';
import { FinanceService } from '../services/finance';
import { LLMClient } from '../llm/client';
import { sendMorningBriefing } from './morning';
import { sendFridayReport } from './friday';
import { sendRecurringConfirmations } from './recurring-confirm';
import { checkAndSendReminders, cleanupOldReminders } from './reminders';
import { syncTodoistCommentsToBitrix } from './comment-sync';
import { getBriefingTime, getTimezone } from '../config/settings';
import { formatMoney, formatFinanceSummary } from '../bot/finance-formatters';
import { logger } from '../utils/logger';

export async function startScheduler(
  bot: Bot,
  services: {
    todoist: TodoistService;
    calendar: CalendarService;
    bitrix: BitrixService;
    finance?: FinanceService;
  }
): Promise<void> {
  const userId = parseInt(process.env.TELEGRAM_USER_ID || '0');
  const llm = new LLMClient();
  const timezone = getTimezone();
  const finance = services.finance ?? new FinanceService();

  // Morning briefing: every day at 08:35 (Friday gets the weekly report)
  const briefingTime = await getBriefingTime();
  const [briefingHour, briefingMinute] = briefingTime.split(':');

  cron.schedule(
    `${briefingMinute} ${briefingHour} * * *`,
    async () => {
      const now = new Date();
      const isFriday = now.toLocaleDateString('en-US', { weekday: 'long', timeZone: timezone }) === 'Friday';

      if (isFriday) {
        await sendFridayReport(bot, userId, services.todoist, services.calendar, llm, finance);
      } else {
        await sendMorningBriefing(bot, userId, services.todoist, services.calendar, llm, finance);
      }
      // After briefing: send confirmations for recurring payments due today
      await sendRecurringConfirmations(bot, userId, finance);
    },
    { timezone }
  );

  // Reminder check every 5 minutes
  cron.schedule(
    '*/5 * * * *',
    async () => {
      await checkAndSendReminders(bot, userId, services.calendar);
    },
    { timezone }
  );

  // Cleanup old reminder records daily at midnight
  cron.schedule(
    '0 0 * * *',
    () => {
      cleanupOldReminders().catch((err) => {
        logger.error({ err }, 'Failed to cleanup old reminders');
      });
    },
    { timezone }
  );

  // Sync Todoist comments to Bitrix once per hour
  cron.schedule(
    '0 * * * *',
    async () => {
      await syncTodoistCommentsToBitrix(services.todoist, services.bitrix);
    },
    { timezone }
  );

  // Monthly finance report: 1st of each month at 09:00
  cron.schedule(
    '0 9 1 * *',
    async () => {
      try {
        const now = new Date();
        // Get previous month
        const prevMonth = now.getMonth() === 0 ? 12 : now.getMonth();
        const prevYear = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
        const prevMonthName = new Date(prevYear, prevMonth - 1, 1).toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' });

        const summary = await finance.getSummary(prevYear, prevMonth);

        // Compare to month before that
        const prevPrevMonth = prevMonth === 1 ? 12 : prevMonth - 1;
        const prevPrevYear = prevMonth === 1 ? prevYear - 1 : prevYear;
        let comparison = '';
        try {
          const prevSummary = await finance.getSummary(prevPrevYear, prevPrevMonth);
          if (prevSummary.totalIncome > 0) {
            const incomeDiff = Math.round((summary.totalIncome - prevSummary.totalIncome) / prevSummary.totalIncome * 100);
            const expenseDiff = Math.round((summary.totalExpense - prevSummary.totalExpense) / prevSummary.totalExpense * 100);
            comparison = `\n  Доходы: ${incomeDiff >= 0 ? '+' : ''}${incomeDiff}% к прошлому месяцу` +
              `\n  Расходы: ${expenseDiff >= 0 ? '+' : ''}${expenseDiff}% к прошлому месяцу`;
          }
        } catch { /* best-effort */ }

        // Top 3 expense categories
        const topCats = (summary.byCategory ?? [])
          .filter(c => c.type === 'expense')
          .sort((a, b) => b.amount - a.amount)
          .slice(0, 3)
          .map(c => `${c.category}: ${formatMoney(c.amount)} ₽`)
          .join(', ');

        // Budget overruns
        const overBudget = (summary.budgets ?? [])
          .filter(b => b.limit > 0 && b.spent > b.limit)
          .map(b => `${b.category} (+${formatMoney(b.spent - b.limit)} ₽ сверх лимита)`);

        const lines = [
          `📊 *Отчёт за ${prevMonthName}*\n`,
          `📈 Доходы: *${formatMoney(summary.totalIncome)} ₽*${comparison ? comparison.split('\n')[1] : ''}`,
          `📉 Расходы: *${formatMoney(summary.totalExpense)} ₽*`,
          `💰 Сэкономлено: *${formatMoney(summary.net)} ₽*`,
          comparison,
        ];

        if (topCats) lines.push(`\n🏆 Топ-3 категории расходов: ${topCats}`);
        if (overBudget.length > 0) lines.push(`\n🔴 Перерасход: ${overBudget.join(', ')}`);

        await bot.api.sendMessage(userId, lines.filter(Boolean).join('\n'), {
          parse_mode: 'Markdown',
        });
        logger.info({ prevMonth, prevYear }, 'Monthly finance report sent');
      } catch (err) {
        logger.error({ err }, 'Failed to send monthly finance report');
      }
    },
    { timezone }
  );

  // Daily min-balance alert check (runs at same time as morning briefing handled above,
  // but also separately at noon for intraday alerts)
  cron.schedule(
    '0 12 * * *',
    async () => {
      try {
        const now = new Date();
        const [summary, minBalance] = await Promise.all([
          finance.getSummary(now.getFullYear(), now.getMonth() + 1),
          finance.getMinBalance(),
        ]);
        if (minBalance > 0 && summary.balance <= minBalance) {
          await bot.api.sendMessage(
            userId,
            `🚨 Баланс *${formatMoney(summary.balance)} ₽* — ниже порога *${formatMoney(minBalance)} ₽*!`,
            { parse_mode: 'Markdown' }
          );
        }
      } catch { /* best-effort */ }
    },
    { timezone }
  );

  logger.info({ briefingTime, timezone }, 'Scheduler started');
}
