import { LLMClient, Message, ToolCall } from '../llm/client';
import { IntentExecutor } from '../llm/executor';
import { logger } from '../utils/logger';

const MAX_TOOL_ROUNDS = 5;

const EXPLICIT_CREATE_PATTERNS = [
  /созда(й|ть|йте)/i,
  /добав(ь|ить|ьте)/i,
  /постав(ь|ить|ьте)/i,
  /нов(ая|ую)\s+задач/i,
  /задача\s*:/i,
  /create\s+task/i,
];

const STATUS_LIKE_PATTERNS = [
  /по\s+задаче/i,
  /статус/i,
  /ожида(ем|ю|ется)?/i,
  /жду/i,
  /комментар(ий|ия|иев)?/i,
  /на\s+ревью/i,
  /фидбек/i,
];

const CREATE_CLARIFICATION_PATTERNS = [
  /^нов(ую|ая)?$/i,
  /^новую\s+задач[ауы]?$/i,
  /^созда(й|ть|йте)\s+нов(ую|ая)?$/i,
  /^создать\s+новую\s+задач[ауы]?$/i,
  /^new$/i,
  /^create\s+new$/i,
];

const CREATE_UPDATE_DISAMBIGUATION_PROMPT = 'Уточни, это обновление по существующей задаче или нужно создать новую?';

function isExplicitTaskCreationRequest(text: string): boolean {
  const hasCreateSignal = EXPLICIT_CREATE_PATTERNS.some((p) => p.test(text));
  const hasStatusSignal = STATUS_LIKE_PATTERNS.some((p) => p.test(text));
  return hasCreateSignal && !hasStatusSignal;
}

function isCreateClarificationAnswer(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return CREATE_CLARIFICATION_PATTERNS.some((p) => p.test(normalized));
}

function hasPendingCreateClarification(history: Message[]): boolean {
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (msg.role !== 'assistant') continue;
    if (!msg.content) return false;
    return msg.content.includes(CREATE_UPDATE_DISAMBIGUATION_PROMPT);
  }
  return false;
}

export interface TaskDraftIntent {
  type: 'task_draft';
  content: string;
  dueString?: string;
  labels?: string[];
}

export interface TextIntent {
  type: 'text';
  text: string;
}

export type RouterResult = TextIntent | TaskDraftIntent;

export class MessageRouter {
  private llm: LLMClient;
  private executor: IntentExecutor;
  private conversationHistory: Map<number, Message[]> = new Map();

  constructor(llm: LLMClient, executor: IntentExecutor) {
    this.llm = llm;
    this.executor = executor;
  }

  async processMessage(userId: number, userText: string): Promise<RouterResult> {
    const history = this.getHistory(userId);
    const allowCreateFlow =
      isExplicitTaskCreationRequest(userText) ||
      (isCreateClarificationAnswer(userText) && hasPendingCreateClarification(history));

    history.push({ role: 'user', content: userText });

    let round = 0;
    while (round < MAX_TOOL_ROUNDS) {
      round++;
      const response = await this.llm.chat(history);

      if (response.toolCalls.length === 0) {
        const reply = response.content ?? 'Не понял запрос, попробуй переформулировать.';
        history.push({ role: 'assistant', content: reply });
        this.trimHistory(userId);
        return { type: 'text', text: reply };
      }

      const createTaskCall = response.toolCalls.find(tc => tc.function.name === 'create_task');
      if (createTaskCall && allowCreateFlow) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(createTaskCall.function.arguments || '{}');
        } catch (err) {
          logger.warn({ err }, 'Failed to parse create_task arguments');
        }

        const content = typeof args.content === 'string' ? args.content.trim() : '';
        if (content) {
          this.trimHistory(userId);
          return {
            type: 'task_draft',
            content,
            dueString: typeof args.due_string === 'string' ? args.due_string : undefined,
            labels: Array.isArray(args.labels)
              ? args.labels.filter((l): l is string => typeof l === 'string')
              : undefined,
          };
        }
      }

      const executableToolCalls = allowCreateFlow
        ? response.toolCalls
        : response.toolCalls.filter(tc => tc.function.name !== 'create_task');

      if (executableToolCalls.length === 0) {
        const fallback = response.content ?? CREATE_UPDATE_DISAMBIGUATION_PROMPT;
        history.push({ role: 'assistant', content: fallback });
        this.trimHistory(userId);
        return { type: 'text', text: fallback };
      }

      // Add assistant message with tool calls
      history.push({
        role: 'assistant',
        content: response.content,
        tool_calls: executableToolCalls,
      });

      // Execute all tool calls
      const toolResults = await Promise.all(
        executableToolCalls.map(async (tc: ToolCall) => {
          const result = await this.executor.execute(tc);
          return { toolCallId: tc.id, name: tc.function.name, result };
        })
      );

      // Add tool results to history
      for (const { toolCallId, name, result } of toolResults) {
        history.push({
          role: 'tool',
          content: result,
          tool_call_id: toolCallId,
          name,
        });
      }
    }

    // Fallback: generate final response
    const finalResponse = await this.llm.chat(history, false);
    const reply = finalResponse.content ?? 'Готово.';
    history.push({ role: 'assistant', content: reply });
    this.trimHistory(userId);
    return { type: 'text', text: reply };
  }

  private getHistory(userId: number): Message[] {
    if (!this.conversationHistory.has(userId)) {
      this.conversationHistory.set(userId, []);
    }
    return this.conversationHistory.get(userId)!;
  }

  private trimHistory(userId: number): void {
    const history = this.conversationHistory.get(userId);
    if (history && history.length > 20) {
      this.conversationHistory.set(userId, history.slice(-20));
    }
  }

  clearHistory(userId: number): void {
    this.conversationHistory.delete(userId);
  }
}
