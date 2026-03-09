import { Task } from '@doist/todoist-api-typescript';
import { TodoistService } from '../services/todoist';
import { CalendarService } from '../services/calendar';
import { BitrixService } from '../services/bitrix';
import { FinanceService } from '../services/finance';
import { parseBitrixIds } from '../services/bitrix-link';
import { getStatusMappings } from '../config/settings';
import { logger } from '../utils/logger';
import { ToolCall } from './client';
import { formatTaskList, formatEventList } from '../bot/formatters';
import { formatMoney, formatFinanceSummary, formatForecast, formatBudgetStatus } from '../bot/finance-formatters';

export class IntentExecutor {
  constructor(
    private todoist: TodoistService,
    private calendar: CalendarService,
    private bitrix: BitrixService,
    private finance?: FinanceService,
  ) {}

  async execute(toolCall: ToolCall): Promise<string> {
    const { name, arguments: argsStr } = toolCall.function;
    let args: Record<string, string | string[] | undefined>;
    try {
      args = JSON.parse(argsStr);
    } catch {
      args = {};
    }

    logger.info({ tool: name, args }, 'Executing intent');

    try {
      switch (name) {
        case 'create_task':
          return this.createTask(args);
        case 'complete_task':
          return this.completeTask(args);
        case 'update_task_status':
          return this.updateTaskStatus(args);
        case 'update_task_deadline':
          return this.updateTaskDeadline(args);
        case 'link_task_to_bitrix':
          return this.linkTaskToBitrix(args);
        case 'create_calendar_event':
          return this.createCalendarEvent(args);
        case 'get_today_plan':
          return this.getTodayPlan();
        case 'get_tasks':
          return this.getTasks(args);
        case 'add_bitrix_comment':
          return this.addBitrixComment(args);
        case 'add_transaction':
          return this.addTransaction(args);
        case 'get_finance_summary':
          return this.getFinanceSummary(args);
        case 'get_transactions':
          return this.getFinanceTransactions(args);
        case 'set_budget':
          return this.setFinanceBudget(args);
        case 'get_budget_status':
          return this.getFinanceBudgetStatus(args);
        case 'get_forecast':
          return this.getFinanceForecast(args);
        case 'evaluate_unplanned_spend':
          return this.evaluateUnplannedSpend(args);
        case 'delete_transaction':
          return this.deleteFinanceTransaction(args);
        case 'update_transaction':
          return this.updateFinanceTransaction(args);
        case 'get_finance_settings':
          return this.getFinanceSettings();
        case 'set_finance_settings':
          return this.setFinanceSettings(args);
        default:
          return `Неизвестная команда: ${name}`;
      }
    } catch (err) {
      logger.error({ err, tool: name }, 'Intent execution failed');
      return `Произошла ошибка при выполнении: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  private async findTask(args: Record<string, string | string[] | undefined>): Promise<Task | null> {
    if (args.task_id) {
      return this.todoist.getTask(args.task_id as string);
    }
    if (args.task_name) {
      return this.todoist.findTaskByName(args.task_name as string);
    }
    return null;
  }

  private normalizeStatus(raw: string): string {
    const value = raw.trim().toLowerCase();
    if (/^(completed|done|чисто|готово|выполнено|завершено)$/.test(value)) return 'completed';
    if (/^(review|на ревью|ревью|на проверке)$/.test(value)) return 'review';
    if (/^(paused|пауза|блокер|on hold)$/.test(value)) return 'paused';
    if (/^(in progress|in_progress|в работе)$/.test(value)) return 'in_progress';
    return raw;
  }

  private async moveTaskToDoneSectionIfExists(task: Task): Promise<string | null> {
    if (this.todoist.hasBitrixLabel(task)) return null;
    const projectId = this.todoist.getTaskProjectId(task);
    if (!projectId || projectId === 'unknown') return null;

    const sections = await this.todoist.listSections(projectId);
    const doneSection = sections.find((s) => /^(done|готово|выполнено)$/i.test(s.name.trim()));
    if (!doneSection) return null;

    const currentSectionId = this.todoist.getTaskSectionId(task);
    if (currentSectionId !== doneSection.id) {
      await this.todoist.moveTaskToSection(task.id, doneSection.id);
    }
    return doneSection.name;
  }

  private async syncTaskToBitrix(task: Task, comment?: string, newStatus?: string): Promise<void> {
    if (!this.todoist.hasBitrixLabel(task)) return;

    const bitrixIds = parseBitrixIds(task.description ?? '');
    if (bitrixIds.length === 0) {
      logger.warn({ taskId: task.id }, 'Task has bitrix label but no bitrix ID in description');
      return;
    }

    const promises: Promise<void>[] = [];

    if (newStatus) {
      const mappings = await getStatusMappings();
      const mapping = mappings.find(m => m.todoistLabel === newStatus);
      if (mapping) {
        for (const bitrixId of bitrixIds) {
          promises.push(this.bitrix.moveTaskToStage(bitrixId, mapping.bitrixStageId));
        }
      }
    }

    if (comment) {
      for (const bitrixId of bitrixIds) {
        promises.push(this.bitrix.addComment(bitrixId, comment));
      }
    }

    await Promise.allSettled(promises);
  }

  private async createTask(args: Record<string, string | string[] | undefined>): Promise<string> {
    const content = args.content as string;
    const dueString = args.due_string as string | undefined;
    const labels = args.labels as string[] | undefined;

    const task = await this.todoist.createTask(content, dueString, labels);
    return `Задача создана: *${task.content}*${dueString ? `\nДедлайн: ${dueString}` : ''}`;
  }

  private async completeTask(args: Record<string, string | string[] | undefined>): Promise<string> {
    const task = await this.findTask(args);
    if (!task) return 'Задача не найдена. Уточни название.';

    const hasBitrix = this.todoist.hasBitrixLabel(task);
    const movedSectionName = await this.moveTaskToDoneSectionIfExists(task);
    await this.todoist.completeTask(task.id);

    if (hasBitrix) {
      await this.syncTaskToBitrix(task, 'Задача выполнена', 'completed');
    }

    return `Задача *${task.content}* отмечена как выполненная.${movedSectionName ? ` Перенесена в колонку "${movedSectionName}".` : ''}${hasBitrix ? ' Статус обновлён в Bitrix24.' : ''}`;
  }

  private async updateTaskStatus(args: Record<string, string | string[] | undefined>): Promise<string> {
    const task = await this.findTask(args);
    if (!task) return 'Задача не найдена. Уточни название.';

    const newStatus = this.normalizeStatus((args.new_status as string) ?? '');
    const comment = args.comment as string | undefined;

    if (newStatus === 'completed') {
      const movedSectionName = await this.moveTaskToDoneSectionIfExists(task);
      await this.todoist.completeTask(task.id);

      const hasBitrix = this.todoist.hasBitrixLabel(task);
      if (hasBitrix) {
        await this.syncTaskToBitrix(task, comment, 'completed');
      }

      return `Задача *${task.content}* отмечена как выполненная.${movedSectionName ? ` Перенесена в колонку "${movedSectionName}".` : ''}${hasBitrix ? ' Синхронизировано с Bitrix24.' : ''}${comment ? `\nКомментарий: ${comment}` : ''}`;
    }

    await this.todoist.updateTaskLabel(task.id, newStatus);

    const hasBitrix = this.todoist.hasBitrixLabel(task);
    if (hasBitrix) {
      await this.syncTaskToBitrix(task, comment, newStatus);
    }

    return `Статус задачи *${task.content}* обновлён на "${newStatus}".${hasBitrix ? ' Синхронизировано с Bitrix24.' : ''}${comment ? `\nКомментарий: ${comment}` : ''}`;
  }

  private async updateTaskDeadline(args: Record<string, string | string[] | undefined>): Promise<string> {
    const task = await this.findTask(args);
    if (!task) return 'Задача не найдена. Уточни название.';

    const dueString = args.due_string as string;
    await this.todoist.updateTaskDue(task.id, dueString);

    const hasBitrix = this.todoist.hasBitrixLabel(task);
    if (hasBitrix) {
      const bitrixIds = parseBitrixIds(task.description ?? '');
      if (bitrixIds.length > 0) {
        await Promise.allSettled(bitrixIds.map((id) => this.bitrix.addComment(id, `Дедлайн перенесён: ${dueString}`)));
      }
    }

    return `Дедлайн задачи *${task.content}* перенесён на "${dueString}".${hasBitrix ? ' Обновлено в Bitrix24.' : ''}`;
  }

  private async linkTaskToBitrix(args: Record<string, string | string[] | undefined>): Promise<string> {
    const task = await this.findTask(args);
    if (!task) return 'Задача не найдена. Уточни название.';

    const bitrixId = args.bitrix_id as string;
    await this.todoist.addBitrixLink(task.id, bitrixId);

    return `Задача *${task.content}* привязана к Bitrix24 (ID: ${bitrixId}). Добавлена метка bitrix.`;
  }

  private async createCalendarEvent(args: Record<string, string | string[] | undefined>): Promise<string> {
    const title = args.title as string;
    const startDatetime = args.start_datetime as string;
    const endDatetime = args.end_datetime as string;
    const description = args.description as string | undefined;
    const location = args.location as string | undefined;
    const recurrenceRule = args.recurrence_rule as string | undefined;
    const normalizedRecurrence = recurrenceRule
      ? (recurrenceRule.toUpperCase().startsWith('RRULE:') ? recurrenceRule : `RRULE:${recurrenceRule}`)
      : undefined;

    const startTime = new Date(startDatetime);
    const endTime = new Date(endDatetime);

    const event = await this.calendar.createEvent({
      title,
      startTime,
      endTime,
      description,
      location,
      recurrence: normalizedRecurrence ? [normalizedRecurrence] : undefined,
    });

    const timeStr = event.startTime.toLocaleString('ru-RU', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: process.env.TIMEZONE || 'Europe/Minsk',
    });

    return `Событие создано: *${event.title}*\n${timeStr}${recurrenceRule ? '\n(повторяющееся)' : ''}${location ? `\nМесто: ${location}` : ''}`;
  }

  private async getTodayPlan(): Promise<string> {
    const [tasks, events] = await Promise.all([
      this.todoist.getAllActiveTasks(),
      this.calendar.getTodayEvents(),
    ]);
    const projectNames = await this.todoist.getProjectNamesMapForTasks(tasks);

    const parts: string[] = [];
    parts.push(formatTaskList(tasks, 'Активные задачи', projectNames));
    parts.push(formatEventList(events));

    return parts.filter(Boolean).join('\n\n');
  }

  private async getTasks(args: Record<string, string | string[] | undefined>): Promise<string> {
    const filter = args.filter as string | undefined;

    if (filter === 'overdue') {
      const tasks = await this.todoist.getOverdueTasks();
      const projectNames = await this.todoist.getProjectNamesMapForTasks(tasks);
      return tasks.length ? formatTaskList(tasks, 'Просроченные задачи', projectNames) : 'Просроченных задач нет.';
    }

    const tasks = await this.todoist.getAllActiveTasks();
    const projectNames = await this.todoist.getProjectNamesMapForTasks(tasks);
    return tasks.length ? formatTaskList(tasks, 'Активные задачи', projectNames) : 'Нет активных задач.';
  }

  private async addBitrixComment(args: Record<string, string | string[] | undefined>): Promise<string> {
    const task = await this.findTask(args);
    if (!task) return 'Задача не найдена. Уточни название.';

    if (!this.todoist.hasBitrixLabel(task)) {
      return `Задача *${task.content}* не привязана к Bitrix24.`;
    }

    const bitrixIds = parseBitrixIds(task.description ?? '');
    if (bitrixIds.length === 0) {
      return `Не найдена ссылка на Bitrix24 в описании задачи *${task.content}*.`;
    }

    const comment = args.comment as string;
    await Promise.allSettled(bitrixIds.map((id) => this.bitrix.addComment(id, comment)));

    return `Комментарий добавлен в Bitrix24 по задаче *${task.content}* (${bitrixIds.length} связ.).`;
  }

  // Finance methods

  private requireFinance(): FinanceService {
    if (!this.finance) throw new Error('Финансовый модуль не подключён');
    return this.finance;
  }

  private async addTransaction(args: Record<string, unknown>): Promise<string> {
    const fin = this.requireFinance();
    const amount = Number(args.amount);
    const type = args.type as 'income' | 'expense';
    const category = args.category as string;
    const description = args.description as string | undefined;
    const date = args.date as string | undefined;
    const recurrence = (args.recurrence as string | undefined) ?? 'once';

    const tx = await fin.addTransaction({ amount, type, category, description, date, recurrence });

    const typeLabel = type === 'expense' ? '💸 Расход' : '💰 Доход';
    let result = `✅ Записано\n${typeLabel}: *${formatMoney(tx.amount)} ₽*\n📁 ${category}`;
    if (description) result += `\n📝 ${description}`;
    if (recurrence !== 'once') result += `\n🔁 ${formatRecurrence(recurrence)}`;

    // Check budget alert if expense
    if (type === 'expense') {
      try {
        const budgets = await fin.getBudgets();
        const budget = budgets.find(b => b.category === category || b.category.toLowerCase() === category.toLowerCase());
        if (budget && budget.limit > 0) {
          const pct = Math.round((budget.spent / budget.limit) * 100);
          if (pct >= 100) {
            result += `\n\n🔴 Перерасход по «${category}»: потрачено ${formatMoney(budget.spent)} из ${formatMoney(budget.limit)} ₽ (${pct}%)`;
          } else if (pct >= 80) {
            result += `\n\n⚠️ По «${category}» потрачено ${formatMoney(budget.spent)} из ${formatMoney(budget.limit)} ₽ (${pct}%)`;
          }
        }
      } catch {
        // budget check is best-effort
      }
    }

    return result;
  }

  private async getFinanceSummary(args: Record<string, unknown>): Promise<string> {
    const fin = this.requireFinance();
    const now = new Date();
    const year = Number(args.year ?? now.getFullYear());
    const month = Number(args.month ?? (now.getMonth() + 1));
    const summary = await fin.getSummary(year, month);
    return formatFinanceSummary(summary, year, month);
  }

  private async getFinanceTransactions(args: Record<string, unknown>): Promise<string> {
    const fin = this.requireFinance();
    const limit = Number(args.limit ?? 10);
    const now = new Date();
    const year = Number(args.year ?? now.getFullYear());
    const month = Number(args.month ?? (now.getMonth() + 1));
    const txs = await fin.getTransactionsWithRecurring(year, month, limit);
    if (txs.length === 0) return 'Транзакций за этот период нет.';

    const lines = txs.map((tx, i) => {
      const sign = tx.type === 'expense' ? '−' : '+';
      const dateStr = new Date(tx.date).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
      const desc = tx.description ? ` | ${tx.description}` : '';
      const rec = tx.recurrence && tx.recurrence !== 'once' ? ' 🔁' : '';
      return `${i + 1}. ${dateStr} | ${sign}${formatMoney(tx.amount)}₽ | ${tx.category}${desc}${rec}`;
    });

    return `🕐 Последние операции:\n\n${lines.join('\n')}`;
  }

  private async setFinanceBudget(args: Record<string, unknown>): Promise<string> {
    const fin = this.requireFinance();
    const category = args.category as string;
    const limit = Number(args.limit);
    await fin.upsertBudget({ category, limit });
    return `✅ Лимит для «${category}» установлен: *${formatMoney(limit)} ₽*`;
  }

  private async getFinanceBudgetStatus(args: Record<string, unknown>): Promise<string> {
    const fin = this.requireFinance();
    const now = new Date();
    const year = Number(args.year ?? now.getFullYear());
    const month = Number(args.month ?? (now.getMonth() + 1));
    const budgets = await fin.getBudgets(year, month);
    return formatBudgetStatus(budgets);
  }

  private async getFinanceForecast(args: Record<string, unknown>): Promise<string> {
    const fin = this.requireFinance();
    const period = (args.period as 'week' | 'month' | 'quarter' | 'year') ?? 'month';
    const forecast = await fin.computeForecast(period);
    return formatForecast(forecast, period);
  }

  private async evaluateUnplannedSpend(args: Record<string, unknown>): Promise<string> {
    const fin = this.requireFinance();
    const amount = Number(args.amount ?? 0);
    const category = (args.category as string | undefined)?.trim();
    const period = (args.period as 'week' | 'month' | 'quarter' | 'year' | undefined) ?? 'month';

    if (!Number.isFinite(amount) || amount <= 0) {
      return 'Укажи корректную сумму внеплановой траты больше 0.';
    }

    const now = new Date();
    const [summary, forecast, budgets] = await Promise.all([
      fin.getSummary(now.getFullYear(), now.getMonth() + 1),
      fin.computeForecast(period),
      fin.getBudgets(now.getFullYear(), now.getMonth() + 1),
    ]);

    const currentBalance = summary.balance;
    const nowAfterSpend = currentBalance - amount;
    const forecastAfterSpend = forecast.realisticForecast - amount;
    const minBalance = forecast.minBalance;

    const byBalanceNow = nowAfterSpend >= 0;
    const bySafetyThreshold = minBalance <= 0 || forecastAfterSpend >= minBalance;

    let budgetLine = 'Лимит категории не задан.';
    let byBudget = true;

    if (category) {
      const budget = budgets.find((b) => b.category.toLowerCase() === category.toLowerCase());
      if (budget && budget.limit > 0) {
        const newSpent = budget.spent + amount;
        const pct = Math.round((newSpent / budget.limit) * 100);
        byBudget = newSpent <= budget.limit;
        budgetLine = `Категория «${budget.category}»: ${formatMoney(newSpent)} из ${formatMoney(budget.limit)} ₽ (${pct}%).`;
      } else {
        budgetLine = `Для категории «${category}» лимит не задан.`;
      }
    }

    const canSpend = byBalanceNow && bySafetyThreshold && byBudget;
    const verdict = canSpend ? '✅ Можно' : '⛔ Лучше не тратить';

    const reasons: string[] = [];
    if (!byBalanceNow) reasons.push('после траты баланс уйдет в минус');
    if (!bySafetyThreshold) reasons.push('прогноз опустится ниже минимального порога');
    if (!byBudget) reasons.push('будет превышен бюджет категории');

    let result = `*Оценка внеплановой траты*\n`;
    result += `Сумма: *${formatMoney(amount)} ₽*${category ? `\nКатегория: *${category}*` : ''}\n`;
    result += `Горизонт оценки: *${period}*\n\n`;
    result += `${verdict}\n`;
    if (reasons.length > 0) {
      result += `Причины: ${reasons.join('; ')}.\n`;
    }
    result += `\nТекущий баланс: *${formatMoney(currentBalance)} ₽*`;
    result += `\nПосле траты сейчас: *${formatMoney(nowAfterSpend)} ₽*`;
    result += `\nРеалистичный прогноз (${period}) после траты: *${formatMoney(forecastAfterSpend)} ₽*`;
    if (minBalance > 0) {
      result += `\nМинимальный порог: *${formatMoney(minBalance)} ₽*`;
    }
    result += `\n${budgetLine}`;

    if (canSpend) {
      result += '\n\nСовет: если трата не срочная, проверь альтернативу дешевле и сохрани запас по порогу.';
    } else {
      result += '\n\nСовет: лучше отложить трату или уменьшить сумму, чтобы не пробить порог/бюджет.';
    }

    return result;
  }

  private async deleteFinanceTransaction(args: Record<string, unknown>): Promise<string> {
    const fin = this.requireFinance();
    const id = args.transaction_id as string;
    await fin.deleteTransaction(id);
    return `🗑 Транзакция удалена.`;
  }

  private async updateFinanceTransaction(args: Record<string, unknown>): Promise<string> {
    const fin = this.requireFinance();
    const id = args.transaction_id as string;
    const { transaction_id: _id, ...updates } = args;
    await fin.updateTransaction(id, updates as Parameters<typeof fin.updateTransaction>[1]);
    return `✏️ Транзакция обновлена.`;
  }

  private async getFinanceSettings(): Promise<string> {
    const fin = this.requireFinance();
    const [minBalance, initialBalance] = await Promise.all([
      fin.getMinBalance(),
      fin.getInitialBalance(),
    ]);
    return `⚙️ Финансовые настройки:\n• Начальный баланс: ${initialBalance != null ? formatMoney(initialBalance) + ' ₽' : '_не задан_'}\n• Минимальный порог: ${formatMoney(minBalance)} ₽`;
  }

  private async setFinanceSettings(args: Record<string, unknown>): Promise<string> {
    const fin = this.requireFinance();
    const key = args.key as string;
    const value = Number(args.value);

    if (key === 'min_balance') {
      await fin.setMinBalance(value);
      return `✅ Минимальный порог установлен: *${formatMoney(value)} ₽*`;
    }
    if (key === 'initial_balance') {
      await fin.setInitialBalance(value);
      return `✅ Начальный баланс установлен: *${formatMoney(value)} ₽*`;
    }
    if (key === 'current_balance') {
      await fin.setCurrentBalance(value);
      return `✅ Баланс на сегодня установлен: *${formatMoney(value)} ₽*`;
    }
    return `Неизвестная настройка: ${key}`;
  }
}

function formatRecurrence(r: string): string {
  switch (r) {
    case 'daily': return 'Ежедневная';
    case 'weekly': return 'Еженедельная';
    case 'monthly': return 'Ежемесячная';
    case 'quarterly': return 'Ежеквартальная';
    default: return 'Разовая';
  }
}
