import { Bot, Context, Keyboard } from 'grammy';
import { TodoistService } from '../services/todoist';
import { CalendarService } from '../services/calendar';
import { BitrixService } from '../services/bitrix';
import { FinanceService } from '../services/finance';
import { FitnessService } from '../services/fitness';
import { EXPENSE_CATEGORIES, INCOME_CATEGORIES } from '../services/finance-categories';
import { MessageRouter, TaskDraftIntent } from './router';
import { LLMClient } from '../llm/client';
import { IntentExecutor } from '../llm/executor';
import { getStatusMappings, addStatusMapping, clearStatusMappings, getConfig, getStatusThresholdHours } from '../config/settings';
import { formatTaskList, formatEventList } from './formatters';
import {
  formatMoney,
  formatFinanceBalanceView,
  formatBudgetStatus,
  formatForecast,
  formatTxCard,
  formatRecurrenceLabel,
  formatDayOpsText,
  prevDateIso,
  nextDateIso,
  formatNavDate,
} from './finance-formatters';
import {
  formatMeasurementHistory,
  formatNutritionHistory,
  formatWorkoutHistory,
  formatParsedExercises,
  formatProgressionInsight,
} from './fitness-formatters';
import { logger } from '../utils/logger';
import { parseBitrixIds } from '../services/bitrix-link';

const ALLOWED_USER_ID = parseInt(process.env.TELEGRAM_USER_ID || '0');

// Top-level menu
const MENU_TASKS_SECTION = '📋 Задачи';
const MENU_FINANCE = '💰 Финансы';

// Tasks submenu
const MENU_CREATE = '➕ Создать задачу';
const MENU_STATUS = '📝 Дать статус';
const MENU_TODAY = '📅 Сегодня';
const MENU_TASKS = '🗂 Задачи';
const MENU_OVERDUE = '⚠️ Просроченные';
const MENU_REPORT = '📈 Отчёт';
const MENU_SETTINGS = '⚙️ Настройки';
const MENU_HELP = '❓ Помощь';
const MENU_BACK_MAIN = '↩️ Главное меню';
const TASK_BACK_TO_TASKS = '↩️ К задачам';
const TASK_INBOX = '📥 Входящие';
const TASK_NO_SECTION = 'Без колонки';
const TASK_LINK_BITRIX_YES = '🔗 Да, связать с Bitrix';
const TASK_LINK_BITRIX_NO = '➡️ Нет, обычная задача';
const STATUS_COMPLETE_WITH_DONE = '✅ Done + завершить';
const STATUS_COMPLETE_ONLY = '✅ Только завершить';
const STATUS_COMPLETE_CANCEL = '↩️ К задачам';

// Finance reply keyboard button labels
const FIN_ADD = '➕ Добавить'
const FIN_SUMMARY = '💰 Баланс'
const FIN_FORECAST_BTN = '📈 Форкаст'
const FIN_BUDGETS_BTN = '💳 Бюджеты'
const FIN_RECENT_BTN = '🕐 Операции'
const FIN_RECURRING_BTN = '🔄 Регулярные'
const FIN_SETTINGS_BTN = '⚙️ Настройки фин.'
const FIN_ANALYTICS_BTN = '🧠 Аналитика'
const FIN_CONFIRM = '✅ Верно'
const FIN_CONFIRM_LEGACY = '✅ Записать'
const FIN_EDIT_TX = '✏️ Изменить'
const FIN_CANCEL_TX = '❌ Отмена'
const FIN_FIELD_AMOUNT = '💰 Сумму'
const FIN_FIELD_CATEGORY = '📁 Категорию'
const FIN_FIELD_DATE = '📅 Дату'
const FIN_FIELD_DESC = '✏️ Название'
const FIN_FIELD_REC = '🔁 Периодичность'
const FIN_FIELD_REC_END = '📆 Дату окончания'
const FIN_BACK_TX = '↩️ К операции'
const FIN_REC_ONCE = 'Разовая'
const FIN_REC_DAILY = 'Ежедневная'
const FIN_REC_WEEKLY = 'Еженедельная'
const FIN_REC_MONTHLY = 'Ежемесячная'
const FIN_REC_QUARTERLY = 'Ежеквартальная'
const FIN_ENDLESS = 'Бессрочно'
const FIN_TX_DELETE = '🗑 Удалить'
const FIN_TX_PAUSE = '⏸ Пауза'
const FIN_BACK_FIN = '↩️ Финансы'
const FIN_BACK_RECENT = '↩️ К операциям'
const FIN_BACK_RECURRING = '↩️ К платежам'
const FIN_BAL = '💵 Начальный баланс'
const FIN_THRESHOLD_BTN = '🚨 Минимальный порог'
const FIN_FC_WEEK = '📅 7 дней'
const FIN_FC_MONTH = '📅 Месяц'
const FIN_FC_QUARTER = '📅 Квартал'
const FIN_FC_YEAR = '📅 Год'
const FIN_CONFIRM_ALL = '✅ Записать все'
const FIN_CANCEL_ALL = '❌ Отмена'
const FIN_AN_MONTH = '🗓 Месяц'
const FIN_AN_QUARTER = '🗓 Квартал'
const FIN_AN_YEAR = '🗓 Год'

// Fitness menu
const MENU_FITNESS = '💪 Фитнес'
const FIT_MEASURES = '📏 Замеры'
const FIT_NUTRITION = '🍎 Питание'
const FIT_WORKOUT = '🏋️ Тренировка'
const FIT_PROGRESS = '📊 Прогресс'
const FIT_BACK = '↩️ Главное меню'

interface PendingFinanceTx {
  amount: number;
  type: 'income' | 'expense';
  category: string;
  description?: string;
  date: string;
  recurrence: string;
  recurrence_end?: string;
}

let actionCounter = 0;
const nextActionId = () => `${Date.now()}_${++actionCounter}`;

function isAuthorized(ctx: Context): boolean {
  return ctx.from?.id === ALLOWED_USER_ID;
}

function escapeMarkdown(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/([_*`\[])/g, '\\$1');
}

function formatStatusCommentForBitrix(commentText: string): string {
  const body = commentText.trim().replace(/\s+/g, ' ');
  const date = new Date();
  const dateStr = date.toLocaleDateString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    timeZone: process.env.TIMEZONE || 'Europe/Minsk',
  });
  return `${dateStr}\n${body}`;
}

function normalizeSectionName(value: string): string {
  return value
    .toLowerCase()
    .replace(/["'`«»]/g, '')
    .replace(/[\s_\-]+/g, ' ')
    .trim();
}

function sectionNameCanonical(value: string): string {
  return normalizeSectionName(value).replace(/\s+/g, '');
}

function getSectionMatchScore(candidate: string, target: string): number {
  const cNorm = normalizeSectionName(candidate);
  const tNorm = normalizeSectionName(target);
  const cCanon = sectionNameCanonical(candidate);
  const tCanon = sectionNameCanonical(target);

  if (!tNorm) return 0;
  if (cNorm === tNorm || cCanon === tCanon) return 100;
  if (cNorm.includes(tNorm) || tNorm.includes(cNorm)) return 80;

  const cPrefix = cCanon.slice(0, 4);
  const tPrefix = tCanon.slice(0, 4);
  if (cPrefix.length >= 4 && tPrefix.length >= 4 && cPrefix === tPrefix) return 60;

  return 0;
}

function extractColumnTarget(text: string): string | null {
  const quoted = text.match(/(?:в|во)\s+колонк[ауеы]?\s+["«](.+?)["»]/i);
  if (quoted?.[1]) return quoted[1].trim();

  const plain = text.match(/(?:в|во)\s+колонк[ауеы]?\s+([^,.!?\n]+)/i);
  if (!plain?.[1]) return null;

  const tail = plain[1]
    .replace(/^(мне|ему|ей|нам|им)\s+/i, '')
    .replace(/\s+(и|а затем)\s+(заверш|закрой|выполни|готово).*$/i, '')
    .trim();
  return tail || null;
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
  if (!year || !month || !day) {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  }
  return `${year}-${month}-${day}`;
}

