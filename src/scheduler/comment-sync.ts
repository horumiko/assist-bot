import { TodoistService } from '../services/todoist';
import { BitrixService } from '../services/bitrix';
import { parseBitrixIds } from '../services/bitrix-link';
import { getConfig, setConfig, getTimezone } from '../config/settings';
import { logger } from '../utils/logger';

function toShortDate(iso: string, timeZone: string): string {
  return new Date(iso).toLocaleDateString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    timeZone,
  });
}

function formatSyncedComment(commentText: string, postedAt: string, timeZone: string): string {
  return `${toShortDate(postedAt, timeZone)}\n${commentText.trim()}`;
}

function taskSyncKey(taskId: string): string {
  return `todoist_comment_sync_last_${taskId}`;
}

export async function syncTodoistCommentsToBitrix(
  todoist: TodoistService,
  bitrix: BitrixService,
): Promise<void> {
  const timezone = getTimezone();
  const tasks = await todoist.getAllActiveTasks();
  const linkedTasks = tasks.filter((t) => todoist.hasBitrixLabel(t) && parseBitrixIds(t.description ?? '').length > 0);

  for (const task of linkedTasks) {
    const bitrixIds = parseBitrixIds(task.description ?? '');
    if (bitrixIds.length === 0) continue;

    const key = taskSyncKey(task.id);
    const lastSynced = await getConfig(key);

    let latestSeen = lastSynced ?? null;

    try {
      const comments = await todoist.listTaskComments(task.id, lastSynced ?? undefined);

      for (const comment of comments) {
        const text = comment.content.trim();
        if (!text) continue;

        const message = formatSyncedComment(text, comment.postedAt, timezone);
        await Promise.allSettled(bitrixIds.map((id) => bitrix.addComment(id, message)));
        latestSeen = comment.postedAt;
      }

      if (latestSeen && latestSeen !== lastSynced) {
        await setConfig(key, latestSeen);
      }
    } catch (err) {
      logger.warn({ err, taskId: task.id, bitrixIds }, 'Failed to sync Todoist comments to Bitrix for task');
    }
  }
}
