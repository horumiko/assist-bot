import axios from 'axios';
import { logger } from '../utils/logger';
import { tools, financeTools, LLMTool } from './tools';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

function normalizeFinanceDate(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const value = raw.trim().replace(/[\u00A0\u202F]/g, ' ').replace(/[,;.!?]+$/g, '');

  // Already ISO format.
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;

  // DD.MM.YYYY / DD-MM-YYYY / DD/MM/YYYY -> YYYY-MM-DD
  const full = value.match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})$/);
  if (full) return `${full[3]}-${full[2]}-${full[1]}`;

  // DD.MM.YY -> assume 20YY
  const shortYear = value.match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{2})$/);
  if (shortYear) {
    const y = Number(shortYear[3]);
    const yyyy = y >= 70 ? 1900 + y : 2000 + y;
    return `${yyyy}-${String(Number(shortYear[2])).padStart(2, '0')}-${String(Number(shortYear[1])).padStart(2, '0')}`;
  }

  // DD.MM -> current year
  const short = value.match(/^(\d{1,2})[.\/-](\d{1,2})$/);
  if (short) {
    const y = new Date().getFullYear();
    return `${y}-${String(Number(short[2])).padStart(2, '0')}-${String(Number(short[1])).padStart(2, '0')}`;
  }

  return undefined;
}

function extractDateByMarker(text: string, markerRegex: RegExp): string | undefined {
  const m = text.match(markerRegex);
  if (!m?.[1]) return undefined;
  return normalizeFinanceDate(m[1]);
}

function extractDateAfterWord(text: string, markerWord: string): string | undefined {
  const escaped = markerWord.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rx = new RegExp(`(?:^|\\s)${escaped}\\s*(\\d{1,2}[.\\/-]\\d{1,2}(?:[.\\/-]\\d{2,4})?)`, 'i');
  const m = text.match(rx);
  if (!m?.[1]) return undefined;
  return normalizeFinanceDate(m[1]);
}

function extractAllDates(text: string): string[] {
  const rx = /(\d{1,2}[.\/-]\d{1,2}(?:[.\/-]\d{2,4})?)/g;
  const out: string[] = [];
  for (const m of text.matchAll(rx)) {
    const normalized = normalizeFinanceDate(m[1]);
    if (normalized) out.push(normalized);
  }
  return out;
}

function parseAmountLoose(text: string): number | null {
  const m = text.toLowerCase().replace(/\s+/g, '').match(/(\d+(?:[\.,]\d+)?)(к|k)?/);
  if (!m) return null;
  const num = Number(m[1].replace(',', '.'));
  if (!Number.isFinite(num)) return null;
  return m[2] ? num * 1000 : num;
}

