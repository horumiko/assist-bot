import { Bot } from 'grammy';
import { TodoistService } from '../services/todoist';
import { CalendarService } from '../services/calendar';
import { FinanceService } from '../services/finance';
import { LLMClient } from '../llm/client';
import { formatDueDate } from '../bot/formatters';
import { formatMoney } from '../bot/finance-formatters';
import { getStatusThresholdHours } from '../config/settings';
import { logger } from '../utils/logger';

const TZ = process.env.TIMEZONE || 'Europe/Minsk';
const SEP = '——————————————';

function getTodayIso(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
}

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
    const staleTasks = allTasks.filter((t) => staleTaskIds.includes(t.id));
    const overdueIds = new Set(overdueTasks.map((t) => t.id));
    const activeTasks = allTasks.filter((t) => !overdueIds.has(t.id));

    const now = new Date();
    const dateStr = now.toLocaleDateString('ru-RU', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      timeZone: TZ,
    });

    const sections: string[] = [];

    // ── Заголовок ──────────────────────────────────────────
    sections.push(`☀️ *Доброе утро!*\n_${capitalize(dateStr)}_`);

    // ── Календарь ──────────────────────────────────────────
    if (events.length > 0) {
      const lines = [`📅 *Календарь* (${events.length})`];
      for (const ev of events) {
        const t = ev.startTime.toLocaleTimeString('ru-RU', {
          hour: '2-digit',
          minute: '2-digit',
          timeZone: TZ,
        });
        const link = ev.meetLink ? ` — [Meet](${ev.meetLink})` : '';
        lines.push(`• ${t}  ${ev.title}${link}`);
      }
      sections.push(lines.join('\n'));
    }

    // ── Задачи без апдейта ─────────────────────────────────
    if (staleTasks.length > 0) {
      const lines = [`🔔 *Нужен апдейт* (${staleTasks.length})`];
      for (const task of staleTasks.slice(0, 7)) {
        const log = await todoist.getStatusLog(task.id);
        const hoursSince = log
          ? Math.floor((Date.now() - new Date(log.lastStatusUpdate).getTime()) / 3600000)
          : thresholdHours;
        const timeLabel = hoursSince >= 24
          ? `${Math.floor(hoursSince / 24)}д ${hoursSince % 24}ч`
          : `${hoursSince}ч`;
        lines.push(`• ${task.content} — _${timeLabel} без обновления_`);
      }
      if (staleTasks.length > 7) {
        lines.push(`_... и ещё ${staleTasks.length - 7}_`);
      }
      sections.push(lines.join('\n'));
    }

    // ── Просрочено ─────────────────────────────────────────
    if (overdueTasks.length > 0) {
      const lines = [`⚠️ *Просрочено* (${overdueTasks.length})`];
      for (const task of overdueTasks.slice(0, 5)) {
        const due = task.due ? ` — ${formatDueDate(task.due.date)}` : '';
        lines.push(`• ${task.content}${due}`);
      }
      if (overdueTasks.length > 5) lines.push(`_... и ещё ${overdueTasks.length - 5}_`);
      sections.push(lines.join('\n'));
    }

    // ── Активные задачи ────────────────────────────────────
    if (activeTasks.length > 0) {
      const nonStale = activeTasks.filter((t) => !staleTaskIds.includes(t.id));
      const lines = [`✅ *Задачи* (${activeTasks.length})`];
      for (const task of nonStale.slice(0, 8)) {
        const due = task.due ? ` — до ${formatDueDate(task.due.date)}` : '';
        const mark = task.labels.includes('bitrix') ? ' 🔗' : '';
        lines.push(`• ${task.content}${due}${mark}`);
      }
      if (nonStale.length > 8) lines.push(`_... и ещё ${nonStale.length - 8}_`);
      sections.push(lines.join('\n'));
    }

    // ── Финансы ────────────────────────────────────────────
    if (finance) {
      const finBlock = await buildFinanceBlock(finance);
      if (finBlock) sections.push(finBlock);
    }

    // ── Сборка сообщения ───────────────────────────────────
    const body = sections.join(`\n\n${SEP}\n\n`);

    // ── LLM-сводка ─────────────────────────────────────────
    let llmSuffix = '';
    if (allTasks.length > 0 || events.length > 0) {
      try {
        const ctx = [
          `Задач: ${allTasks.length}`,
          `Просрочено: ${overdueTasks.length}`,
          `Без апдейта: ${staleTasks.length}`,
          `Событий: ${events.length}`,
        ].join(', ');
        const summary = await llm.generateBriefingSummary(ctx);
        if (summary) llmSuffix = `\n\n${SEP}\n\n💡 _${summary}_`;
      } catch (err) {
        logger.warn({ err }, 'LLM briefing summary failed');
      }
    }

    await bot.api.sendMessage(userId, body + llmSuffix, {
      parse_mode: 'Markdown',
      link_preview_options: { is_disabled: true },
    });

    logger.info('Morning briefing sent');
  } catch (err) {
    logger.error({ err }, 'Failed to send morning briefing');
    await bot.api.sendMessage(userId, 'Не удалось отправить утренний брифинг.').catch(() => {});
  }
}