export function setupHandlers(bot: Bot, services: {
  todoist: TodoistService;
  calendar: CalendarService;
  bitrix: BitrixService;
  finance?: FinanceService;
}): void {
  const { todoist, calendar, bitrix } = services;
  const finance = services.finance ?? new FinanceService();
  const fitness = new FitnessService();
  const llm = new LLMClient();
  const executor = new IntentExecutor(todoist, calendar, bitrix, finance);
  const router = new MessageRouter(llm, executor);
  const pendingCreateContext = new Set<number>();
  const pendingTaskDrafts = new Map<number, TaskDraftIntent & {
    projectId?: string;
    projectName?: string;
    sectionId?: string;
    sectionName?: string;
  }>();
  const pendingStatusContext = new Map<number, {
    taskIds: string[];
    taskName: string;
    commentText?: string;
  }>();
  const pendingTaskStep = new Map<number, 'status_task_pick' | 'status_column_pick' | 'task_project_pick' | 'task_section_pick' | 'task_bitrix_pick'>();
  const pendingStatusTaskList = new Map<number, Array<{ id: string; content: string }>>();
  const pendingStatusSectionList = new Map<number, {
    taskId: string;
    taskName: string;
    sections: Array<{ id: string; name: string }>;
    currentSectionId?: string;
  }>();
  const pendingStatusCompletionChoice = new Map<number, {
    taskIds: string[];
    taskName: string;
    commentText: string;
    preferredDoneColumn: string;
  }>();
  const pendingTaskProjectList = new Map<number, Array<{ id: string; name: string }>>();
  const pendingTaskSectionList = new Map<number, Array<{ id: string; name: string }>>();

  // Finance state
  const pendingFinAdd = new Set<number>();
  const pendingFinTx = new Map<number, PendingFinanceTx>(); // userId → pending tx (one per user)
  const pendingFinStep = new Map<number, 'confirm' | 'edit_menu' | 'category' | 'recurrence' | 'recurrence_end' | 'forecast' | 'analysis' | 'settings' | 'budget_cat' | 'recent_list' | 'tx_action' | 'recurring_list' | 'recurring_action'>();
  const pendingFinTxList = new Map<number, import('../services/finance').Transaction[]>(); // for recent list selection
  const pendingFinTxSelected = new Map<number, string>(); // selected tx id
  const pendingFinRecurringList = new Map<number, import('../services/finance').Transaction[]>();
  const pendingFinMulti = new Map<number, { txs: PendingFinanceTx[]; saved: number }>();
  const pendingFinEditField = new Map<number, 'amount' | 'date' | 'description' | 'recurrence_end'>();
  const pendingFinOnboarding = new Set<number>();
  const pendingFinThreshold = new Set<number>();
  const pendingFinBudget = new Map<number, string>();

  // Current section per user
  const userSection = new Map<number, 'tasks' | 'finance' | 'fitness'>();

  // Fitness state
  const pendingFitStep = new Map<number, 'workout_input' | 'workout_name'>();
  const pendingFitWorkoutSession = new Map<number, string>(); // userId → session id

  // Recurring confirmation: adjust flow state
  const pendingRecurringAdjust = new Map<number, {
    txId: string;
    date: string;
    tx: import('../services/finance').Transaction;
    messageId: number;
  }>();

  const buildMainMenu = () => new Keyboard()
    .text(MENU_TASKS_SECTION).text(MENU_FINANCE).row()
    .text(MENU_FITNESS)
    .resized()
    .persistent();

  const buildFitnessMenu = () => new Keyboard()
    .text(FIT_MEASURES).text(FIT_NUTRITION).row()
    .text(FIT_WORKOUT).text(FIT_PROGRESS).row()
    .text(FIT_BACK)
    .resized()
    .persistent();

  const buildTasksMenu = () => new Keyboard()
    .text(MENU_CREATE).text(MENU_STATUS).row()
    .text(MENU_TODAY).text(MENU_OVERDUE).row()
    .text(MENU_BACK_MAIN)
    .resized()
    .persistent();

  const buildFinanceMenu = () => new Keyboard()
    .text(FIN_ADD).text(FIN_SUMMARY).row()
    .text(FIN_RECENT_BTN).text(FIN_FORECAST_BTN).row()
    .text(MENU_BACK_MAIN)
    .resized();

  const buildForecastPeriodMenu = () => new Keyboard()
    .text(FIN_FC_WEEK).text(FIN_FC_MONTH).text(FIN_FC_QUARTER).row()
    .text(FIN_FC_YEAR).row()
    .text(FIN_BACK_FIN)
    .resized();

  const buildAnalysisPeriodMenu = () => new Keyboard()
    .text(FIN_AN_MONTH).text(FIN_AN_QUARTER).text(FIN_AN_YEAR).row()
    .text(FIN_BACK_FIN)
    .resized();

  const buildTxConfirmKeyboard = () => new Keyboard()
    .text(FIN_CONFIRM).text(FIN_EDIT_TX).text(FIN_CANCEL_TX)
    .resized();

  const extractLooseDateByMarker = (text: string, marker: 'на' | 'с' | 'до'): string | null => {
    const rx = new RegExp(`(?:^|\\s)${marker}\\s*(\\d{1,2}[.\\/-]\\d{1,2}(?:[.\\/-]\\d{2,4})?)`, 'i');
    const m = text.match(rx);
    if (!m?.[1]) return null;
    const raw = m[1].trim();
    const full = raw.match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})$/);
    if (full) return `${full[3]}-${String(Number(full[2])).padStart(2, '0')}-${String(Number(full[1])).padStart(2, '0')}`;
    const shortYear = raw.match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{2})$/);
    if (shortYear) {
      const y = Number(shortYear[3]);
      const yyyy = y >= 70 ? 1900 + y : 2000 + y;
      return `${yyyy}-${String(Number(shortYear[2])).padStart(2, '0')}-${String(Number(shortYear[1])).padStart(2, '0')}`;
    }
    const short = raw.match(/^(\d{1,2})[.\/-](\d{1,2})$/);
    if (short) {
      const yyyy = new Date().getFullYear();
      return `${yyyy}-${String(Number(short[2])).padStart(2, '0')}-${String(Number(short[1])).padStart(2, '0')}`;
    }
    return null;
  };

  const buildTxEditFieldKeyboard = (isRecurring?: boolean) => {
    const kb = new Keyboard()
      .text(FIN_FIELD_AMOUNT).text(FIN_FIELD_CATEGORY).row()
      .text(FIN_FIELD_DATE).text(FIN_FIELD_DESC).row()
      .text(FIN_FIELD_REC).row();
    if (isRecurring) kb.text(FIN_FIELD_REC_END).row();
    kb.text(FIN_BACK_TX);
    return kb.resized();
  };

  const buildCategoryKeyboard = (type: 'income' | 'expense') => {
    const cats = type === 'expense' ? EXPENSE_CATEGORIES : INCOME_CATEGORIES;
    const kb = new Keyboard();
    for (let i = 0; i < cats.length; i++) {
      kb.text(cats[i]);
      if ((i + 1) % 2 === 0) kb.row();
    }
    kb.row().text(FIN_BACK_TX);
    return kb.resized();
  };

  const buildRecurrenceKeyboard = () => new Keyboard()
    .text(FIN_REC_ONCE).text(FIN_REC_DAILY).row()
    .text(FIN_REC_WEEKLY).text(FIN_REC_MONTHLY).row()
    .text(FIN_REC_QUARTERLY).row()
    .text(FIN_BACK_TX)
    .resized();

  const buildFinanceSettingsMenu = () => new Keyboard()
    .text(FIN_BAL).row()
    .text(FIN_THRESHOLD_BTN).row()
    .text(FIN_BUDGETS_BTN).row()
    .text(FIN_BACK_FIN)
    .resized();

  const buildBudgetCategoryKeyboard = () => {
    const kb = new Keyboard();
    EXPENSE_CATEGORIES.forEach((cat, i) => {
      kb.text(cat);
      if ((i + 1) % 2 === 0) kb.row();
    });
    kb.row().text(FIN_BACK_FIN);
    return kb.resized();
  };

  const buildTxActionKeyboard = () => new Keyboard()
    .text(FIN_TX_DELETE).row()
    .text(FIN_BACK_RECENT)
    .resized();

  const buildRecurringActionKeyboard = () => new Keyboard()
    .text(FIN_TX_PAUSE).text(FIN_TX_DELETE).row()
    .text(FIN_BACK_RECURRING)
    .resized();

  const buildListSelectKeyboard = (count: number, backBtn: string) => {
    const kb = new Keyboard();
    for (let i = 1; i <= count; i++) {
      kb.text(String(i));
      if (i % 5 === 0) kb.row();
    }
    kb.row().text(backBtn);
    return kb.resized();
  };

  const buildProjectSelectKeyboard = (count: number) => {
    const kb = new Keyboard();
    for (let i = 1; i <= count; i++) {
      kb.text(String(i));
      if (i % 5 === 0) kb.row();
    }
    kb.row().text(TASK_INBOX);
    kb.row().text(TASK_BACK_TO_TASKS);
    return kb.resized();
  };

  const buildSectionSelectKeyboard = (count: number) => {
    const kb = new Keyboard();
    for (let i = 1; i <= count; i++) {
      kb.text(String(i));
      if (i % 5 === 0) kb.row();
    }
    kb.row().text(TASK_NO_SECTION);
    kb.row().text(TASK_BACK_TO_TASKS);
    return kb.resized();
  };

  const buildBitrixChoiceKeyboard = () => new Keyboard()
    .text(TASK_LINK_BITRIX_YES)
    .row()
    .text(TASK_LINK_BITRIX_NO)
    .row()
    .text(TASK_BACK_TO_TASKS)
    .resized();

  const buildCompletionChoiceKeyboard = () => new Keyboard()
    .text(STATUS_COMPLETE_WITH_DONE)
    .row()
    .text(STATUS_COMPLETE_ONLY)
    .row()
    .text(STATUS_COMPLETE_CANCEL)
    .resized();

  // Finance helper functions

  const showFinanceMenu = async (ctx: Context) => {
    pendingFinStep.delete(ctx.from?.id ?? 0);
    await ctx.reply('💰 *Финансы*\n\nВыбери действие:', {
      parse_mode: 'Markdown',
      reply_markup: buildFinanceMenu(),
    });
  };

  const showFinanceSummary = async (ctx: Context) => {
    await ctx.replyWithChatAction('typing');
    const now = new Date();
    try {
      const todayIso = getTodayIsoInTimezone();
      const [summary, monthData, monthTxWithRecurring, budgetsToday] = await Promise.all([
        finance.getSummary(now.getFullYear(), now.getMonth() + 1),
        finance.getMonthData(now.getFullYear(), now.getMonth() + 1),
        finance.getTransactionsWithRecurring(now.getFullYear(), now.getMonth() + 1),
        finance.getBudgets(now.getFullYear(), now.getMonth() + 1, todayIso),
      ]);

      const netToDate = (txs: Array<{ date: string; type: 'income' | 'expense'; amount: number }>) => txs
        .filter((tx) => tx.date <= todayIso)
        .reduce((sum, tx) => sum + (tx.type === 'income' ? tx.amount : -tx.amount), 0);

      const persistedToDate = netToDate(monthData.transactions ?? []);
      const withRecurringToDate = netToDate(monthTxWithRecurring ?? []);
      const recurringDelta = withRecurringToDate - persistedToDate;
      const balanceTodayWithRecurring = summary.balanceToday + recurringDelta;

      const todayOps = (monthTxWithRecurring ?? []).filter((tx) => tx.date === todayIso);
      const spentByCategoryToday = new Map<string, number>();
      for (const tx of monthTxWithRecurring ?? []) {
        if (tx.type !== 'expense' || tx.date > todayIso) continue;
        spentByCategoryToday.set(tx.category, (spentByCategoryToday.get(tx.category) ?? 0) + tx.amount);
      }
      const budgetsWithRecurringToday = budgetsToday.map((b) => ({
        ...b,
        spent: spentByCategoryToday.get(b.category) ?? 0,
      }));

      const text = formatFinanceBalanceView({
        balanceToday: balanceTodayWithRecurring,
        balanceEndOfDay: balanceTodayWithRecurring,
        todayOps,
        budgetsText: formatBudgetStatus(budgetsWithRecurringToday),
      });

      await ctx.reply(text, {
        parse_mode: 'Markdown',
        reply_markup: buildFinanceMenu(),
      });
    } catch (err) {
      logger.error({ err }, 'Error fetching finance summary');
      await ctx.reply('Не удалось загрузить баланс. Проверь подключение к финансовому API.', {
        reply_markup: buildFinanceMenu(),
      });
    }
  };

  const showFinanceBudgets = async (ctx: Context) => {
    await ctx.replyWithChatAction('typing');
    try {
      const budgets = await finance.getBudgets();
      const text = formatBudgetStatus(budgets);
      const userId = ctx.from?.id;
      if (userId) pendingFinStep.set(userId, 'budget_cat');
      await ctx.reply(text + '\n\nВыбери категорию для установки лимита:', { parse_mode: 'Markdown', reply_markup: buildBudgetCategoryKeyboard() });
    } catch (err) {
      logger.error({ err }, 'Error fetching budgets');
      await ctx.reply('Не удалось загрузить бюджеты.', { reply_markup: buildFinanceMenu() });
    }
  };

  const getTodayIso = () => new Intl.DateTimeFormat('en-CA', { timeZone: process.env.TIMEZONE || 'Europe/Minsk' }).format(new Date());

  const buildDayOpsView = async (dateIso: string): Promise<{ text: string; keyboard: import('grammy').InlineKeyboard }> => {
    const [year, month] = dateIso.split('-').map(Number) as [number, number];
    const allTxs = await finance.getTransactionsWithRecurring(year, month);
    const dayTxs = allTxs.filter((tx) => tx.date === dateIso);
    const prevDay = prevDateIso(dateIso);
    const startBalance = await finance.getBalanceBeforeDate(dateIso);
    const dayNet = dayTxs.reduce((s, tx) => s + (tx.type === 'income' ? tx.amount : -tx.amount), 0);
    const endBalance = startBalance + dayNet;
    const text = formatDayOpsText(dateIso, dayTxs, startBalance, endBalance);

    const todayIso = getTodayIso();
    const next = nextDateIso(dateIso);
    const { InlineKeyboard } = await import('grammy');
    const kb = new InlineKeyboard()
      .text(`◀ ${formatNavDate(prevDay)}`, `ops_day:${prevDay}`)
      .text(dateIso === todayIso ? '· сегодня ·' : formatNavDate(dateIso), `ops_day:${dateIso}`)
      .text(`${formatNavDate(next)} ▶`, `ops_day:${next}`);

    return { text, keyboard: kb };
  };

  const showDayOperations = async (ctx: Context, dateIso?: string) => {
    const date = dateIso ?? getTodayIso();
    await ctx.replyWithChatAction('typing');
    try {
      const { text, keyboard } = await buildDayOpsView(date);
      await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: keyboard });
    } catch (err) {
      logger.error({ err }, 'Error building day operations view');
      await ctx.reply('Не удалось загрузить операции.', { reply_markup: buildFinanceMenu() });
    }
  };

  const showRecentTransactions = async (ctx: Context) => {
    await ctx.replyWithChatAction('typing');
    const userId = ctx.from?.id;
    try {
      const txs = await finance.getRecentTransactions(30);
      if (txs.length === 0) {
        await ctx.reply('Транзакций пока нет.', { reply_markup: buildFinanceMenu() });
        return;
      }
      if (userId) {
        pendingFinTxList.set(userId, txs);
        pendingFinStep.set(userId, 'recent_list');
      }
      const lines: string[] = ['🕐 *Последние 30 операций:*\n'];
      const groups = new Map<string, Array<{ tx: typeof txs[number]; idx: number }>>();
      txs.forEach((tx, i) => {
        if (!groups.has(tx.category)) groups.set(tx.category, []);
        groups.get(tx.category)!.push({ tx, idx: i + 1 });
      });
      for (const [category, items] of groups.entries()) {
        lines.push(`*${category}*:`);
        items.forEach(({ tx, idx }) => {
          const sign = tx.type === 'expense' ? '−' : '+';
          const dateStr = new Date(tx.date).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
          const desc = tx.description ? ` | ${tx.description}` : '';
          lines.push(`${idx}. ${dateStr} | ${sign}${formatMoney(tx.amount)}₽${desc}`);
        });
        lines.push('');
      }
      lines.push('\nНажми номер операции для действий:');
      await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown', reply_markup: buildListSelectKeyboard(txs.length, FIN_BACK_FIN) });
    } catch (err) {
      logger.error({ err }, 'Error fetching recent transactions');
      await ctx.reply('Не удалось загрузить операции.', { reply_markup: buildFinanceMenu() });
    }
  };

  const showRecurringTransactions = async (ctx: Context) => {
    await ctx.replyWithChatAction('typing');
    const userId = ctx.from?.id;
    try {
      const now = new Date();
      const monthData = await finance.getMonthData(now.getFullYear(), now.getMonth() + 1);
      const recurring = (monthData.transactions ?? []).filter(tx => tx.recurrence && tx.recurrence !== 'once');

      if (recurring.length === 0) {
        await ctx.reply('Регулярных платежей нет.', { reply_markup: buildFinanceMenu() });
        return;
      }

      if (userId) {
        pendingFinRecurringList.set(userId, recurring);
        pendingFinStep.set(userId, 'recurring_list');
      }

      const lines = ['🔄 *Регулярные платежи:*\n'];
      const groups = new Map<string, Array<{ tx: typeof recurring[number]; idx: number }>>();
      recurring.forEach((tx, i) => {
        if (!groups.has(tx.category)) groups.set(tx.category, []);
        groups.get(tx.category)!.push({ tx, idx: i + 1 });
      });

      for (const [category, items] of groups.entries()) {
        lines.push(`*${category}*:`);
        items.forEach(({ tx, idx }) => {
          const sign = tx.type === 'expense' ? '−' : '+';
          const rec = formatRecurrenceLabel(tx.recurrence);
          const desc = tx.description ? ` (${tx.description})` : '';
          const endStr = tx.recurrence_end ? ` до ${new Date(tx.recurrence_end).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' })}` : '';
          lines.push(`${idx}. ${sign}${formatMoney(tx.amount)}₽ — ${tx.category}${desc} [${rec}${endStr}]`);
        });
        lines.push('');
      }
      lines.push('\nНажми номер для действий:');
      await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown', reply_markup: buildListSelectKeyboard(recurring.length, FIN_BACK_FIN) });
    } catch (err) {
      logger.error({ err }, 'Error fetching recurring transactions');
      await ctx.reply('Не удалось загрузить регулярные платежи.', { reply_markup: buildFinanceMenu() });
    }
  };

  const extractMarkedDate = (text: string, marker: 'на' | 'с' | 'до'): string | undefined => {
    const rx = new RegExp(`(?:^|\\s)${marker}\\s*(\\d{1,2}[.\\/-]\\d{1,2}(?:[.\\/-]\\d{2,4})?)`, 'i');
    const m = text.match(rx);
    if (!m?.[1]) return undefined;
    const raw = m[1].trim();
    const full = raw.match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})$/);
    if (full) return `${full[3]}-${String(Number(full[2])).padStart(2, '0')}-${String(Number(full[1])).padStart(2, '0')}`;
    const shortYear = raw.match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{2})$/);
    if (shortYear) {
      const y = Number(shortYear[3]);
      const yyyy = y >= 70 ? 1900 + y : 2000 + y;
      return `${yyyy}-${String(Number(shortYear[2])).padStart(2, '0')}-${String(Number(shortYear[1])).padStart(2, '0')}`;
    }
    const short = raw.match(/^(\d{1,2})[.\/-](\d{1,2})$/);
    if (short) {
      const yyyy = new Date().getFullYear();
      return `${yyyy}-${String(Number(short[2])).padStart(2, '0')}-${String(Number(short[1])).padStart(2, '0')}`;
    }
    return undefined;
  };

  const looksLikeFinanceAddIntent = (text: string): boolean => {
    const hasAmount = /(\d+(?:[\.,]\d+)?\s*(?:к|k|₽|р\b|руб))/i.test(text) || /(\d{2,})/.test(text);
    const hasVerb = /(потрат|трата|зп|зарплат|доход|кредит|оплат|списан|пришл|вернул|долг)/i.test(text);
    const isQuery = /(какие|покажи|сколько|сводка|форкаст|бюджет|аналитик)/i.test(text);
    return hasAmount && hasVerb && !isQuery;
  };

  const parseFinanceDraftsFromText = async (inputText: string): Promise<PendingFinanceTx[]> => {
    const today = getTodayIsoInTimezone();
    const parsedList = await llm.parseFinanceTransactions(inputText);
    if (parsedList.length === 0) return [];

    const startFromText = extractMarkedDate(inputText, 'с') ?? extractMarkedDate(inputText, 'на');
    const endFromText = extractMarkedDate(inputText, 'до');
    const monthlyHint = /ежемес|каждый\s+месяц|раз\s+в\s+месяц/i.test(inputText);

    return parsedList.map((p) => ({
      amount: p.amount,
      type: p.type,
      category: p.category,
      description: p.description,
      date: p.date ?? startFromText ?? today,
      recurrence: (p.recurrence ?? ((endFromText || monthlyHint) ? 'monthly' : 'once')),
      recurrence_end: p.recurrence_end ?? endFromText,
    }));
  };

  const showFinanceAnalytics = async (
    ctx: Context,
    period: 'month' | 'quarter' | 'year',
  ) => {
    await ctx.replyWithChatAction('typing');
    try {
      const { generateStrategicAnalysis } = await import('../scheduler/friday');
      const report = await generateStrategicAnalysis(todoist, llm, finance, period, 'finance');
      await ctx.reply(report, {
        parse_mode: 'Markdown',
        link_preview_options: { is_disabled: true },
        reply_markup: buildFinanceMenu(),
      });
    } catch (err) {
      logger.error({ err, period }, 'Error generating period analytics');
      await ctx.reply('Не удалось собрать аналитику за период.', { reply_markup: buildFinanceMenu() });
    }
  };

  const startFinanceOnboarding = async (ctx: Context) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    pendingFinOnboarding.add(userId);
    await ctx.reply(
      '👋 Давай настроим финансы.\n\nКакой у тебя сейчас баланс? Напиши сумму — я буду от неё отталкиваться.',
    );
  };

  const inferStatusFromText = (text: string): string | null => {
    const t = text.toLowerCase();
    if (/готов|сделан|выполн|закрыт|заверш/.test(t)) return 'completed';
    if (/чисто|done|completed/.test(t)) return 'completed';
    if (/ревью|review|фидбек|feedback/.test(t)) return 'review';
    if (/пауз|стоп|блок|blocked/.test(t)) return 'paused';
    if (/в работе|делаю|делаем|процесс|in progress/.test(t)) return 'in_progress';
    if (/ожида|жд[еуё]м|жду|комментар/.test(t)) return 'review';
    return null;
  };

  const resolveFallbackStatusForScope = async (taskIds: string[]): Promise<string> => {
    const knownStatuses = new Set(['in_progress', 'review', 'paused', 'completed']);

    for (const taskId of taskIds) {
      try {
        const task = await todoist.getTask(taskId);
        const current = task.labels.find((label) => knownStatuses.has(label));
        if (current) return current;
      } catch (err) {
        logger.warn({ err, taskId }, 'Failed to resolve fallback status from task labels');
      }
    }

    return 'in_progress';
  };

  const applyStatusUpdate = async (
    taskId: string,
    newStatus: string,
    commentText: string,
    moveToSectionId?: string,
  ): Promise<{ taskName: string; bitrixWarning: string | null }> => {
    const task = await todoist.getTask(taskId);

    if (moveToSectionId && !todoist.hasBitrixLabel(task)) {
      try {
        await todoist.moveTaskToSection(taskId, moveToSectionId);
      } catch (err) {
        logger.warn({ err, taskId, moveToSectionId }, 'Failed to move task before status update');
      }
    }

    // `completed` should close the task in Todoist, not only set a label.
    if (newStatus === 'completed') {
      await todoist.completeTask(taskId);
    } else {
      await todoist.updateTaskLabel(taskId, newStatus);
    }

    if (commentText.trim()) {
      try {
        await todoist.addTaskComment(taskId, formatStatusCommentForBitrix(commentText));
      } catch (err) {
        logger.warn({ err, taskId }, 'Failed to add Todoist task comment for status update');
      }
    }

    let bitrixWarning: string | null = null;

    if (todoist.hasBitrixLabel(task)) {
      const bitrixIds = parseBitrixIds(task.description ?? '');
      if (bitrixIds.length > 0) {
        try {
          const mappings = await getStatusMappings();
          const mapping = mappings.find(m => m.todoistLabel === newStatus);
          for (const bitrixId of bitrixIds) {
            if (mapping) {
              await bitrix.moveTaskToStage(bitrixId, mapping.bitrixStageId);
            }
            if (commentText.trim()) {
              await bitrix.addComment(bitrixId, formatStatusCommentForBitrix(commentText));
            }
          }
        } catch (err) {
          const details = err instanceof Error ? err.message : String(err);
          logger.warn({ err, taskId, bitrixIds }, 'Bitrix sync failed during status update');
          if (/insufficient_scope|401|Unauthorized/i.test(details)) {
            bitrixWarning = 'Комментарий/синхронизация в Bitrix не выполнены: у вебхука недостаточно прав (insufficient_scope).';
          } else {
            bitrixWarning = 'Не удалось синхронизировать обновление в Bitrix.';
          }
        }
      }
    }

    return { taskName: task.content, bitrixWarning };
  };

  const applyStatusUpdateForScope = async (
    userId: number,
    taskIds: string[],
    scopeName: string,
    newStatus: string,
    commentText: string,
    moveToSectionId?: string,
    movedSectionName?: string,
  ): Promise<string> => {
    const warnings = new Set<string>();
    const updatedTaskNames: string[] = [];

    for (const taskId of taskIds) {
      const result = await applyStatusUpdate(taskId, newStatus, commentText, moveToSectionId);
      updatedTaskNames.push(result.taskName);
      if (result.bitrixWarning) {
        warnings.add(result.bitrixWarning);
      }
    }

    pendingStatusContext.delete(userId);
    pendingStatusCompletionChoice.delete(userId);

    if (taskIds.length === 1) {
      return `Статус задачи *${escapeMarkdown(updatedTaskNames[0])}* обновлён на *${escapeMarkdown(newStatus)}*${movedSectionName ? `, колонка: *${escapeMarkdown(movedSectionName)}*` : ''}.${warnings.size > 0 ? `\n⚠️ ${escapeMarkdown(Array.from(warnings).join(' '))}` : ''}`;
    }

    return `Статус для комплекса *${escapeMarkdown(scopeName)}* обновлён на *${escapeMarkdown(newStatus)}* (задач: ${taskIds.length})${movedSectionName ? `, колонка: *${escapeMarkdown(movedSectionName)}*` : ''}.${warnings.size > 0 ? `\n⚠️ ${escapeMarkdown(Array.from(warnings).join(' '))}` : ''}`;
  };

  const resolveSectionByName = (
    sections: Array<{ id: string; name: string }>,
    targetName: string,
  ): { id: string; name: string } | null => {
    let best: { id: string; name: string } | null = null;
    let bestScore = 0;
    for (const section of sections) {
      const score = getSectionMatchScore(section.name, targetName);
      if (score > bestScore) {
        best = section;
        bestScore = score;
      }
    }
    return bestScore > 0 ? best : null;
  };

  const buildRootStatusTasks = async () => {
    const tasks = await todoist.getAllActiveTasks();
    const rootTasks = tasks.filter(t => !todoist.getTaskParentId(t));
    return rootTasks.map((t) => ({ id: t.id, content: t.content }));
  };

  const buildStatusTaskList = async () => {
    const rootTasks = await buildRootStatusTasks();
    return rootTasks.slice(0, 20);
  };

  const getStatusColumnOptions = async (taskId: string) => {
    const task = await todoist.getTask(taskId);
    const projectId = todoist.getTaskProjectId(task);
    const currentSectionId = todoist.getTaskSectionId(task);
    const sections = projectId && projectId !== 'unknown'
      ? await todoist.listSections(projectId)
      : [];
    return {
      task,
      sections: sections.slice(0, 25).map((s) => ({ id: s.id, name: s.name })),
      currentSectionId,
    };
  };

  const askBitrixLink = async (ctx: Context, draft: TaskDraftIntent & {
    projectName?: string;
    sectionName?: string;
  }) => {
    if (ctx.from?.id) pendingTaskStep.set(ctx.from.id, 'task_bitrix_pick');
    const projectText = draft.projectName ? `\nПроект: *${escapeMarkdown(draft.projectName)}*` : '\nПроект: *Входящие*';
    const sectionText = draft.sectionName ? `\nКолонка: *${escapeMarkdown(draft.sectionName)}*` : '';

    await ctx.reply(
      `Задача: *${escapeMarkdown(draft.content)}*${projectText}${sectionText}\n\nСвязать с Bitrix?`,
      { parse_mode: 'Markdown', reply_markup: buildBitrixChoiceKeyboard() },
    );
  };

  const sendToday = async (ctx: Context) => {
    await ctx.replyWithChatAction('typing');
    try {
      const [tasks, events] = await Promise.all([
        todoist.getAllActiveTasks(),
        calendar.getTodayEvents().catch((err) => {
          logger.warn({ err }, 'Failed to fetch calendar events for today view');
          return [];
        }),
      ]);
      const projectNames = await todoist.getProjectNamesMapForTasks(tasks);

      const parts: string[] = [];
      const today = new Date().toLocaleDateString('ru-RU', {
        weekday: 'long', day: 'numeric', month: 'long',
        timeZone: process.env.TIMEZONE || 'Europe/Minsk',
      });
      parts.push(`*План на ${today}*\n`);

      if (events.length > 0) {
        parts.push(formatEventList(events));
      } else {
        parts.push('_Событий нет_');
      }

      if (tasks.length > 0) {
        parts.push(formatTaskList(tasks, 'Активные задачи', projectNames));
      } else {
        parts.push('_Активных задач нет_');
      }

      await ctx.reply(parts.join('\n\n'), {
        parse_mode: 'Markdown',
        reply_markup: buildTasksMenu(),
      });
    } catch (err) {
      logger.error({ err }, 'Failed to build today view');
      await ctx.reply('Не удалось сформировать план на сегодня. Попробуй чуть позже.', {
        reply_markup: buildTasksMenu(),
      });
    }
  };

  const sendTasks = async (ctx: Context) => {
    await ctx.replyWithChatAction('typing');
    const tasks = await todoist.getAllActiveTasks();
    const projectNames = await todoist.getProjectNamesMapForTasks(tasks);
    if (tasks.length === 0) {
      await ctx.reply('Нет активных задач.', { reply_markup: buildTasksMenu() });
      return;
    }
    await ctx.reply(formatTaskList(tasks, 'Активные задачи', projectNames), {
      parse_mode: 'Markdown',
      reply_markup: buildTasksMenu(),
    });
  };

  const sendOverdue = async (ctx: Context) => {
    await ctx.replyWithChatAction('typing');
    const tasks = await todoist.getOverdueTasks();
    const projectNames = await todoist.getProjectNamesMapForTasks(tasks);
    if (tasks.length === 0) {
      await ctx.reply('Просроченных задач нет. Отлично!', { reply_markup: buildTasksMenu() });
      return;
    }
    await ctx.reply(formatTaskList(tasks, 'Просроченные задачи', projectNames), {
      parse_mode: 'Markdown',
      reply_markup: buildTasksMenu(),
    });
  };

  const sendReport = async (ctx: Context) => {
    await ctx.replyWithChatAction('typing');
    const { generateReport, splitMessage } = await import('../scheduler/friday');
    const report = await generateReport(todoist, calendar, llm, finance);
    const chunks = splitMessage(report);
    for (let i = 0; i < chunks.length; i++) {
      await ctx.reply(chunks[i], {
        parse_mode: 'Markdown',
        link_preview_options: { is_disabled: true },
        reply_markup: i === chunks.length - 1 ? buildTasksMenu() : undefined,
      });
    }
  };

  const sendSettings = async (ctx: Context) => {
    const mappings = await getStatusMappings();
    const briefingTime = (await getConfig('briefing_time')) ?? '08:35';
    const thresholdHours = (await getConfig('status_threshold_hours')) ?? '48';

    let text = '*Текущие настройки*\n\n';
    text += `Брифинг: ${briefingTime} ежедневно\n`;
    text += `Часовой пояс: ${process.env.TIMEZONE || 'Europe/Minsk'}\n`;
    text += `Порог статуса: ${thresholdHours}ч\n\n`;

    if (mappings.length > 0) {
      text += '*Маппинг статусов Todoist ↔ Bitrix24:*\n';
      for (const m of mappings) {
        text += `• ${m.todoistLabel} → ${m.bitrixStageName ?? m.bitrixStageId}\n`;
      }
    } else {
      text += '_Маппинг статусов не настроен_\n';
      text += 'Используй /map чтобы настроить.';
    }

    await ctx.reply(text, {
      parse_mode: 'Markdown',
      reply_markup: buildTasksMenu(),
    });
  };

  const sendHelp = async (ctx: Context) => {
    const text = `*Доступные команды:*

/today — план на сегодня
/tasks — все активные задачи
/overdue — просроченные задачи
/report — отчёт по задачам
/settings — текущие настройки
/map — настроить маппинг статусов
/menu — показать меню
/help — эта справка

*Что я понимаю из текста:*
• "Встреча с Артёмом завтра в 15:00" → создам событие
• "Каждый вт в 10 standup" → recurring событие
• "Задача: презентация, дедлайн среда" → задача в Todoist
• "Задача X готова" → отмечу выполненной
• "По X жду фидбек" → обновлю статус
• "Перенеси дедлайн X на пятницу" → обновлю срок
• "Привяжи X к битриксу 12345" → привяжу к Bitrix24
• "потратил 500 на продукты" → добавлю трату в финансы
• "зп пришла 60к" → добавлю доход`;

    await ctx.reply(text, {
      parse_mode: 'Markdown',
      reply_markup: buildTasksMenu(),
    });
  };

  // Auth middleware
  bot.use(async (ctx, next) => {
    if (!isAuthorized(ctx)) {
      logger.warn({ userId: ctx.from?.id }, 'Unauthorized access attempt');
      return;
    }
    await next();
  });

  // /start command
  bot.command('start', async (ctx) => {
    await ctx.reply(
      `Привет! Я твой персональный ассистент.\n\n` +
      `📋 *Задачи* — Todoist, Calendar, Bitrix24\n` +
      `💰 *Финансы* — трекинг трат, бюджеты, прогнозы\n\n` +
      `Или просто пиши мне в свободной форме:\n` +
      `• "Встреча с Артёмом завтра в 15:00"\n` +
      `• "потратил 1200 в пятёрочке"\n` +
      `• "зп пришла 60к"`,
      {
        parse_mode: 'Markdown',
        reply_markup: buildMainMenu(),
      }
    );
  });

  bot.command('menu', async (ctx) => {
    await ctx.reply('Выбери раздел:', { reply_markup: buildMainMenu() });
  });

  // /today command
  bot.command('today', async (ctx) => {
    try {
      await sendToday(ctx);
    } catch (err) {
      logger.error({ err }, 'Error in /today command');
      await ctx.reply('Произошла ошибка при получении данных. Попробуй позже.');
    }
  });

  // /tasks command
  bot.command('tasks', async (ctx) => {
    try {
      await sendTasks(ctx);
    } catch (err) {
      logger.error({ err }, 'Error in /tasks command');
      await ctx.reply('Ошибка при получении задач.');
    }
  });

  // /overdue command
  bot.command('overdue', async (ctx) => {
    try {
      await sendOverdue(ctx);
    } catch (err) {
      logger.error({ err }, 'Error in /overdue command');
      await ctx.reply('Ошибка при получении просроченных задач.');
    }
  });

  // /report command
  bot.command('report', async (ctx) => {
    try {
      await sendReport(ctx);
    } catch (err) {
      logger.error({ err }, 'Error in /report command');
      await ctx.reply('Ошибка при генерации отчёта.');
    }
  });

  // /settings command
  bot.command('settings', async (ctx) => {
    await sendSettings(ctx);
  });

  // /map command - configure status mapping
  bot.command('map', async (ctx) => {
    const args = ctx.message?.text?.split(' ').slice(1);
    if (!args || args.length < 2) {
      await ctx.reply(
        'Использование: `/map <todoist_label> <bitrix_stage_id> [bitrix_stage_name]`\n\n' +
        'Например: `/map in_progress 5 "В работе"`\n\n' +
        'Для сброса маппинга: `/map reset`',
        { parse_mode: 'Markdown' }
      );
      return;
    }

    if (args[0] === 'reset') {
      await clearStatusMappings();
      await ctx.reply('Маппинг статусов сброшен.');
      return;
    }

    await addStatusMapping({
      todoistLabel: args[0],
      bitrixStageId: args[1],
      bitrixStageName: args[2],
    });

    await ctx.reply(`Маппинг добавлен: ${args[0]} → ${args[2] ?? args[1]}`);
  });

  // /help command
  bot.command('help', async (ctx) => {
    await sendHelp(ctx);
  });

  // Main message handler
  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text;
    if (text.startsWith('/')) return; // Skip commands
    const normalized = text.trim();

    // ── Fitness text input ────────────────────────────────────────────────
    // Measurement: "вес 82.5" or "вес 82 живот 89"
    const measureParsed = FitnessService.parseMeasurement(normalized);
    if (measureParsed) {
      try {
        await fitness.upsertMeasurement(measureParsed);
        const parts: string[] = ['✅ Замеры записаны'];
        if (measureParsed.weight_kg !== undefined) parts.push(`⚖️ Вес: *${measureParsed.weight_kg} кг*`);
        if (measureParsed.waist_cm !== undefined) parts.push(`📏 Живот: *${measureParsed.waist_cm} см*`);
        await ctx.reply(parts.join('\n'), { parse_mode: 'Markdown' });
        return;
      } catch (err) {
        logger.warn({ err }, 'Failed to save measurement');
      }
    }

    // Nutrition: "2200 ккал б180 ж70 у200" or "2200/180/70/200"
    const nutritionParsed = FitnessService.parseNutrition(normalized);
    if (nutritionParsed) {
      try {
        await fitness.upsertNutrition(nutritionParsed);
        const parts: string[] = ['✅ Питание записано'];
        if (nutritionParsed.calories !== undefined) parts.push(`🔥 ${nutritionParsed.calories} ккал`);
        const macros = [
          nutritionParsed.protein_g !== undefined ? `Б ${nutritionParsed.protein_g}г` : null,
          nutritionParsed.fat_g !== undefined ? `Ж ${nutritionParsed.fat_g}г` : null,
          nutritionParsed.carbs_g !== undefined ? `У ${nutritionParsed.carbs_g}г` : null,
        ].filter(Boolean).join('  ');
        if (macros) parts.push(macros);
        await ctx.reply(parts.join('\n'), { parse_mode: 'Markdown' });
        return;
      } catch (err) {
        logger.warn({ err }, 'Failed to save nutrition');
      }
    }

    // Workout: "жим лёжа 70кг 3×8" (only when in workout step)
    if (pendingFitStep.get(ctx.from.id) === 'workout_input') {
      const exercises = FitnessService.parseWorkout(normalized);
      if (exercises.length > 0) {
        try {
          let sessionId = pendingFitWorkoutSession.get(ctx.from.id);
          if (!sessionId) {
            const session = await fitness.createSession({});
            sessionId = session.id;
            pendingFitWorkoutSession.set(ctx.from.id, sessionId);
          }
          await fitness.addSets(sessionId, exercises);
          const preview = formatParsedExercises(exercises);
          await ctx.reply(
            `✅ Записано:\n\n${preview}\n\n_Добавь ещё упражнения или вернись в меню_`,
            { parse_mode: 'Markdown', reply_markup: buildFitnessMenu() },
          );
          return;
        } catch (err) {
          logger.error({ err }, 'Failed to save workout');
          await ctx.reply('Ошибка при записи тренировки. Попробуй ещё раз.');
          return;
        }
      }
    }

    // ── Recurring adjust: waiting for new amount ─────────────────────────
    if (pendingRecurringAdjust.has(ctx.from.id)) {
      const adjust = pendingRecurringAdjust.get(ctx.from.id)!;
      const amount = parseAmountFromText(normalized);
      if (amount === null || amount <= 0) {
        await ctx.reply('Введи сумму числом, например: *3500* или *3.5к*', { parse_mode: 'Markdown' });
        return;
      }
      pendingRecurringAdjust.delete(ctx.from.id);
      try {
        await finance.confirmOccurrence(adjust.txId, adjust.date, amount, adjust.tx);
        const label = adjust.tx.description ?? adjust.tx.category;
        const sign = adjust.tx.type === 'expense' ? '−' : '+';
        await ctx.reply(
          `✅ Проведено: ${sign}${formatMoney(amount)} ₽ — ${label}`,
          { parse_mode: 'Markdown' },
        );
      } catch (err) {
        logger.error({ err }, 'Failed to confirm adjusted recurring');
        await ctx.reply('Ошибка при записи. Попробуй ещё раз.');
      }
      return;
    }

    if (normalized === MENU_TASKS_SECTION) {
      userSection.set(ctx.from.id, 'tasks');
      await ctx.reply('📋 *Задачи*\n\nВыбери действие:', {
        parse_mode: 'Markdown',
        reply_markup: buildTasksMenu(),
      });
      return;
    }

    if (normalized === MENU_BACK_MAIN) {
      userSection.delete(ctx.from.id);
      await ctx.reply('Главное меню:', { reply_markup: buildMainMenu() });
      return;
    }

    if (normalized === MENU_CREATE) {
      pendingStatusContext.delete(ctx.from.id);
      pendingCreateContext.add(ctx.from.id);
      pendingTaskStep.delete(ctx.from.id);
      pendingTaskProjectList.delete(ctx.from.id);
      pendingTaskSectionList.delete(ctx.from.id);
      await ctx.reply(
        'Напиши текст новой задачи (например: "Подготовить отчет к пятнице"). Потом я предложу выбрать проект и колонку.',
        { reply_markup: buildTasksMenu() },
      );
      return;
    }

    if (normalized === MENU_STATUS) {
      pendingCreateContext.delete(ctx.from.id);
      pendingTaskDrafts.delete(ctx.from.id);
      pendingTaskProjectList.delete(ctx.from.id);
      pendingTaskSectionList.delete(ctx.from.id);
      pendingTaskStep.delete(ctx.from.id);
      try {
        const [rootTaskList, thresholdHours] = await Promise.all([
          buildRootStatusTasks(),
          getStatusThresholdHours(),
        ]);
        const taskList = rootTaskList.slice(0, 20);
        if (taskList.length === 0) {
          await ctx.reply('Нет активных задач для обновления статуса.', { reply_markup: buildTasksMenu() });
          return;
        }

        const staleTaskIds = await todoist.getStaleTaskIds(thresholdHours);
        const staleTasks = rootTaskList.filter((t) => staleTaskIds.includes(t.id));

        pendingTaskStep.set(ctx.from.id, 'status_task_pick');
        pendingStatusTaskList.set(ctx.from.id, taskList);

        const shortLabel = (value: string) => (value.length > 72 ? `${value.slice(0, 69)}...` : value);
        const taskButtonById = new Map(taskList.map((task, idx) => [task.id, idx + 1]));
        const staleInVisibleList = staleTasks.filter((task) => taskButtonById.has(task.id));
        const staleOutsideVisible = staleTasks.length - staleInVisibleList.length;

        const lines = [
          '*📝 Дать статус*',
          '',
          `Выбери задачу кнопкой ниже \(1\-${taskList.length}\)\.`,
        ];

        if (staleTasks.length > 0) {
          lines.push('', `*⚠️ Ждут апдейта больше ${thresholdHours}ч:* ${staleTasks.length}`);
          staleInVisibleList.slice(0, 7).forEach((task) => {
            const buttonNum = taskButtonById.get(task.id);
            if (!buttonNum) return;
            lines.push(`${buttonNum}\. ${escapeMarkdown(shortLabel(task.content))}`);
          });
          if (staleOutsideVisible > 0) {
            lines.push(`_Ещё ${staleOutsideVisible} задач вне первых ${taskList.length} в этом списке\._`);
          }
        }

        lines.push('', '*Все задачи:*');
        taskList.forEach((task, i) => {
          lines.push(`${i + 1}\. ${escapeMarkdown(shortLabel(task.content))}`);
        });
        await ctx.reply(lines.join('\n'), {
          parse_mode: 'Markdown',
          reply_markup: buildListSelectKeyboard(taskList.length, TASK_BACK_TO_TASKS),
        });
      } catch (err) {
        logger.error({ err }, 'Error opening status update flow from menu keyboard');
        await ctx.reply('Не удалось открыть список задач. Попробуй еще раз.', { reply_markup: buildTasksMenu() });
      }
      return;
    }

    if (normalized === MENU_TODAY) {
      await sendToday(ctx);
      return;
    }

    if (normalized === MENU_TASKS) {
      await sendTasks(ctx);
      return;
    }

    if (normalized === MENU_OVERDUE) {
      await sendOverdue(ctx);
      return;
    }

    if (normalized === MENU_REPORT) {
      await sendReport(ctx);
      return;
    }

    if (normalized === MENU_SETTINGS) {
      await sendSettings(ctx);
      return;
    }

    if (normalized === MENU_HELP) {
      await sendHelp(ctx);
      return;
    }

    if (normalized === MENU_FINANCE) {
      userSection.set(ctx.from.id, 'finance');
      try {
        const onboardingDone = await finance.isOnboardingDone();
        if (!onboardingDone) {
          await startFinanceOnboarding(ctx);
        } else {
          await showFinanceMenu(ctx);
        }
      } catch {
        await showFinanceMenu(ctx);
      }
      return;
    }

    // ── Fitness section ──────────────────────────────────────────────────
    if (normalized === MENU_FITNESS) {
      userSection.set(ctx.from.id, 'fitness');
      await ctx.reply('💪 *Фитнес*\n\nВыбери раздел:', {
        parse_mode: 'Markdown',
        reply_markup: buildFitnessMenu(),
      });
      return;
    }

    if (normalized === FIT_BACK) {
      userSection.delete(ctx.from.id);
      pendingFitStep.delete(ctx.from.id);
      pendingFitWorkoutSession.delete(ctx.from.id);
      await ctx.reply('Главное меню:', { reply_markup: buildMainMenu() });
      return;
    }

    if (normalized === FIT_MEASURES) {
      pendingFitStep.delete(ctx.from.id);
      try {
        const measurements = await fitness.getMeasurements(14);
        await ctx.reply(formatMeasurementHistory(measurements), {
          parse_mode: 'Markdown',
          reply_markup: buildFitnessMenu(),
        });
      } catch (err) {
        logger.error({ err }, 'Error fetching measurements');
        await ctx.reply('Не удалось загрузить замеры.', { reply_markup: buildFitnessMenu() });
      }
      return;
    }

    if (normalized === FIT_NUTRITION) {
      pendingFitStep.delete(ctx.from.id);
      try {
        const entries = await fitness.getRecentNutrition(7);
        await ctx.reply(formatNutritionHistory(entries), {
          parse_mode: 'Markdown',
          reply_markup: buildFitnessMenu(),
        });
      } catch (err) {
        logger.error({ err }, 'Error fetching nutrition');
        await ctx.reply('Не удалось загрузить данные питания.', { reply_markup: buildFitnessMenu() });
      }
      return;
    }

    if (normalized === FIT_WORKOUT) {
      pendingFitStep.set(ctx.from.id, 'workout_input');
      pendingFitWorkoutSession.delete(ctx.from.id);
      try {
        const sessions = await fitness.getRecentSessions(5);
        const sessionsWithSets = await Promise.all(
          sessions.map(async (s) => ({ session: s, sets: await fitness.getSessionSets(s.id) })),
        );
        const history = formatWorkoutHistory(sessionsWithSets);
        await ctx.reply(
          `${history}\n\n——————————————\n_Введи тренировку:_\n\`жим лёжа 70кг 3×8, тяга 100кг 3×6\``,
          { parse_mode: 'Markdown', reply_markup: buildFitnessMenu() },
        );
      } catch (err) {
        logger.error({ err }, 'Error fetching workout sessions');
        await ctx.reply(
          '🏋️ *Тренировка*\n\n_Введи упражнения:_\n`жим лёжа 70кг 3×8`',
          { parse_mode: 'Markdown', reply_markup: buildFitnessMenu() },
        );
      }
      return;
    }

    if (normalized === FIT_PROGRESS) {
      pendingFitStep.delete(ctx.from.id);
      try {
        const [measurements, sessions] = await Promise.all([
          fitness.getMeasurements(30),
          fitness.getRecentSessions(10),
        ]);

        const lines: string[] = ['📊 *Прогресс*\n'];

        // Body composition trend
        if (measurements.length >= 2) {
          const latest = measurements[0]!;
          const oldest = measurements[measurements.length - 1]!;
          lines.push('⚖️ *Тело:*');
          if (latest.weight_kg !== null && oldest.weight_kg !== null) {
            const diff = latest.weight_kg - oldest.weight_kg;
            const sign = diff > 0 ? '+' : '';
            lines.push(`Вес: ${latest.weight_kg} кг (${sign}${diff.toFixed(1)} кг за период)`);
          }
          if (latest.waist_cm !== null && oldest.waist_cm !== null) {
            const diff = latest.waist_cm - oldest.waist_cm;
            const sign = diff > 0 ? '+' : '';
            lines.push(`Живот: ${latest.waist_cm} см (${sign}${diff.toFixed(1)} см за период)`);
          }
          lines.push('');
        }

        // Workout frequency
        if (sessions.length > 0) {
          lines.push(`🏋️ *Тренировки:* ${sessions.length} за последний период`);

          // Find most trained exercises
          const allSets = await Promise.all(sessions.slice(0, 5).map((s) => fitness.getSessionSets(s.id)));
          const exCount = new Map<string, number>();
          allSets.flat().forEach((s) => exCount.set(s.exercise, (exCount.get(s.exercise) ?? 0) + 1));
          const topEx = [...exCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);

          if (topEx.length > 0) {
            lines.push('Топ упражнений: ' + topEx.map(([ex]) => ex).join(', '));
          }

          // Progression check for top exercise
          if (topEx[0]) {
            const exName = topEx[0][0];
            const exHistory = await fitness.getExerciseHistory(exName, 4);
            const suggestion = fitness.getProgressionSuggestion(exHistory);
            if (suggestion) {
              lines.push('');
              lines.push(`💡 *${exName}:* ${suggestion}`);
            }
          }
        }

        await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown', reply_markup: buildFitnessMenu() });
      } catch (err) {
        logger.error({ err }, 'Error building progress view');
        await ctx.reply('Не удалось загрузить прогресс.', { reply_markup: buildFitnessMenu() });
      }
      return;
    }

    const taskStep = pendingTaskStep.get(ctx.from.id);
    const completionChoice = pendingStatusCompletionChoice.get(ctx.from.id);
    if (completionChoice) {
      if (normalized === STATUS_COMPLETE_CANCEL) {
        pendingStatusCompletionChoice.delete(ctx.from.id);
        await ctx.reply('Выбери действие:', { reply_markup: buildTasksMenu() });
        return;
      }

      if (normalized !== STATUS_COMPLETE_WITH_DONE && normalized !== STATUS_COMPLETE_ONLY) {
        await ctx.reply('Выбери вариант кнопками ниже.', {
          reply_markup: buildCompletionChoiceKeyboard(),
        });
        return;
      }

      try {
        let sectionId: string | undefined;
        let sectionName: string | undefined;

        if (normalized === STATUS_COMPLETE_WITH_DONE && completionChoice.taskIds.length > 0) {
          const options = await getStatusColumnOptions(completionChoice.taskIds[0]);
          const matched = resolveSectionByName(options.sections, completionChoice.preferredDoneColumn);
          if (matched) {
            sectionId = matched.id;
            sectionName = matched.name;
          }
        }

        const scopedReply = await applyStatusUpdateForScope(
          ctx.from.id,
          completionChoice.taskIds,
          completionChoice.taskName,
          'completed',
          completionChoice.commentText,
          sectionId,
          sectionName,
        );
        await ctx.reply(scopedReply, { parse_mode: 'Markdown', reply_markup: buildTasksMenu() });
      } catch (err) {
        logger.error({ err }, 'Error applying completion choice');
        await ctx.reply('Не удалось завершить задачу. Попробуй ещё раз.', { reply_markup: buildTasksMenu() });
      }
      return;
    }
    if (taskStep === 'status_task_pick') {
      if (normalized === TASK_BACK_TO_TASKS) {
        pendingTaskStep.delete(ctx.from.id);
        pendingStatusTaskList.delete(ctx.from.id);
        await ctx.reply('Выбери действие:', { reply_markup: buildTasksMenu() });
        return;
      }

      const taskList = pendingStatusTaskList.get(ctx.from.id);
      const num = parseInt(normalized, 10);
      if (!taskList || Number.isNaN(num) || num < 1 || num > taskList.length) {
        await ctx.reply('Нажми номер задачи из списка.', {
          reply_markup: buildListSelectKeyboard(taskList?.length ?? 1, TASK_BACK_TO_TASKS),
        });
        return;
      }

      const selected = taskList[num - 1];
      pendingStatusTaskList.delete(ctx.from.id);
      pendingStatusContext.set(ctx.from.id, { taskIds: [selected.id], taskName: selected.content });

      try {
        const statusInputHint = 'Можешь сразу написать статус/комментарий одним сообщением.';
        const { task, sections, currentSectionId } = await getStatusColumnOptions(selected.id);
        if (todoist.hasBitrixLabel(task)) {
          pendingTaskStep.delete(ctx.from.id);
          pendingStatusTaskList.delete(ctx.from.id);
          await ctx.reply(
            `Выбрана задача *${escapeMarkdown(task.content)}*.\n${statusInputHint}\nПеренос по колонкам Todoist для Bitrix-задач отключен.`,
            { parse_mode: 'Markdown', reply_markup: buildTasksMenu() },
          );
          return;
        }

        if (sections.length === 0) {
          pendingTaskStep.delete(ctx.from.id);
          pendingStatusTaskList.delete(ctx.from.id);
          await ctx.reply(
            `Выбрана задача *${escapeMarkdown(task.content)}*.\n${statusInputHint}\nВ проекте нет доступных колонок для переноса.`,
            { parse_mode: 'Markdown', reply_markup: buildTasksMenu() },
          );
          return;
        }

        pendingTaskStep.set(ctx.from.id, 'status_column_pick');
        pendingStatusSectionList.set(ctx.from.id, {
          taskId: task.id,
          taskName: task.content,
          sections,
          currentSectionId: currentSectionId ?? undefined,
        });
        const lines = [
          `Выбрана задача *${escapeMarkdown(task.content)}*.`,
          `Текущая колонка: *${escapeMarkdown(sections.find((s) => s.id === currentSectionId)?.name ?? 'без колонки')}*`,
          statusInputHint,
          'Или выбери новую колонку номером:',
        ];
        sections.forEach((section, i) => {
          lines.push(`${i + 1}. ${section.id === currentSectionId ? '✅ ' : ''}${section.name}`);
        });
        await ctx.reply(lines.join('\n'), {
          parse_mode: 'Markdown',
          reply_markup: buildListSelectKeyboard(sections.length, TASK_BACK_TO_TASKS),
        });
      } catch (err) {
        logger.error({ err }, 'Error handling status task selection');
        pendingTaskStep.delete(ctx.from.id);
        pendingStatusTaskList.delete(ctx.from.id);
        await ctx.reply('Не удалось выбрать задачу. Попробуй ещё раз.', { reply_markup: buildTasksMenu() });
      }
      return;
    }

    if (taskStep === 'status_column_pick') {
      if (normalized === TASK_BACK_TO_TASKS) {
        pendingTaskStep.delete(ctx.from.id);
        pendingStatusSectionList.delete(ctx.from.id);
        await ctx.reply('Выбери действие:', { reply_markup: buildTasksMenu() });
        return;
      }

      const columnCtx = pendingStatusSectionList.get(ctx.from.id);
      const num = parseInt(normalized, 10);
      if (!columnCtx) {
        pendingTaskStep.delete(ctx.from.id);
        await ctx.reply('Контекст выбора колонки устарел. Выбери задачу снова.', { reply_markup: buildTasksMenu() });
        return;
      }

      if (Number.isNaN(num)) {
        const requestedColumn = extractColumnTarget(text);
        if (requestedColumn) {
          const matched = resolveSectionByName(columnCtx.sections, requestedColumn);
          if (!matched) {
            await ctx.reply(
              `Не нашёл колонку «${escapeMarkdown(requestedColumn)}». Доступно: ${columnCtx.sections.map((s) => `*${escapeMarkdown(s.name)}*`).join(', ')}`,
              {
                parse_mode: 'Markdown',
                reply_markup: buildListSelectKeyboard(columnCtx.sections.length, TASK_BACK_TO_TASKS),
              },
            );
            return;
          }

          try {
            const moved = await todoist.moveTaskToSection(columnCtx.taskId, matched.id);
            pendingTaskStep.delete(ctx.from.id);
            pendingStatusSectionList.delete(ctx.from.id);
            await ctx.reply(
              `Задача *${escapeMarkdown(moved.content)}* перенесена в колонку *${escapeMarkdown(matched.name)}*.`,
              { parse_mode: 'Markdown', reply_markup: buildTasksMenu() },
            );
          } catch (err) {
            logger.error({ err, taskId: columnCtx.taskId, sectionName: requestedColumn }, 'Error moving task by column name from message flow');
            await ctx.reply('Ошибка переноса по колонкам. Попробуй ещё раз.', {
              reply_markup: buildListSelectKeyboard(columnCtx.sections.length, TASK_BACK_TO_TASKS),
            });
          }
          return;
        }

        // User entered free text status/comment instead of a column move.
        pendingTaskStep.delete(ctx.from.id);
        pendingStatusSectionList.delete(ctx.from.id);
      } else if (num < 1 || num > columnCtx.sections.length) {
        await ctx.reply('Нажми номер колонки из списка.', {
          reply_markup: buildListSelectKeyboard(columnCtx.sections.length, TASK_BACK_TO_TASKS),
        });
        return;
      } else {
        const section = columnCtx.sections[num - 1];
        try {
          const moved = await todoist.moveTaskToSection(columnCtx.taskId, section.id);
          pendingTaskStep.delete(ctx.from.id);
          pendingStatusSectionList.delete(ctx.from.id);
          await ctx.reply(
            `Задача *${escapeMarkdown(moved.content)}* перенесена в колонку *${escapeMarkdown(section.name)}*.`,
            { parse_mode: 'Markdown', reply_markup: buildTasksMenu() },
          );
        } catch (err) {
          logger.error({ err, taskId: columnCtx.taskId, sectionId: section.id }, 'Error moving task from message flow');
          await ctx.reply('Ошибка переноса по колонкам. Попробуй ещё раз.', {
            reply_markup: buildListSelectKeyboard(columnCtx.sections.length, TASK_BACK_TO_TASKS),
          });
        }
        return;
      }
    }

    if (taskStep === 'task_project_pick') {
      if (normalized === TASK_BACK_TO_TASKS) {
        pendingTaskStep.delete(ctx.from.id);
        pendingTaskProjectList.delete(ctx.from.id);
        pendingTaskDrafts.delete(ctx.from.id);
        await ctx.reply('Создание задачи отменено.', { reply_markup: buildTasksMenu() });
        return;
      }

      const draft = pendingTaskDrafts.get(ctx.from.id);
      const projects = pendingTaskProjectList.get(ctx.from.id);
      if (!draft || !projects) {
        pendingTaskStep.delete(ctx.from.id);
        await ctx.reply('Черновик задачи устарел. Повтори запрос.', { reply_markup: buildTasksMenu() });
        return;
      }

      if (normalized === TASK_INBOX) {
        draft.projectId = undefined;
        draft.projectName = 'Входящие';
        draft.sectionId = undefined;
        draft.sectionName = undefined;
        pendingTaskDrafts.set(ctx.from.id, draft);
        await askBitrixLink(ctx, draft);
        return;
      }

      const projectNum = parseInt(normalized, 10);
      if (Number.isNaN(projectNum) || projectNum < 1 || projectNum > projects.length) {
        await ctx.reply('Нажми номер проекта из списка.', {
          reply_markup: buildProjectSelectKeyboard(projects.length),
        });
        return;
      }

      const project = projects[projectNum - 1];
      draft.projectId = project.id;
      draft.projectName = project.name;
      pendingTaskDrafts.set(ctx.from.id, draft);

      try {
        const sections = await todoist.listSections(project.id);
        const compactSections = sections.map((s) => ({ id: s.id, name: s.name }));
        if (compactSections.length === 0) {
          draft.sectionId = undefined;
          draft.sectionName = undefined;
          pendingTaskDrafts.set(ctx.from.id, draft);
          await askBitrixLink(ctx, draft);
          return;
        }

        pendingTaskStep.set(ctx.from.id, 'task_section_pick');
        pendingTaskSectionList.set(ctx.from.id, compactSections);
        const lines = [`Проект: *${escapeMarkdown(project.name)}*`, `Выбери колонку для задачи *${escapeMarkdown(draft.content)}*:`];
        compactSections.forEach((s, i) => lines.push(`${i + 1}. ${s.name}`));
        await ctx.reply(lines.join('\n'), {
          parse_mode: 'Markdown',
          reply_markup: buildSectionSelectKeyboard(compactSections.length),
        });
      } catch (err) {
        logger.error({ err, projectId: project.id }, 'Error loading project sections');
        await ctx.reply('Не удалось загрузить колонки проекта.', { reply_markup: buildTasksMenu() });
      }
      return;
    }

    if (taskStep === 'task_section_pick') {
      if (normalized === TASK_BACK_TO_TASKS) {
        pendingTaskStep.set(ctx.from.id, 'task_project_pick');
        const projects = pendingTaskProjectList.get(ctx.from.id);
        if (projects) {
          await ctx.reply('Выбери проект:', { reply_markup: buildProjectSelectKeyboard(projects.length) });
        } else {
          await ctx.reply('Выбери действие:', { reply_markup: buildTasksMenu() });
        }
        return;
      }

      const draft = pendingTaskDrafts.get(ctx.from.id);
      const sections = pendingTaskSectionList.get(ctx.from.id);
      if (!draft || !sections) {
        pendingTaskStep.delete(ctx.from.id);
        await ctx.reply('Черновик задачи устарел. Повтори запрос.', { reply_markup: buildTasksMenu() });
        return;
      }

      if (normalized === TASK_NO_SECTION) {
        draft.sectionId = undefined;
        draft.sectionName = undefined;
        pendingTaskDrafts.set(ctx.from.id, draft);
        await askBitrixLink(ctx, draft);
        return;
      }

      const sectionNum = parseInt(normalized, 10);
      if (Number.isNaN(sectionNum) || sectionNum < 1 || sectionNum > sections.length) {
        await ctx.reply('Нажми номер колонки из списка.', {
          reply_markup: buildSectionSelectKeyboard(sections.length),
        });
        return;
      }

      const section = sections[sectionNum - 1];
      draft.sectionId = section.id;
      draft.sectionName = section.name;
      pendingTaskDrafts.set(ctx.from.id, draft);
      await askBitrixLink(ctx, draft);
      return;
    }

    if (taskStep === 'task_bitrix_pick') {
      if (normalized === TASK_BACK_TO_TASKS) {
        pendingTaskStep.delete(ctx.from.id);
        pendingTaskDrafts.delete(ctx.from.id);
        pendingTaskProjectList.delete(ctx.from.id);
        pendingTaskSectionList.delete(ctx.from.id);
        await ctx.reply('Создание задачи отменено.', { reply_markup: buildTasksMenu() });
        return;
      }

      if (normalized !== TASK_LINK_BITRIX_YES && normalized !== TASK_LINK_BITRIX_NO) {
        await ctx.reply('Выбери один из вариантов кнопками ниже.', { reply_markup: buildBitrixChoiceKeyboard() });
        return;
      }

      const draft = pendingTaskDrafts.get(ctx.from.id);
      if (!draft) {
        pendingTaskStep.delete(ctx.from.id);
        await ctx.reply('Черновик задачи устарел. Повтори запрос.', { reply_markup: buildTasksMenu() });
        return;
      }

      const shouldLink = normalized === TASK_LINK_BITRIX_YES;
      try {
        const labels = shouldLink ? [...(draft.labels ?? []), 'bitrix'] : draft.labels;
        const description = shouldLink ? 'bitrix:' : undefined;
        const task = await todoist.createTask(
          draft.content,
          draft.dueString,
          labels,
          draft.projectId,
          draft.sectionId,
          description,
          draft.projectName,
        );

        const projectName = draft.projectName ?? 'Входящие';
        const sectionName = draft.sectionName ?? 'без колонки';
        pendingTaskStep.delete(ctx.from.id);
        pendingTaskDrafts.delete(ctx.from.id);
        pendingTaskProjectList.delete(ctx.from.id);
        pendingTaskSectionList.delete(ctx.from.id);
        await ctx.reply(
          `Задача создана: *${escapeMarkdown(task.content)}*\nПроект: *${escapeMarkdown(projectName)}*\nКолонка: *${escapeMarkdown(sectionName)}*${shouldLink ? '\nСвязка с Bitrix: *да* (в описание добавлено `bitrix:`)' : '\nСвязка с Bitrix: *нет*'}`,
          { parse_mode: 'Markdown', reply_markup: buildTasksMenu() },
        );
      } catch (err) {
        logger.error({ err }, 'Error creating task after message bitrix choice');
        await ctx.reply('Ошибка создания задачи.', { reply_markup: buildTasksMenu() });
      }
      return;
    }

    // ─── Finance menu buttons ───

    // Finance step-based routing (pending step takes priority)
    const finStep = pendingFinStep.get(ctx.from.id);

    if (finStep === 'confirm') {
      const pending = pendingFinTx.get(ctx.from.id);
      if (!pending) { pendingFinStep.delete(ctx.from.id); }
      else if (normalized === FIN_CONFIRM || normalized === FIN_CONFIRM_LEGACY) {
        pendingFinStep.delete(ctx.from.id);
        pendingFinTx.delete(ctx.from.id);
        try {
          await ctx.replyWithChatAction('typing');
          const tx = await finance.addTransaction(pending);
          const typeLabel = pending.type === 'expense' ? '💸 Расход' : '💰 Доход';
          let msg = `✅ Записано!\n${typeLabel}: *${formatMoney(tx.amount)} ₽*\n📁 ${pending.category}`;
          if (pending.description) msg += `\n📝 ${pending.description}`;
          if (pending.type === 'expense') {
            try {
              const budgets = await finance.getBudgets();
              const b = budgets.find(b => b.category === pending.category);
              if (b && b.limit > 0) {
                const pct = Math.round((b.spent / b.limit) * 100);
                if (pct >= 100) msg += `\n\n🔴 Перерасход по «${pending.category}»: ${formatMoney(b.spent)} из ${formatMoney(b.limit)} ₽`;
                else if (pct >= 80) msg += `\n\n⚠️ По «${pending.category}» потрачено ${formatMoney(b.spent)} из ${formatMoney(b.limit)} ₽ (${pct}%)`;
              }
            } catch { /* best-effort */ }
          }
          await ctx.reply(msg, { parse_mode: 'Markdown', reply_markup: buildFinanceMenu() });
        } catch (err) {
          logger.error({ err }, 'Error saving transaction');
          await ctx.reply('Ошибка сохранения.', { reply_markup: buildFinanceMenu() });
        }
        return;
      } else if (normalized === FIN_EDIT_TX) {
        pendingFinStep.set(ctx.from.id, 'edit_menu');
        await ctx.reply('Что изменить?', { reply_markup: buildTxEditFieldKeyboard(pending.recurrence !== 'once') });
        return;
      } else if (normalized === FIN_CANCEL_TX) {
        pendingFinStep.delete(ctx.from.id);
        pendingFinTx.delete(ctx.from.id);
        await ctx.reply('Операция отменена.', { reply_markup: buildFinanceMenu() });
        return;
      } else {
        // Treat free text as draft edits while staying in confirm step.
        let changed = false;

        const amount = parseAmountFromText(normalized);
        if (amount !== null && amount > 0) {
          pending.amount = amount;
          changed = true;
        }

        const startDate = extractLooseDateByMarker(normalized, 'с') ?? extractLooseDateByMarker(normalized, 'на');
        if (startDate) {
          pending.date = startDate;
          changed = true;
        }

        const endDate = extractLooseDateByMarker(normalized, 'до');
        if (endDate) {
          pending.recurrence_end = endDate;
          if (pending.recurrence === 'once') pending.recurrence = 'monthly';
          changed = true;
        }

        const hasMonthlyHint = /ежемес|каждый\s+месяц|раз\s+в\s+месяц/i.test(normalized);
        if (hasMonthlyHint && pending.recurrence === 'once') {
          pending.recurrence = 'monthly';
          changed = true;
        }

        if (!changed) {
          try {
            const parsedEdits = await llm.parseFinanceTransactions(normalized);
            const p = parsedEdits[0];
            if (p) {
              if (p.amount && p.amount > 0) { pending.amount = p.amount; changed = true; }
              if (p.category) { pending.category = p.category; changed = true; }
              if (p.date) { pending.date = p.date; changed = true; }
              if (p.recurrence) { pending.recurrence = p.recurrence; changed = true; }
              if (p.recurrence_end) { pending.recurrence_end = p.recurrence_end; changed = true; }
              if (typeof p.description === 'string') { pending.description = p.description; changed = true; }
            }
          } catch {
            // best effort only
          }
        }

        pendingFinTx.set(ctx.from.id, pending);
        const hint = changed
          ? 'Черновик обновлён. Проверь и подтверди:'
          : 'Не понял правку. Укажи, что изменить (например: «до 27.10.29», «250», «категория Еда»), или нажми кнопку ниже.';
        await ctx.reply(hint + '\n\n' + formatTxCard(pending) + '\n\nСохранить операцию?', {
          parse_mode: 'Markdown',
          reply_markup: buildTxConfirmKeyboard(),
        });
        return;
      }
    }

    if (finStep === 'edit_menu') {
      const pending = pendingFinTx.get(ctx.from.id);
      if (!pending) { pendingFinStep.delete(ctx.from.id); }
      else if (normalized === FIN_FIELD_AMOUNT) {
        pendingFinEditField.set(ctx.from.id, 'amount');
        pendingFinStep.delete(ctx.from.id);
        await ctx.reply('Введи новую сумму:');
        return;
      } else if (normalized === FIN_FIELD_CATEGORY) {
        pendingFinStep.set(ctx.from.id, 'category');
        await ctx.reply('Выбери категорию:', { reply_markup: buildCategoryKeyboard(pending.type) });
        return;
      } else if (normalized === FIN_FIELD_DATE) {
        pendingFinEditField.set(ctx.from.id, 'date');
        pendingFinStep.delete(ctx.from.id);
        await ctx.reply('Введи дату (ДД.ММ.ГГГГ):');
        return;
      } else if (normalized === FIN_FIELD_DESC) {
        pendingFinEditField.set(ctx.from.id, 'description');
        pendingFinStep.delete(ctx.from.id);
        await ctx.reply('Введи название (или «-» чтобы убрать):');
        return;
      } else if (normalized === FIN_FIELD_REC) {
        pendingFinStep.set(ctx.from.id, 'recurrence');
        await ctx.reply('Выбери периодичность:', { reply_markup: buildRecurrenceKeyboard() });
        return;
      } else if (normalized === FIN_FIELD_REC_END) {
        pendingFinStep.set(ctx.from.id, 'recurrence_end');
        await ctx.reply('До какой даты повторять?', { reply_markup: new Keyboard().text(FIN_ENDLESS).text(FIN_BACK_TX).resized() });
        return;
      } else if (normalized === FIN_BACK_TX) {
        pendingFinStep.set(ctx.from.id, 'confirm');
        await ctx.reply(formatTxCard(pending) + '\n\nЗаписать?', { parse_mode: 'Markdown', reply_markup: buildTxConfirmKeyboard() });
        return;
      } else {
        // Keep finance context: allow quick free-text rename and never fall through to task routing.
        const rename = normalized.match(/(?:названи[ея]|описани[ея]|комментари[йя])\s*(?:добав[ьй]|измени|постав[ьй])?\s*(?:[:\-]|на)?\s*(.+)$/i);
        const value = rename?.[1]?.trim();
        if (value) {
          pending.description = value;
          pendingFinTx.set(ctx.from.id, pending);
          pendingFinStep.set(ctx.from.id, 'confirm');
          await ctx.reply('Название обновил. Проверь и подтверди:', {
            reply_markup: buildTxConfirmKeyboard(),
          });
          await ctx.reply(formatTxCard(pending) + '\n\nСохранить операцию?', {
            parse_mode: 'Markdown',
            reply_markup: buildTxConfirmKeyboard(),
          });
          return;
        }

        await ctx.reply('Выбери, что изменить, кнопками ниже.', {
          reply_markup: buildTxEditFieldKeyboard(pending.recurrence !== 'once'),
        });
        return;
      }
    }

    if (finStep === 'category') {
      const pending = pendingFinTx.get(ctx.from.id);
      if (normalized === FIN_BACK_TX && pending) {
        pendingFinStep.set(ctx.from.id, 'confirm');
        await ctx.reply(formatTxCard(pending) + '\n\nЗаписать?', { parse_mode: 'Markdown', reply_markup: buildTxConfirmKeyboard() });
        return;
      }
      const allCats = [...EXPENSE_CATEGORIES, ...INCOME_CATEGORIES] as string[];
      if (pending && allCats.includes(normalized)) {
        pending.category = normalized;
        pendingFinTx.set(ctx.from.id, pending);
        pendingFinStep.set(ctx.from.id, 'confirm');
        await ctx.reply(formatTxCard(pending) + '\n\nЗаписать?', { parse_mode: 'Markdown', reply_markup: buildTxConfirmKeyboard() });
        return;
      }
    }

    if (finStep === 'recurrence') {
      const pending = pendingFinTx.get(ctx.from.id);
      const recMap: Record<string, string> = {
        [FIN_REC_ONCE]: 'once', [FIN_REC_DAILY]: 'daily',
        [FIN_REC_WEEKLY]: 'weekly', [FIN_REC_MONTHLY]: 'monthly',
        [FIN_REC_QUARTERLY]: 'quarterly',
      };
      if (normalized === FIN_BACK_TX && pending) {
        pendingFinStep.set(ctx.from.id, 'confirm');
        await ctx.reply(formatTxCard(pending) + '\n\nЗаписать?', { parse_mode: 'Markdown', reply_markup: buildTxConfirmKeyboard() });
        return;
      }
      if (pending && recMap[normalized]) {
        pending.recurrence = recMap[normalized];
        pending.recurrence_end = undefined;
        pendingFinTx.set(ctx.from.id, pending);
        if (recMap[normalized] !== 'once') {
          pendingFinStep.set(ctx.from.id, 'recurrence_end');
          await ctx.reply('До какой даты повторять?', { reply_markup: new Keyboard().text(FIN_ENDLESS).text(FIN_BACK_TX).resized() });
        } else {
          pendingFinStep.set(ctx.from.id, 'confirm');
          await ctx.reply(formatTxCard(pending) + '\n\nЗаписать?', { parse_mode: 'Markdown', reply_markup: buildTxConfirmKeyboard() });
        }
        return;
      }
    }

    if (finStep === 'recurrence_end') {
      const pending = pendingFinTx.get(ctx.from.id);
      if (normalized === FIN_BACK_TX && pending) {
        pendingFinStep.set(ctx.from.id, 'confirm');
        await ctx.reply(formatTxCard(pending) + '\n\nЗаписать?', { parse_mode: 'Markdown', reply_markup: buildTxConfirmKeyboard() });
        return;
      }
      if (pending) {
        if (normalized === FIN_ENDLESS || /бессрочно/i.test(normalized)) {
          pending.recurrence_end = undefined;
        } else {
          const date = parseDateFromText(normalized);
          if (!date) { await ctx.reply('Не понял дату. Напиши ДД.ММ.ГГГГ или «Бессрочно».'); return; }
          pending.recurrence_end = date;
        }
        pendingFinTx.set(ctx.from.id, pending);
        pendingFinStep.set(ctx.from.id, 'confirm');
        await ctx.reply(formatTxCard(pending) + '\n\nЗаписать?', { parse_mode: 'Markdown', reply_markup: buildTxConfirmKeyboard() });
        return;
      }
    }

    if (finStep === 'forecast') {
      const periodMap: Record<string, 'week' | 'month' | 'quarter' | 'year'> = {
        [FIN_FC_WEEK]: 'week', [FIN_FC_MONTH]: 'month', [FIN_FC_QUARTER]: 'quarter',
        [FIN_FC_YEAR]: 'year',
      };
      if (normalized === FIN_BACK_FIN) {
        pendingFinStep.delete(ctx.from.id);
        await showFinanceMenu(ctx);
        return;
      }
      if (periodMap[normalized]) {
        const period = periodMap[normalized];
        pendingFinStep.delete(ctx.from.id);
        await ctx.replyWithChatAction('typing');
        try {
          const forecast = await finance.computeForecast(period);
          await ctx.reply(formatForecast(forecast, period), { parse_mode: 'Markdown', reply_markup: buildFinanceMenu() });
        } catch (err) {
          logger.error({ err }, 'Error computing forecast');
          await ctx.reply('Не удалось построить прогноз.', { reply_markup: buildFinanceMenu() });
        }
        return;
      }
    }

    if (finStep === 'analysis') {
      const periodMap: Record<string, 'month' | 'quarter' | 'year'> = {
        [FIN_AN_MONTH]: 'month',
        [FIN_AN_QUARTER]: 'quarter',
        [FIN_AN_YEAR]: 'year',
      };
      if (normalized === FIN_BACK_FIN) {
        pendingFinStep.delete(ctx.from.id);
        await showFinanceMenu(ctx);
        return;
      }
      if (periodMap[normalized]) {
        pendingFinStep.delete(ctx.from.id);
        await showFinanceAnalytics(ctx, periodMap[normalized]);
        return;
      }
    }

    if (finStep === 'settings') {
      if (normalized === FIN_BAL) {
        pendingFinStep.delete(ctx.from.id);
        pendingFinOnboarding.add(ctx.from.id);
        await ctx.reply('Введи текущий баланс в рублях:');
        return;
      }
      if (normalized === FIN_THRESHOLD_BTN) {
        pendingFinStep.delete(ctx.from.id);
        pendingFinThreshold.add(ctx.from.id);
        await ctx.reply('Введи минимальный порог баланса в рублях:');
        return;
      }
      if (normalized === FIN_BUDGETS_BTN) {
        pendingFinStep.delete(ctx.from.id);
        await showFinanceBudgets(ctx);
        return;
      }
      if (normalized === FIN_BACK_FIN) {
        pendingFinStep.delete(ctx.from.id);
        await showFinanceMenu(ctx);
        return;
      }
    }

    if (finStep === 'budget_cat') {
      const allExpenseCats = EXPENSE_CATEGORIES as readonly string[];
      if (normalized === FIN_BACK_FIN) {
        pendingFinStep.delete(ctx.from.id);
        await showFinanceMenu(ctx);
        return;
      }
      if (allExpenseCats.includes(normalized)) {
        pendingFinStep.delete(ctx.from.id);
        pendingFinBudget.set(ctx.from.id, normalized);
        await ctx.reply(`Введи лимит для «*${normalized}*» в рублях:`, { parse_mode: 'Markdown', reply_markup: buildFinanceMenu() });
        return;
      }
    }

    if (finStep === 'recent_list') {
      if (normalized === FIN_BACK_FIN) {
        pendingFinStep.delete(ctx.from.id);
        pendingFinTxList.delete(ctx.from.id);
        await showFinanceMenu(ctx);
        return;
      }
      const txList = pendingFinTxList.get(ctx.from.id);
      const num = parseInt(normalized, 10);
      if (txList && !isNaN(num) && num >= 1 && num <= txList.length) {
        const tx = txList[num - 1];
        pendingFinTxSelected.set(ctx.from.id, tx.id);
        pendingFinStep.set(ctx.from.id, 'tx_action');
        await ctx.reply(formatTxCard(tx), { parse_mode: 'Markdown', reply_markup: buildTxActionKeyboard() });
        return;
      }
    }

    if (finStep === 'tx_action') {
      const txId = pendingFinTxSelected.get(ctx.from.id);
      if (normalized === FIN_BACK_RECENT) {
        pendingFinStep.delete(ctx.from.id);
        pendingFinTxSelected.delete(ctx.from.id);
        await showRecentTransactions(ctx);
        return;
      }
      if (normalized === FIN_TX_DELETE && txId) {
        try {
          await finance.deleteTransaction(txId);
          pendingFinStep.delete(ctx.from.id);
          pendingFinTxSelected.delete(ctx.from.id);
          pendingFinTxList.delete(ctx.from.id);
          await ctx.reply('🗑 Операция удалена.', { reply_markup: buildFinanceMenu() });
        } catch (err) {
          logger.error({ err }, 'Error deleting tx');
          await ctx.reply('Ошибка удаления.', { reply_markup: buildFinanceMenu() });
        }
        return;
      }
    }

    if (finStep === 'recurring_list') {
      if (normalized === FIN_BACK_FIN) {
        pendingFinStep.delete(ctx.from.id);
        pendingFinRecurringList.delete(ctx.from.id);
        await showFinanceMenu(ctx);
        return;
      }
      const recList = pendingFinRecurringList.get(ctx.from.id);
      const num = parseInt(normalized, 10);
      if (recList && !isNaN(num) && num >= 1 && num <= recList.length) {
        const tx = recList[num - 1];
        pendingFinTxSelected.set(ctx.from.id, tx.id);
        pendingFinStep.set(ctx.from.id, 'recurring_action');
        const sign = tx.type === 'expense' ? '−' : '+';
        await ctx.reply(
          `${sign}${formatMoney(tx.amount)}₽ — ${tx.description || tx.category} [${formatRecurrenceLabel(tx.recurrence)}]`,
          { reply_markup: buildRecurringActionKeyboard() }
        );
        return;
      }
    }

    if (finStep === 'recurring_action') {
      const txId = pendingFinTxSelected.get(ctx.from.id);
      if (normalized === FIN_BACK_RECURRING) {
        pendingFinStep.delete(ctx.from.id);
        pendingFinTxSelected.delete(ctx.from.id);
        await showRecurringTransactions(ctx);
        return;
      }
      if (txId && normalized === FIN_TX_PAUSE) {
        try {
          await finance.updateTransaction(txId, { recurrence: 'once' });
          pendingFinStep.delete(ctx.from.id);
          pendingFinTxSelected.delete(ctx.from.id);
          pendingFinRecurringList.delete(ctx.from.id);
          await ctx.reply('⏸ Платёж приостановлен (переведён в разовый).', { reply_markup: buildFinanceMenu() });
        } catch { await ctx.reply('Ошибка.', { reply_markup: buildFinanceMenu() }); }
        return;
      }
      if (txId && normalized === FIN_TX_DELETE) {
        try {
          await finance.deleteTransaction(txId);
          pendingFinStep.delete(ctx.from.id);
          pendingFinTxSelected.delete(ctx.from.id);
          pendingFinRecurringList.delete(ctx.from.id);
          await ctx.reply('🗑 Регулярный платёж удалён.', { reply_markup: buildFinanceMenu() });
        } catch { await ctx.reply('Ошибка.', { reply_markup: buildFinanceMenu() }); }
        return;
      }
    }

    // Finance menu button handling (no pending step)
    if (normalized === FIN_ADD) {
      pendingFinStep.delete(ctx.from.id);
      pendingFinAdd.add(ctx.from.id);
      await ctx.reply(
        'Напиши трату или доход в свободной форме:\n\n' +
        '• "потратил 1200 в пятёрочке"\n' +
        '• "зп 60к"\n' +
        '• "кофе 350 и такси 800"\n' +
        '• "аренда 35000 каждый месяц до 01.01.2027"',
        { reply_markup: buildFinanceMenu() },
      );
      return;
    }

    if (normalized === FIN_SUMMARY) {
      await showFinanceSummary(ctx);
      return;
    }

    if (normalized === FIN_FORECAST_BTN) {
      pendingFinStep.set(ctx.from.id, 'forecast');
      await ctx.reply('Выбери период прогноза:', { reply_markup: buildForecastPeriodMenu() });
      return;
    }

    if (normalized === FIN_ANALYTICS_BTN) {
      pendingFinStep.set(ctx.from.id, 'analysis');
      await ctx.reply('Выбери период аналитики:', { reply_markup: buildAnalysisPeriodMenu() });
      return;
    }

    if (normalized === FIN_RECENT_BTN) {
      await showDayOperations(ctx);
      return;
    }

    if (normalized === FIN_RECURRING_BTN) {
      await showRecurringTransactions(ctx);
      return;
    }

    if (normalized === FIN_SETTINGS_BTN) {
      try {
        const [minBalance, initialBalance] = await Promise.all([
          finance.getMinBalance(),
          finance.getInitialBalance(),
        ]);
        pendingFinStep.set(ctx.from.id, 'settings');
        const text = `⚙️ *Настройки финансов*\n\n💵 Начальный баланс: ${initialBalance != null ? formatMoney(initialBalance) + ' ₽' : '_не задан_'}\n🚨 Минимальный порог: ${formatMoney(minBalance)} ₽`;
        await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: buildFinanceSettingsMenu() });
      } catch {
        await ctx.reply('Не удалось загрузить настройки.', { reply_markup: buildFinanceMenu() });
      }
      return;
    }

    if (normalized === FIN_BACK_FIN) {
      pendingFinStep.delete(ctx.from.id);
      await showFinanceMenu(ctx);
      return;
    }

    await ctx.replyWithChatAction('typing');
    try {
      // Finance onboarding: waiting for initial balance
      if (pendingFinOnboarding.has(ctx.from.id)) {
        const amount = parseAmountFromText(normalized);
        if (amount === null) {
          await ctx.reply('Не понял сумму. Напиши число, например: 45000');
          return;
        }
        pendingFinOnboarding.delete(ctx.from.id);
        try {
          await finance.setInitialBalance(amount);
          await ctx.reply(
            `✅ Баланс: *${formatMoney(amount)} ₽*\n\nХочешь задать минимальный порог?`,
            { parse_mode: 'Markdown', reply_markup: new Keyboard().text(FIN_THRESHOLD_BTN).text(FIN_BACK_FIN).resized() },
          );
        } catch (err) {
          logger.error({ err }, 'Error setting initial balance');
          const apiUrl = process.env.FINANCE_API_URL || 'http://localhost:4000';
          await ctx.reply(
            `⚠️ Не удалось сохранить баланс — финансовый API недоступен.\n\nУбедись, что сервер запущен на \`${apiUrl}\``,
            { parse_mode: 'Markdown' },
          );
        }
        return;
      }

      // Finance threshold: waiting for min balance
      if (pendingFinThreshold.has(ctx.from.id)) {
        const amount = parseAmountFromText(normalized);
        if (amount === null) {
          await ctx.reply('Не понял сумму. Напиши число, например: 5000');
          return;
        }
        pendingFinThreshold.delete(ctx.from.id);
        try {
          await finance.setMinBalance(amount);
          await ctx.reply(
            `✅ Минимальный порог установлен: *${formatMoney(amount)} ₽*\n\nБуду предупреждать, когда баланс приблизится к нему.`,
            { parse_mode: 'Markdown' },
          );
          await showFinanceMenu(ctx);
        } catch (err) {
          logger.error({ err }, 'Error setting min balance');
          await ctx.reply('Не удалось сохранить порог. Финансовый API недоступен.');
        }
        return;
      }

      // Finance budget: waiting for limit amount
      if (pendingFinBudget.has(ctx.from.id)) {
        const category = pendingFinBudget.get(ctx.from.id)!;
        const amount = parseAmountFromText(normalized);
        if (amount === null) {
          await ctx.reply('Не понял сумму. Напиши число, например: 15000');
          return;
        }
        pendingFinBudget.delete(ctx.from.id);
        try {
          await finance.upsertBudget({ category, limit: amount });
          await ctx.reply(
            `✅ Лимит для «*${category}*»: *${formatMoney(amount)} ₽*`,
            { parse_mode: 'Markdown' },
          );
        } catch (err) {
          logger.error({ err }, 'Error setting budget');
          await ctx.reply('Не удалось сохранить лимит. Финансовый API недоступен.');
        }
        return;
      }

      // Finance edit field: waiting for text input for amount, date, description, or recurrence_end
      if (pendingFinEditField.has(ctx.from.id)) {
        const field = pendingFinEditField.get(ctx.from.id)!;
        const pending = pendingFinTx.get(ctx.from.id);
        if (!pending) { pendingFinEditField.delete(ctx.from.id); /* fall through */ }
        else {
          if (field === 'amount') {
            const amount = parseAmountFromText(normalized);
            if (amount === null) { await ctx.reply('Не понял сумму.'); return; }
            pending.amount = amount;
          } else if (field === 'date') {
            const date = parseDateFromText(normalized);
            if (!date) { await ctx.reply('Не понял дату. ДД.ММ.ГГГГ'); return; }
            pending.date = date;
          } else if (field === 'description') {
            pending.description = normalized === '-' ? undefined : normalized;
          } else if (field === 'recurrence_end') {
            if (/бессрочно/i.test(normalized) || normalized === FIN_ENDLESS) {
              pending.recurrence_end = undefined;
            } else {
              const date = parseDateFromText(normalized);
              if (!date) { await ctx.reply('Не понял дату. ДД.ММ.ГГГГ или «Бессрочно».'); return; }
              pending.recurrence_end = date;
            }
          }
          pendingFinTx.set(ctx.from.id, pending);
          pendingFinEditField.delete(ctx.from.id);
          pendingFinStep.set(ctx.from.id, 'confirm');
          await ctx.reply(formatTxCard(pending) + '\n\nЗаписать?', { parse_mode: 'Markdown', reply_markup: buildTxConfirmKeyboard() });
          return;
        }
      }

      // Finance add: waiting for free-text transaction(s)
      if (pendingFinAdd.has(ctx.from.id)) {
        pendingFinAdd.delete(ctx.from.id);
        const txList = await parseFinanceDraftsFromText(normalized);
        if (txList.length === 0) {
          await ctx.reply(
            'Не удалось распознать операцию. Попробуй написать иначе, например: "потратил 500 на продукты"',
            { reply_markup: buildMainMenu() },
          );
          return;
        }

        if (txList.length === 1) {
          pendingFinTx.set(ctx.from.id, txList[0]);
          pendingFinStep.set(ctx.from.id, 'confirm');
          await ctx.reply(formatTxCard(txList[0]) + '\n\nЗаписать?', {
            parse_mode: 'Markdown',
            reply_markup: buildTxConfirmKeyboard(),
          });
        } else {
          // Multiple txs — show summary and confirm all
          pendingFinMulti.set(ctx.from.id, { txs: txList, saved: 0 });
          const lines = [`📋 Найдено *${txList.length}* операции:\n`];
          txList.forEach((tx, i) => {
            const sign = tx.type === 'expense' ? '−' : '+';
            lines.push(`${i + 1}. ${sign}${formatMoney(tx.amount)} ₽ — ${tx.description || tx.category}`);
          });
          lines.push('\nЗаписать все?');
          await ctx.reply(lines.join('\n'), {
            parse_mode: 'Markdown',
            reply_markup: new Keyboard()
              .text(FIN_CONFIRM_ALL)
              .text(FIN_CANCEL_ALL)
              .resized(),
          });
        }
        return;
      }

      // Multi-tx confirmation
      if (pendingFinMulti.has(ctx.from.id)) {
        const multiCtx = pendingFinMulti.get(ctx.from.id)!;
        if (normalized === FIN_CONFIRM_ALL) {
          pendingFinMulti.delete(ctx.from.id);
          let savedCount = 0;
          const errors: string[] = [];
          for (const tx of multiCtx.txs) {
            try {
              await finance.addTransaction(tx);
              savedCount++;
            } catch {
              errors.push(`${tx.description || tx.category}: ошибка сохранения`);
            }
          }
          let msg = `✅ Записано *${savedCount}* из *${multiCtx.txs.length}* операций.`;
          if (errors.length > 0) msg += '\n⚠️ ' + errors.join('\n⚠️ ');
          await ctx.reply(msg, { parse_mode: 'Markdown', reply_markup: buildFinanceMenu() });
        } else if (normalized === FIN_CANCEL_ALL) {
          pendingFinMulti.delete(ctx.from.id);
          await ctx.reply('Отменено.', { reply_markup: buildFinanceMenu() });
        }
        return;
      }

      if (pendingCreateContext.has(ctx.from.id)) {
        pendingCreateContext.delete(ctx.from.id);

        const forcedText = /созда(й|ть|йте)|добав(ь|ить|ьте)|постав(ь|ить|ьте)|нов(ая|ую)\s+задач|задача\s*:/i.test(text)
          ? text
          : `Создай задачу: ${text}`;

        const result = await router.processMessage(ctx.from.id, forcedText);
        const safeContent = pickSafeTaskContent(text, result.type === 'task_draft' ? result.content : undefined);
        const draft: TaskDraftIntent = result.type === 'task_draft'
          ? { ...result, content: safeContent }
          : { type: 'task_draft', content: safeContent };

        pendingTaskDrafts.set(ctx.from.id, draft);
        const projects = await todoist.listProjects();
        const compactProjects = projects.map((p) => ({ id: p.id, name: p.name }));
        pendingTaskProjectList.set(ctx.from.id, compactProjects);
        pendingTaskStep.set(ctx.from.id, 'task_project_pick');
        const lines = [`Куда добавить задачу *${escapeMarkdown(draft.content)}*?`, 'Сначала выбери проект:'];
        compactProjects.forEach((p, i) => lines.push(`${i + 1}. ${p.name}`));
        await ctx.reply(
          lines.join('\n'),
          { parse_mode: 'Markdown', reply_markup: buildProjectSelectKeyboard(compactProjects.length) },
        );
        return;
      }

      const statusCtx = pendingStatusContext.get(ctx.from.id);
      if (statusCtx) {
        const requestedColumn = extractColumnTarget(text);
        if (requestedColumn && statusCtx.taskIds.length === 1) {
          try {
            const options = await getStatusColumnOptions(statusCtx.taskIds[0]);
            const matched = resolveSectionByName(options.sections, requestedColumn);
            if (!matched) {
              await ctx.reply(
                `Не нашёл колонку «${escapeMarkdown(requestedColumn)}». Доступно: ${options.sections.map((s) => `*${escapeMarkdown(s.name)}*`).join(', ')}`,
                { parse_mode: 'Markdown', reply_markup: buildTasksMenu() },
              );
              return;
            }

            const moved = await todoist.moveTaskToSection(statusCtx.taskIds[0], matched.id);
            pendingStatusContext.delete(ctx.from.id);
            await ctx.reply(
              `Задача *${escapeMarkdown(moved.content)}* перенесена в колонку *${escapeMarkdown(matched.name)}*.`,
              { parse_mode: 'Markdown', reply_markup: buildTasksMenu() },
            );
            return;
          } catch (err) {
            logger.error({ err, taskId: statusCtx.taskIds[0], requestedColumn }, 'Error moving task from status context by text');
          }
        }

        const inferredStatus = inferStatusFromText(text);
        if (!inferredStatus) {
          const fallbackStatus = await resolveFallbackStatusForScope(statusCtx.taskIds);
          const scopedReply = await applyStatusUpdateForScope(
            ctx.from.id,
            statusCtx.taskIds,
            statusCtx.taskName,
            fallbackStatus,
            text,
          );
          await ctx.reply(
            `${scopedReply}\nЯ сохранил текст как комментарий и оставил текущий статус: *${escapeMarkdown(fallbackStatus)}*.`,
            { parse_mode: 'Markdown', reply_markup: buildTasksMenu() },
          );
          return;
        }

        if (inferredStatus === 'completed') {
          pendingStatusCompletionChoice.set(ctx.from.id, {
            taskIds: statusCtx.taskIds,
            taskName: statusCtx.taskName,
            commentText: text,
            preferredDoneColumn: 'Done',
          });
          await ctx.reply(
            'Как завершить задачу?\n1) Перенести в колонку *Done* и завершить\n2) Только завершить без переноса',
            { parse_mode: 'Markdown', reply_markup: buildCompletionChoiceKeyboard() },
          );
          return;
        }

        const scopedReply = await applyStatusUpdateForScope(ctx.from.id, statusCtx.taskIds, statusCtx.taskName, inferredStatus, text);
        await ctx.reply(scopedReply, { parse_mode: 'Markdown', reply_markup: buildTasksMenu() });
        return;
      }

      const section = userSection.get(ctx.from.id);

      // "Баланс 296.17" → set initial balance directly (works in any section)
      const balanceSet = /^баланс\s+([\d.,\s]+)/i.exec(normalized);
      if (balanceSet) {
        const amount = parseAmountFromText(balanceSet[1].trim());
        if (amount !== null) {
          try {
            await finance.setInitialBalance(amount);
            await ctx.reply(
              `✅ Баланс обновлён: *${formatMoney(amount)} ₽*`,
              { parse_mode: 'Markdown', reply_markup: buildFinanceMenu() },
            );
          } catch (err) {
            logger.error({ err }, 'Error setting initial balance via text');
            await ctx.reply('Не удалось сохранить баланс. Финансовый API недоступен.');
          }
          return;
        }
      }

      // Finance section: always try to parse as transaction
      if (section === 'finance' || looksLikeFinanceAddIntent(normalized)) {
        const txList = await parseFinanceDraftsFromText(normalized);
        if (txList.length > 0) {
          if (txList.length === 1) {
            pendingFinTx.set(ctx.from.id, txList[0]);
            pendingFinStep.set(ctx.from.id, 'confirm');
            await ctx.reply(formatTxCard(txList[0]) + '\n\nСохранить операцию?', {
              parse_mode: 'Markdown',
              reply_markup: buildTxConfirmKeyboard(),
            });
          } else {
            pendingFinMulti.set(ctx.from.id, { txs: txList, saved: 0 });
            const lines = [`📋 Найдено *${txList.length}* операции:\n`];
            txList.forEach((tx, i) => {
              const sign = tx.type === 'expense' ? '−' : '+';
              lines.push(`${i + 1}. ${sign}${formatMoney(tx.amount)} ₽ — ${tx.description || tx.category}`);
            });
            lines.push('\nЗаписать все?');
            await ctx.reply(lines.join('\n'), {
              parse_mode: 'Markdown',
              reply_markup: new Keyboard().text(FIN_CONFIRM_ALL).text(FIN_CANCEL_ALL).resized(),
            });
          }
          return;
        }
        if (section === 'finance') {
          // In finance section but nothing recognized → hint, don't fall to task router
          await ctx.reply(
            'Не понял операцию. Напиши, например:\n• "потратил 500 на продукты"\n• "зп 60к"\n• "аренда 35000 каждый месяц"',
            { reply_markup: buildFinanceMenu() },
          );
          return;
        }
      }

      // Fitness section: text input not expected, just nudge
      if (section === 'fitness') {
        await ctx.reply('Используй кнопки меню для работы с фитнесом.', { reply_markup: buildFitnessMenu() });
        return;
      }

      const explicitCreate = /созда(й|ть|йте)|добав(ь|ить|ьте)|постав(ь|ить|ьте)|нов(ая|ую)\s+задач|задача\s*:/i.test(normalized);
      const statusLike = /по\s+задаче|статус|ожида|жду|комментар|фидбек|на\s+ревью/i.test(normalized);

      if (statusLike && !explicitCreate) {
        await ctx.reply(
          'Чтобы обновить статус без ложных срабатываний, используй кнопку *📝 Дать статус* и выбери задачу.',
          { parse_mode: 'Markdown', reply_markup: buildTasksMenu() },
        );
        return;
      }

      const result = await router.processMessage(ctx.from.id, text);

      if (result.type === 'task_draft') {
        const safeDraft: TaskDraftIntent = {
          ...result,
          content: pickSafeTaskContent(text, result.content),
        };
        pendingTaskDrafts.set(ctx.from.id, safeDraft);
        const projects = await todoist.listProjects();
        const compactProjects = projects.map((p) => ({ id: p.id, name: p.name }));
        pendingTaskProjectList.set(ctx.from.id, compactProjects);
        pendingTaskStep.set(ctx.from.id, 'task_project_pick');
        const lines = [`Куда добавить задачу *${escapeMarkdown(safeDraft.content)}*?`, 'Сначала выбери проект:'];
        compactProjects.forEach((p, i) => lines.push(`${i + 1}. ${p.name}`));
        await ctx.reply(
          lines.join('\n'),
          { parse_mode: 'Markdown', reply_markup: buildProjectSelectKeyboard(compactProjects.length) },
        );
        return;
      }

      await ctx.reply(result.text, {
        parse_mode: 'Markdown',
        link_preview_options: { is_disabled: true },
      });
    } catch (err) {
      logger.error({ err }, 'Error processing message');
      await ctx.reply('Произошла ошибка. Попробуй ещё раз.');
    }
  });

  // ── Recurring payment confirmation callbacks ───────────────────────────
  bot.on('callback_query:data', async (ctx) => {
    if (!isAuthorized(ctx)) {
      await ctx.answerCallbackQuery();
      return;
    }

    const data = ctx.callbackQuery.data;

    // rec_confirm:{txId}:{date}
    if (data.startsWith('rec_confirm:')) {
      const [, txId, date] = data.split(':') as [string, string, string];
      if (!txId || !date) { await ctx.answerCallbackQuery(); return; }

      try {
        const due = await finance.getRecurringDueOn(date);
        const tx = due.find((t) => t.id === txId);
        if (!tx) {
          await ctx.editMessageText('✅ Платёж уже обработан.');
          await ctx.answerCallbackQuery();
          return;
        }

        await finance.confirmOccurrence(txId, date, tx.amount, tx);
        const label = tx.description ?? tx.category;
        await ctx.editMessageText(
          `✅ Проведено: ${tx.type === 'expense' ? '−' : '+'}${formatMoney(tx.amount)} ₽ — ${label}`,
          { parse_mode: 'Markdown' },
        );
      } catch (err) {
        logger.error({ err }, 'Failed to confirm recurring occurrence');
        await ctx.answerCallbackQuery('Ошибка при проведении');
        return;
      }
      await ctx.answerCallbackQuery('Проведено ✅');
      return;
    }

    // rec_skip:{txId}:{date}
    if (data.startsWith('rec_skip:')) {
      const [, txId, date] = data.split(':') as [string, string, string];
      if (!txId || !date) { await ctx.answerCallbackQuery(); return; }

      try {
        await finance.skipOccurrence(txId, date);
        await ctx.editMessageText('❌ Платёж пропущен на сегодня.', { parse_mode: 'Markdown' });
      } catch (err) {
        logger.error({ err }, 'Failed to skip recurring occurrence');
        await ctx.answerCallbackQuery('Ошибка');
        return;
      }
      await ctx.answerCallbackQuery('Пропущено');
      return;
    }

    // rec_adjust:{txId}:{date}
    if (data.startsWith('rec_adjust:')) {
      const [, txId, date] = data.split(':') as [string, string, string];
      if (!txId || !date) { await ctx.answerCallbackQuery(); return; }

      try {
        const due = await finance.getRecurringDueOn(date);
        const tx = due.find((t) => t.id === txId);
        if (!tx) {
          await ctx.editMessageText('✅ Платёж уже обработан.');
          await ctx.answerCallbackQuery();
          return;
        }

        const label = tx.description ?? tx.category;
        const msgId = ctx.callbackQuery.message?.message_id;
        if (msgId) {
          pendingRecurringAdjust.set(ctx.from.id, { txId, date, tx, messageId: msgId });
        }

        await ctx.editMessageText(
          `✏️ Введи новую сумму для *${label}*\n_(по умолчанию ${formatMoney(tx.amount)} ₽)_`,
          { parse_mode: 'Markdown' },
        );
      } catch (err) {
        logger.error({ err }, 'Failed to start adjust recurring');
        await ctx.answerCallbackQuery('Ошибка');
        return;
      }
      await ctx.answerCallbackQuery();
      return;
    }

    // ops_day:{date} — navigate to a date in the operations view
    if (data.startsWith('ops_day:')) {
      const dateIso = data.slice('ops_day:'.length);
      if (!dateIso || !/^\d{4}-\d{2}-\d{2}$/.test(dateIso)) {
        await ctx.answerCallbackQuery();
        return;
      }
      try {
        const { text, keyboard } = await buildDayOpsView(dateIso);
        await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: keyboard });
      } catch (err) {
        logger.error({ err }, 'Error navigating day ops');
        await ctx.answerCallbackQuery('Ошибка загрузки');
        return;
      }
      await ctx.answerCallbackQuery();
      return;
    }

    await ctx.answerCallbackQuery();
  });

  logger.info('Bot handlers registered');
}