function parseFinanceFallback(text: string): Array<{
  amount: number;
  type: 'income' | 'expense';
  category: string;
  description?: string;
  date?: string;
  recurrence?: string;
  recurrence_end?: string;
}> {
  const t = text.trim();
  const lower = t.toLowerCase();
  const amount = parseAmountLoose(lower);
  if (!amount || amount <= 0) return [];

  const isIncome = /(зп|зарплат|преми|доход|пришл|получил|вернул\s+мне|возврат)/i.test(lower);
  const type: 'income' | 'expense' = isIncome ? 'income' : 'expense';

  let category = type === 'income' ? 'Иное' : 'Другое';
  if (type === 'income') {
    if (/(зп|зарплат)/i.test(lower)) category = 'Зарплата';
    else if (/(преми|бонус)/i.test(lower)) category = 'Премия';
    else if (/(ип|самозан|фриланс)/i.test(lower)) category = 'ИП';
    else if (/(вернул|возврат\s+долг|долг\s+вернул)/i.test(lower)) category = 'Долг (возврат)';
  } else {
    if (/(продукт|магазин|пят[её]рочк|перекр[её]сток|еда)/i.test(lower)) category = 'Еда';
    else if (/(кофе|кафе|ресторан|бар)/i.test(lower)) category = 'Кафе и кофе';
    else if (/(такси|метро|бензин|транспорт|яндекс\.go|каршер)/i.test(lower)) category = 'Транспорт';
    else if (/(аренд|квартир|жкх|коммун|электр|вода|газ)/i.test(lower)) category = 'Квартира + коммуналка';
    else if (/(интернет|связь|телефон|мобильн)/i.test(lower)) category = 'Связь';
    else if (/(спортзал|фитнес|gym|трениров)/i.test(lower)) category = 'GYM';
    else if (/(кредитк|кредит|ипотек|рассроч)/i.test(lower)) category = 'Кредиты';
    else if (/(долг|одолж|вернул\s+саше|вернул\s+кому)/i.test(lower)) category = 'Долг';
  }

  const date =
    extractDateByMarker(lower, /(?:^|\s)с\s(\d{2}\.\d{2}(?:\.\d{4})?)/i)
    ?? extractDateByMarker(lower, /(?:^|\s)на\s(\d{2}\.\d{2}(?:\.\d{4})?)/i);
  let recurrence_end =
    extractDateByMarker(lower, /(?:^|\s)до\s(\d{2}\.\d{2}(?:\.\d{4})?)/i)
    ?? extractDateAfterWord(lower, 'до');
  if (!recurrence_end) {
    const allDates = extractAllDates(lower);
    if (allDates.length >= 2) recurrence_end = allDates[1];
  }
  let recurrence: 'once' | 'daily' | 'weekly' | 'monthly' | 'quarterly' = 'once';
  if (/(ежеднев|каждый\s+день)/i.test(lower)) recurrence = 'daily';
  else if (/(еженед|каждую?\s+недел|каждый\s+(пн|вт|ср|чт|пт|сб|вс))/i.test(lower)) recurrence = 'weekly';
  else if (/(ежемес|каждый\s+месяц|раз\s+в\s+месяц)/i.test(lower)) recurrence = 'monthly';
  else if (/(ежекварт|раз\s+в\s+квартал)/i.test(lower)) recurrence = 'quarterly';
  if (recurrence_end && recurrence === 'once') recurrence = 'monthly';

  return [{
    amount,
    type,
    category,
    description: t,
    date,
    recurrence,
    recurrence_end,
  }];
}

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface LLMResponse {
  content: string | null;
  toolCalls: ToolCall[];
}

const SYSTEM_PROMPT = `Ты персональный ассистент пользователя в Telegram. Помогаешь управлять задачами в Todoist, событиями в Google Calendar, синхронизируешь с Bitrix24, а также ведёшь личные финансы.

Правила (задачи):
- Отвечай на русском языке
- Будь лаконичен и по делу
- При создании задач всегда добавляется метка "bot" автоматически
- Задачи с меткой "bitrix" синхронизируются с Bitrix24 автоматически
- При упоминании "жду фидбек", "на ревью", "готово" и подобных статусов — обновляй метки задачи
- Если сообщение похоже на апдейт по существующей задаче — НЕ создавай новую задачу, а обновляй статус/комментарий существующей
- Для встреч с рекуррентностью ("каждый вторник", "еженедельно") создавай recurring события

Правила (финансы):
- Распознавай финансовые сообщения и вызывай нужный tool
- Для вопросов вида "могу ли потратить X" сначала вызывай evaluate_unplanned_spend и отвечай на его основе
- Все суммы в рублях (₽), числительные "к" = 1000 (60к = 60000)
- Если пользователь пишет "баланс на сегодня ..." или "текущий баланс ..." — используй set_finance_settings с key: "current_balance"
- Если пользователь пишет "начальный баланс ..." — используй set_finance_settings с key: "initial_balance"
- Категории расходов: Еда, Кафе и кофе, Транспорт, Квартира + коммуналка, Связь, GYM, Кредиты, Долг, Другое
- Категории доходов: Зарплата, Премия, ИП, Долг (возврат), Иное
- При словах "каждый месяц", "ежемесячно", "ежегодно" и т.п. — используй recurrence: monthly/weekly/daily/quarterly
- По умолчанию recurrence = once

Примеры финансовых сообщений:
- "потратил 500 на продукты" → add_transaction (expense, Еда)
- "зп пришла 60к" → add_transaction (income, Зарплата, 60000)
- "кофе 350" → add_transaction (expense, Кафе и кофе)
- "аренда 35000 каждый месяц" → add_transaction (expense, Квартира + коммуналка, recurrence: monthly)
- "сколько потратил в этом месяце?" → get_finance_summary
- "покажи расходы" → get_transactions
- "поставь лимит 15к на еду" → set_budget
- "сколько у меня будет через месяц?" → get_forecast (month)
- "могу ли внепланово потратить 7000 на кафе?" → evaluate_unplanned_spend (amount=7000, category="Кафе и кофе")
- "вернул Саше 5000" → add_transaction (expense, Долг)
- "Саша вернул 5000" → add_transaction (income, Долг (возврат))

Сегодня: ${new Date().toLocaleDateString('ru-RU', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: process.env.TIMEZONE || 'Europe/Minsk' })}
Часовой пояс: ${process.env.TIMEZONE || 'Europe/Minsk'}
`;