async function buildFinanceBlock(finance: FinanceService): Promise<string | null> {
  try {
    const now = new Date();
    const todayIso = getTodayIso();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;

    const [summary, monthData, allWithRecurring] = await Promise.all([
      finance.getSummary(year, month),
      finance.getMonthData(year, month),
      finance.getTransactionsWithRecurring(year, month),
    ]);

    // Баланс утром = до сегодняшних операций (только прошлые дни)
    const persistedBase = summary.balanceToday ?? 0;
    const persistedToday = (monthData.transactions ?? [])
      .filter((tx) => tx.date === todayIso)
      .reduce((s, tx) => s + (tx.type === 'income' ? tx.amount : -tx.amount), 0);
    const morningBalance = persistedBase - persistedToday;

    // Операции на сегодня (все: регулярные + разовые)
    const todayOps = (allWithRecurring ?? []).filter((tx) => tx.date === todayIso);
    const todayNet = todayOps.reduce((s, tx) => s + (tx.type === 'income' ? tx.amount : -tx.amount), 0);
    const endBalance = morningBalance + todayNet;

    const delta = endBalance - morningBalance;
    const deltaStr = delta === 0
      ? ''
      : delta > 0
        ? `  _(+${formatMoney(delta)} ₽)_`
        : `  _(−${formatMoney(Math.abs(delta))} ₽)_`;

    const lines: string[] = [
      '💰 *Финансы*',
      `Утро:   *${formatMoney(morningBalance)} ₽*`,
      `Вечер:  *${formatMoney(endBalance)} ₽*${deltaStr}`,
    ];

    if (todayOps.length > 0) {
      lines.push('');
      lines.push('_Операции сегодня:_');
      for (const tx of todayOps.slice(0, 6)) {
        const sign = tx.type === 'expense' ? '−' : '+';
        const label = tx.description ?? tx.category;
        const rec = tx.recurrence && tx.recurrence !== 'once' ? ' 🔁' : '';
        lines.push(`${sign}${formatMoney(tx.amount)} ₽  ${label}${rec}`);
      }
      if (todayOps.length > 6) lines.push(`_... и ещё ${todayOps.length - 6}_`);
    }

    // Предупреждения по бюджету
    const budgetWarnings = (summary.budgets ?? []).filter((b) => b.limit > 0 && b.spent >= b.limit * 0.75);
    if (budgetWarnings.length > 0) {
      lines.push('');
      for (const b of budgetWarnings) {
        const pct = Math.round((b.spent / b.limit) * 100);
        const remaining = b.limit - b.spent;
        if (remaining <= 0) {
          lines.push(`🔴 ${b.category}: перерасход на ${formatMoney(Math.abs(remaining))} ₽`);
        } else {
          lines.push(`⚠️ ${b.category}: ${pct}% лимита, осталось ${formatMoney(remaining)} ₽`);
        }
      }
    }

    // Порог баланса
    const minBalance = await finance.getMinBalance();
    if (minBalance > 0 && endBalance <= minBalance) {
      lines.push(`🚨 Баланс ниже порога ${formatMoney(minBalance)} ₽!`);
    }

    return lines.join('\n');
  } catch (err) {
    logger.warn({ err }, 'Failed to build finance block for briefing');
    return null;
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