function parseAmountFromText(text: string): number | null {
  const normalized = text.replace(/\s/g, '').replace(',', '.').toLowerCase();
  const match = normalized.match(/^(\d+(?:\.\d+)?)(к|k)?$/);
  if (!match) return null;
  const num = parseFloat(match[1]);
  const multiplier = match[2] ? 1000 : 1;
  return num * multiplier;
}

function parseDateFromText(text: string): string | null {
  // DD.MM.YYYY
  const ddmmyyyy = text.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (ddmmyyyy) {
    return `${ddmmyyyy[3]}-${ddmmyyyy[2]}-${ddmmyyyy[1]}`;
  }
  // YYYY-MM-DD
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return text;
  return null;
}

function normalizeTaskContentForMatch(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-zа-яё0-9\s]/gi, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3);
}

function pickSafeTaskContent(inputText: string, llmContent?: string): string {
  const raw = inputText.trim();
  const parsed = (llmContent ?? '').trim();
  if (!parsed) return raw;

  const inputTokens = normalizeTaskContentForMatch(raw);
  const parsedTokens = new Set(normalizeTaskContentForMatch(parsed));
  if (inputTokens.length === 0) return raw;

  const overlap = inputTokens.filter((t) => parsedTokens.has(t)).length;
  // If overlap is too small, treat parsed value as stale context and keep exact user text.
  if (overlap < Math.max(1, Math.floor(inputTokens.length * 0.4))) {
    return raw;
  }

  return parsed;
}