export class LLMClient {
  private apiKey: string;
  private model: string;
  private analysisModel: string;

  constructor() {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) throw new Error('OPENROUTER_API_KEY is not set');
    this.apiKey = apiKey;
    // Budget-friendly default model for day-to-day routing.
    this.model = process.env.LLM_MODEL || 'inception/mercury-2';
    // Optional stronger model only for long-form analysis/reporting.
    this.analysisModel = process.env.LLM_ANALYSIS_MODEL || this.model;
  }

  private async requestChat(messages: Message[], options?: {
    useTools?: boolean;
    model?: string;
    temperature?: number;
    maxTokens?: number;
  }): Promise<LLMResponse> {
    const useTools = options?.useTools ?? true;
    const model = options?.model ?? this.model;
    const systemMessage: Message = { role: 'system', content: SYSTEM_PROMPT };
    const allMessages = [systemMessage, ...messages];

    try {
      const response = await axios.post(
        OPENROUTER_URL,
        {
          model,
          messages: allMessages,
          tools: useTools ? tools : undefined,
          tool_choice: useTools ? 'auto' : undefined,
          temperature: options?.temperature ?? 0.7,
          max_tokens: options?.maxTokens ?? 1024,
        },
        {
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://github.com/telegram-assistant',
            'X-Title': 'Telegram Personal Assistant',
          },
          timeout: 30000,
        }
      );

      const choice = response.data.choices?.[0];
      if (!choice) throw new Error('No choices in LLM response');

      const msg = choice.message;
      return {
        content: msg.content ?? null,
        toolCalls: msg.tool_calls ?? [],
      };
    } catch (err) {
      logger.error({ err }, 'LLM API call failed');
      throw err;
    }
  }

  async chat(messages: Message[], useTools = true): Promise<LLMResponse> {
    return this.requestChat(messages, {
      useTools,
      model: this.model,
      maxTokens: 1024,
    });
  }

  async generateBriefingSummary(context: string): Promise<string> {
    const response = await this.requestChat([
      { role: 'user', content: `Составь краткую вводную для утреннего брифинга на основе данных:\n\n${context}` },
    ], {
      useTools: false,
      model: this.analysisModel,
      maxTokens: 500,
      temperature: 0.4,
    });
    return response.content ?? '';
  }

  async generateFridayReport(
    context: string,
    periodLabel = 'неделя',
    scope: 'tasks' | 'finance' | 'combined' = 'combined',
  ): Promise<string> {
    const promptByScope: Record<'tasks' | 'finance' | 'combined', string> = {
      combined:
        `Ты персональный коуч по продуктивности и личным финансам. ` +
        `Сделай разбор периода (${periodLabel}) на основе данных ниже.\n\n` +
        `Требования к ответу:\n` +
        `1) Короткий итог недели (2-3 предложения).\n` +
        `2) 3 узких места по задачам (конкретно, без воды).\n` +
        `3) 3 узких места по финансам (где утечки/риски).\n` +
        `4) План на следующий сопоставимый период: ровно 5 действий, каждое в формате "действие -> ожидаемый эффект".\n` +
        `5) Тон поддерживающий, но честный.\n` +
        `6) Пиши только по данным, не выдумывай.\n\n` +
        `Данные:\n${context}`,
      tasks:
        `Ты коуч по продуктивности. ` +
        `Сделай разбор периода (${periodLabel}) только по задачам на основе данных ниже.\n\n` +
        `Требования к ответу:\n` +
        `1) Короткий итог периода (2-3 предложения).\n` +
        `2) 3 узких места по задачам (конкретно, без воды).\n` +
        `3) План на следующий сопоставимый период: ровно 5 действий, каждое в формате "действие -> ожидаемый эффект".\n` +
        `4) Не пиши про финансы вообще.\n` +
        `5) Тон поддерживающий, но честный.\n` +
        `6) Пиши только по данным, не выдумывай.\n\n` +
        `Данные:\n${context}`,
      finance:
        `Ты финансовый коуч. ` +
        `Сделай разбор периода (${periodLabel}) только по финансам на основе данных ниже.\n\n` +
        `Требования к ответу:\n` +
        `1) Короткий итог периода (2-3 предложения).\n` +
        `2) 3 узких места по финансам (утечки/риски).\n` +
        `3) План на следующий сопоставимый период: ровно 5 действий, каждое в формате "действие -> ожидаемый эффект".\n` +
        `4) Не пиши про задачи вообще.\n` +
        `5) Тон поддерживающий, но честный.\n` +
        `6) Пиши только по данным, не выдумывай.\n\n` +
        `Данные:\n${context}`,
    };

    const response = await this.requestChat([
      {
        role: 'user',
        content: promptByScope[scope],
      },
    ], {
      useTools: false,
      model: this.analysisModel,
      maxTokens: 900,
      temperature: 0.35,
    });
    return response.content ?? '';
  }

  // Parse a free-text finance message into one or more structured transactions.
  async parseFinanceTransactions(text: string): Promise<Array<{
    amount: number;
    type: 'income' | 'expense';
    category: string;
    description?: string;
    date?: string;
    recurrence?: string;
    recurrence_end?: string;
  }>> {
    const today = new Date().toISOString().split('T')[0];
    const systemMsg: Message = {
      role: 'system',
      content: `Извлеки все финансовые операции из сообщения пользователя и верни ТОЛЬКО JSON-массив без пояснений.
Сегодня: ${today}.
Категории расходов: Еда, Кафе и кофе, Транспорт, Квартира + коммуналка, Связь, GYM, Кредиты, Долг, Другое.
Категории доходов: Зарплата, Премия, ИП, Долг (возврат), Иное.
"к" = 1000 (60к = 60000).
    Если в тексте есть "до ДД.ММ.ГГГГ" или "до ДД.ММ" — это recurrence_end.
    Если в тексте есть "с ДД.ММ.ГГГГ"/"с ДД.ММ" или "на ДД.ММ.ГГГГ"/"на ДД.ММ" — это дата операции (date).
Формат ответа (строго JSON-массив, никакого другого текста):
[{"amount":число,"type":"income"|"expense","category":"...","description":"..."|null,"date":"YYYY-MM-DD"|null,"recurrence":"once"|"daily"|"weekly"|"monthly"|"quarterly","recurrence_end":"YYYY-MM-DD"|null}]
Если операция одна — всё равно верни массив из одного элемента. recurrence по умолчанию "once".`,
    };

    const parseWithModel = async (model: string): Promise<Array<{
      amount: number;
      type: 'income' | 'expense';
      category: string;
      description?: string;
      date?: string;
      recurrence?: string;
      recurrence_end?: string;
    }>> => {
      const response = await axios.post(
        OPENROUTER_URL,
        {
          model,
          messages: [systemMsg, { role: 'user', content: text }],
          temperature: 0.1,
          max_tokens: 320,
        },
        {
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://github.com/telegram-assistant',
            'X-Title': 'Telegram Personal Assistant',
          },
          timeout: 20000,
        }
      );

      const content: string = response.data.choices?.[0]?.message?.content ?? '';
      const jsonMatch = content.match(/\[[\s\S]*\]/);
      if (!jsonMatch) return [];

      const arr = JSON.parse(jsonMatch[0]);
      if (!Array.isArray(arr)) return [];

      const parsed = arr
        .filter((a: any) => a.amount && a.type && a.category)
        .map((a: any) => ({
          amount: Number(a.amount),
          type: a.type as 'income' | 'expense',
          category: a.category as string,
          description: a.description || undefined,
          date: normalizeFinanceDate(a.date || undefined),
          recurrence: a.recurrence || undefined,
          recurrence_end: normalizeFinanceDate(a.recurrence_end || undefined),
        }));

      if (parsed.length === 0) return [];

      const fromTextDate =
        extractDateByMarker(text, /(?:^|\s)с\s(\d{2}\.\d{2}(?:\.\d{4})?)/i)
        ?? extractDateByMarker(text, /(?:^|\s)на\s(\d{2}\.\d{2}(?:\.\d{4})?)/i);
      const fromTextEnd =
        extractDateByMarker(text, /(?:^|\s)до\s(\d{2}\.\d{2}(?:\.\d{4})?)/i)
        ?? extractDateAfterWord(text, 'до');
      const hasMonthlyHint = /ежемес|каждый\s+месяц|раз\s+в\s+месяц/i.test(text);
      const hasCreditHint = /кредитк|кредит(?!\s*вернул)/i.test(text);
      const allDatesFromText = extractAllDates(text);

      for (const item of parsed) {
        const fromDescDate =
          extractDateByMarker(item.description ?? '', /(?:^|\s)с\s(\d{2}\.\d{2}(?:\.\d{4})?)/i)
          ?? extractDateByMarker(item.description ?? '', /(?:^|\s)на\s(\d{2}\.\d{2}(?:\.\d{4})?)/i);
        const fromDescEnd =
          extractDateByMarker(item.description ?? '', /(?:^|\s)до\s(\d{2}\.\d{2}(?:\.\d{4})?)/i)
          ?? extractDateAfterWord(item.description ?? '', 'до');
        if (!item.date && fromTextDate) item.date = fromTextDate;
        if (!item.date && fromDescDate) item.date = fromDescDate;
        if (!item.recurrence_end && fromTextEnd) item.recurrence_end = fromTextEnd;
        if (!item.recurrence_end && fromDescEnd) item.recurrence_end = fromDescEnd;
        if (!item.recurrence_end && allDatesFromText.length >= 2) item.recurrence_end = allDatesFromText[1];
        if ((!item.recurrence || item.recurrence === 'once') && (item.recurrence_end || fromTextEnd || hasMonthlyHint)) {
          item.recurrence = 'monthly';
        }
        if (hasCreditHint && item.type === 'expense' && item.category === 'Другое') {
          item.category = 'Кредиты';
        }
      }

      return parsed;
    };

    try {
      const primary = await parseWithModel(this.model);
      if (primary.length > 0) return primary;

      if (this.analysisModel !== this.model) {
        const secondary = await parseWithModel(this.analysisModel);
        if (secondary.length > 0) return secondary;
      }

      return parseFinanceFallback(text);
    } catch (err) {
      logger.warn({ err }, 'Failed to parse finance transactions');
      return parseFinanceFallback(text);
    }
  }

  /** @deprecated use parseFinanceTransactions */
  async parseFinanceTransaction(text: string) {
    const results = await this.parseFinanceTransactions(text);
    return results[0] ?? null;
  }
}
