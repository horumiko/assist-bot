import { Bot } from 'grammy';
import { Task } from '@doist/todoist-api-typescript';
import { TodoistService } from '../services/todoist';
import { CalendarService } from '../services/calendar';
import { FinanceService } from '../services/finance';
import { LLMClient } from '../llm/client';
import { formatEventList, formatDueDate, formatStaleTaskMessage } from '../bot/formatters';
import { formatMoney } from '../bot/finance-formatters';
import { getStatusThresholdHours } from '../config/settings';
import { logger } from '../utils/logger';

export async function sendMorningBriefing(
  bot: Bot,
  userId: number,
  todoist: TodoistService,
  calendar: CalendarService,
  llm: LLMClient,
  finance?: FinanceService,
): Promise<void> {
  logger.info('Sending morning briefing');

  try {
    const [allTasks, events, overdueTasks] = await Promise.all([
      todoist.getAllActiveTasks(),
      calendar.getTodayEvents(),
      todoist.getOverdueTasks(),
    ]);

    const thresholdHours = await getStatusThresholdHours();
    const staleTaskIds = await todoist.getStaleTaskIds(thresholdHours);
    const staleTasks = allTasks.filter(t => staleTaskIds.includes(t.id));

    const now = new Date();
    const dateStr = now.toLocaleDateString('ru-RU', {
      weekday: 'long', day: 'numeric', month: 'long',
      timeZone: process.env.TIMEZONE || 'Europe/Minsk',
    });

    const parts: string[] = [];
    parts.push(`*Доброе утро! ${dateStr}*\n`);

    // Today's events
    if (events.length > 0) {
      parts.push(formatEventList(events));
    } else {
      parts.push('_Событий сегодня нет_');
    }

    // Active tasks
    const activeTasks = allTasks.filter(t => !overdueTasks.find(o => o.id === t.id));
    if (activeTasks.length > 0) {
      const lines = [`*Активные задачи* (${activeTasks.length}):`];
      for (const task of activeTasks.slice(0, 10)) {
        const due = task.due ? ` — до ${formatDueDate(task.due.date)}` : '';
        const bitrix = task.labels.includes('bitrix') ? ' 🔗' : '';
        lines.push(`• ${task.content}${due}${bitrix}`);
      }
      if (activeTasks.length > 10) {
        lines.push(`_... и ещё ${activeTasks.length - 10} задач_`);
      }
      parts.push(lines.join('\n'));
    }

    // Overdue tasks
    if (overdueTasks.length > 0) {
      const lines = [`⚠️ *Просроченные задачи* (${overdueTasks.length}):`];
      for (const task of overdueTasks) {
        const due = task.due ? ` (${formatDueDate(task.due.date)})` : '';
        lines.push(`• ${task.content}${due}`);
      }
      parts.push(lines.join('\n'));
    }

    // Finance block
    if (finance) {
      try {
        const now = new Date();
        const summary = await finance.getSummary(now.getFullYear(), now.getMonth() + 1);
        const finLines = ['💰 *Финансы:*'];
        finLines.push(`  Баланс: *${formatMoney(summary.balance)} ₽*`);

        // Yesterday's spending
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        const yesterdayStr = yesterday.toISOString().split('T')[0];
        const monthData = await finance.getMonthData(now.getFullYear(), now.getMonth() + 1);
        const yesterdaySpent = (monthData.transactions ?? [])
          .filter(tx => tx.type === 'expense' && tx.date === yesterdayStr)
          .reduce((s, tx) => s + tx.amount, 0);
        if (yesterdaySpent > 0) {
          finLines.push(`  Потрачено за вчера: ${formatMoney(yesterdaySpent)} ₽`);
        }

        // Budget warnings
        const overBudget = (summary.budgets ?? []).filter(b => b.limit > 0 && b.spent >= b.limit * 0.75);
        for (const b of overBudget) {
          const pct = Math.round((b.spent / b.limit) * 100);
          const remaining = b.limit - b.spent;
          if (remaining <= 0) {
            finLines.push(`  🔴 «${b.category}» — перерасход!`);
          } else {
            finLines.push(`  ⚠️ «${b.category}» — ${pct}% бюджета`);
          }
        }

        // Min balance alert
        const minBalance = await finance.getMinBalance();
        if (minBalance > 0 && summary.balance <= minBalance) {
          finLines.push(`  🚨 Баланс ${formatMoney(summary.balance)} ₽ — ниже порога ${formatMoney(minBalance)} ₽!`);
        }

        parts.push(finLines.join('\n'));
      } catch (err) {
        logger.warn({ err }, 'Failed to fetch finance data for morning briefing');
      }
    }

    // Send main briefing
    await bot.api.sendMessage(userId, parts.join('\n\n'), {
      parse_mode: 'Markdown',
      link_preview_options: { is_disabled: true },
    });

    // Send stale tasks as separate messages without inline controls
    if (staleTasks.length > 0) {
      await bot.api.sendMessage(
        userId,
        `*Требуют обновления статуса* (не обновлялись более ${thresholdHours}ч):`,
        { parse_mode: 'Markdown' }
      );

      for (const task of staleTasks.slice(0, 5)) {
        const log = await todoist.getStatusLog(task.id);
        const hoursSince = log
          ? Math.floor((Date.now() - new Date(log.lastStatusUpdate).getTime()) / 3600000)
          : thresholdHours;

        await bot.api.sendMessage(
          userId,
          `${formatStaleTaskMessage(task, hoursSince)}\n\nОбнови статус через кнопку *📝 Дать статус* в меню бота.`,
          { parse_mode: 'Markdown' }
        );
      }
    }

    // LLM summary if there's something to analyze
    if (allTasks.length > 0 || events.length > 0) {
      const contextText = [
        `Задач всего: ${allTasks.length}`,
        `Просрочено: ${overdueTasks.length}`,
        `Требуют обновления: ${staleTasks.length}`,
        `Событий сегодня: ${events.length}`,
      ].join(', ');

      try {
        const summary = await llm.generateBriefingSummary(contextText);
        if (summary) {
          await bot.api.sendMessage(userId, `💡 ${summary}`, { parse_mode: 'Markdown' });
        }
      } catch (err) {
        logger.warn({ err }, 'Failed to generate LLM briefing summary');
      }
    }

    logger.info('Morning briefing sent');
  } catch (err) {
    logger.error({ err }, 'Failed to send morning briefing');
    await bot.api.sendMessage(userId, 'Ошибка при генерации утреннего брифинга.').catch(() => {});
  }
}
