import { Bot } from 'grammy';
import { CalendarService } from '../services/calendar';
import { getDb } from '../db/database';
import { logger } from '../utils/logger';

const REMINDER_MINUTES = 15;

export async function checkAndSendReminders(
  bot: Bot,
  userId: number,
  calendar: CalendarService,
): Promise<void> {
  try {
    const upcoming = await calendar.getUpcomingEvents(REMINDER_MINUTES + 5);
    if (upcoming.length === 0) return;

    const db = getDb();
    const now = Date.now();
    const reminderWindowStart = now + (REMINDER_MINUTES - 2) * 60 * 1000;
    const reminderWindowEnd = now + (REMINDER_MINUTES + 3) * 60 * 1000;

    for (const event of upcoming) {
      const eventStartMs = event.startTime.getTime();

      // Only notify for events starting within the reminder window
      if (eventStartMs < reminderWindowStart || eventStartMs > reminderWindowEnd) continue;

      // Check if reminder already sent
      const { data: existing, error: selectError } = await db
        .from('calendar_reminders')
        .select('reminder_sent')
        .eq('event_id', event.id)
        .maybeSingle();

      if (selectError) {
        logger.warn({ err: selectError, eventId: event.id }, 'Failed to check existing reminder state');
      }

      if (existing?.reminder_sent) continue;

      // Send reminder
      const timeStr = event.startTime.toLocaleTimeString('ru-RU', {
        hour: '2-digit',
        minute: '2-digit',
        timeZone: process.env.TIMEZONE || 'Europe/Minsk',
      });

      let text = `⏰ *Через ${REMINDER_MINUTES} минут:*\n\n*${event.title}*\n🕐 ${timeStr}`;
      if (event.location) text += `\n📍 ${event.location}`;
      if (event.meetLink) text += `\n🔗 [Ссылка на встречу](${event.meetLink})`;

      await bot.api.sendMessage(userId, text, {
        parse_mode: 'Markdown',
        link_preview_options: { is_disabled: true },
      });

      // Mark as sent
      const { error: upsertError } = await db.from('calendar_reminders').upsert(
        {
          event_id: event.id,
          event_title: event.title,
          start_time: event.startTime.toISOString(),
          reminder_sent: true,
        },
        { onConflict: 'event_id' }
      );

      if (upsertError) {
        logger.warn({ err: upsertError, eventId: event.id }, 'Failed to save reminder state');
      }

      logger.info({ eventId: event.id, title: event.title }, 'Reminder sent');
    }
  } catch (err) {
    logger.error({ err }, 'Failed to check reminders');
  }
}

export async function cleanupOldReminders(): Promise<void> {
  const db = getDb();
  const dayAgoIso = new Date(Date.now() - 86400 * 1000).toISOString();
  await db.from('calendar_reminders').delete().lt('start_time', dayAgoIso);
}
