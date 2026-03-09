import { Bot, InlineKeyboard } from 'grammy';
import { FinanceService } from '../services/finance';
import { formatMoney } from '../bot/finance-formatters';
import { logger } from '../utils/logger';

const TZ = process.env.TIMEZONE || 'Europe/Minsk';

function getTodayIso(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
}

export async function sendRecurringConfirmations(
  bot: Bot,
  userId: number,
  finance: FinanceService,
): Promise<void> {
  const date = getTodayIso();
  let due: Awaited<ReturnType<typeof finance.getRecurringDueOn>>;

  try {
    due = await finance.getRecurringDueOn(date);
  } catch (err) {
    logger.warn({ err }, 'Failed to fetch recurring due transactions');
    return;
  }

  if (due.length === 0) return;

  for (const tx of due) {
    const label = tx.description ?? tx.category;
    const sign = tx.type === 'expense' ? '−' : '+';
    const typeLabel = tx.type === 'expense' ? 'Расход' : 'Доход';

    const text =
      `🔁 *Регулярный платёж*\n\n` +
      `${sign}${formatMoney(tx.amount)} ₽ — ${label}\n` +
      `_${typeLabel} · ${tx.category}_\n\n` +
      `Провести сегодня?`;

    const kb = new InlineKeyboard()
      .text('✅ Провести', `rec_confirm:${tx.id}:${date}`)
      .text('✏️ Изменить сумму', `rec_adjust:${tx.id}:${date}`)
      .row()
      .text('❌ Пропустить', `rec_skip:${tx.id}:${date}`);

    try {
      await bot.api.sendMessage(userId, text, {
        parse_mode: 'Markdown',
        reply_markup: kb,
      });
    } catch (err) {
      logger.warn({ err, txId: tx.id }, 'Failed to send recurring confirmation');
    }
  }

  logger.info({ count: due.length, date }, 'Recurring confirmations sent');
}
