import { TodoistService } from '../services/todoist';
import { BitrixService } from '../services/bitrix';
import { LLMClient } from '../llm/client';
import { parseBitrixIds } from '../services/bitrix-link';
import { logger } from '../utils/logger';

async function summarizeComments(llm: LLMClient, taskName: string, comments: string[]): Promise<string> {
  const commentBlock = comments.join('\n---\n');
  return llm.summarizeText(
    `Составь краткое резюме рабочих обновлений по задаче "${taskName}" на основе комментариев за прошедшую неделю. ` +
    `Пиши по-русски, кратко, по делу — что было сделано, какой статус, какие проблемы если есть.\n\n${commentBlock}`,
  );
}

export async function sendWeeklyBitrixSummary(
  todoist: TodoistService,
  bitrix: BitrixService,
  llm: LLMClient,
): Promise<void> {
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const tasks = await todoist.getAllActiveTasks();
  const linkedTasks = tasks.filter(
    (t) => todoist.hasBitrixLabel(t) && parseBitrixIds(t.description ?? '').length > 0,
  );

  for (const task of linkedTasks) {
    const bitrixIds = parseBitrixIds(task.description ?? '');
    if (bitrixIds.length === 0) continue;

    try {
      const comments = await todoist.listTaskComments(task.id, weekAgo);
      if (comments.length === 0) continue;

      const commentTexts = comments.map((c) => c.content.trim()).filter(Boolean);
      if (commentTexts.length === 0) continue;

      const summary = await summarizeComments(llm, task.content, commentTexts);
      const message = `📋 Недельное резюме\n${summary}`;

      await Promise.allSettled(bitrixIds.map((id) => bitrix.addComment(id, message)));
      logger.info({ taskId: task.id, bitrixIds, commentCount: comments.length }, 'Weekly Bitrix summary sent');
    } catch (err) {
      logger.warn({ err, taskId: task.id }, 'Failed to send weekly Bitrix summary for task');
    }
  }
}
