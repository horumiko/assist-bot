import 'dotenv/config';
import { Bot } from 'grammy';
import { logger } from './utils/logger';
import { runMigrations } from './db/migrate';
import { TodoistService } from './services/todoist';
import { CalendarService } from './services/calendar';
import { BitrixService } from './services/bitrix';
import { FinanceService } from './services/finance';
import { setupHandlers } from './bot/handlers';
import { startScheduler } from './scheduler/index';

async function main() {
  logger.info('Starting Telegram assistant bot...');

  // Run DB migrations
  await runMigrations();

  // Initialize services
  const services = {
    todoist: new TodoistService(),
    calendar: new CalendarService(),
    bitrix: new BitrixService(),
    finance: new FinanceService(),
  };

  // Initialize bot
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not set');

  const bot = new Bot(token);

  // Setup handlers
  setupHandlers(bot, services);

  // Start scheduler
  await startScheduler(bot, services);

  // Error handler
  bot.catch((err) => {
    logger.error({ err }, 'Bot error');
  });

  // Graceful shutdown
  process.once('SIGINT', () => {
    logger.info('Shutting down...');
    bot.stop();
  });
  process.once('SIGTERM', () => {
    logger.info('Shutting down...');
    bot.stop();
  });

  // Start the bot
  await bot.start({
    onStart: (info) => {
      logger.info({ username: info.username }, 'Bot started');
    },
  });
}

main().catch((err) => {
  logger.error({ err }, 'Fatal error');
  process.exit(1);
});
