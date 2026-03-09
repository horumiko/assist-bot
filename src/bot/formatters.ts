import { Task } from '@doist/todoist-api-typescript';
import { CalendarEvent } from '../services/calendar';

function getTaskProjectId(task: Task): string {
  const withSnake = task as unknown as { project_id?: string };
  const withCamel = task as unknown as { projectId?: string };
  return withSnake.project_id ?? withCamel.projectId ?? 'unknown';
}

function getTaskParentId(task: Task): string | null {
  const withSnake = task as unknown as { parent_id?: string | null };
  const withCamel = task as unknown as { parentId?: string | null };
  return withSnake.parent_id ?? withCamel.parentId ?? null;
}

function renderTaskTree(
  task: Task,
  tasksByParentId: Map<string, Task[]>,
  level: number,
  lines: string[],
): void {
  const due = task.due ? ` — до ${formatDueDate(task.due.date)}` : '';
  const bitrix = task.labels.includes('bitrix') ? ' 🔗' : '';
  const prefix = level > 0 ? `${'  '.repeat(level - 1)}↳ ` : '';
  lines.push(`${prefix}${task.content}${due}${bitrix}`);

  const children = tasksByParentId.get(task.id) ?? [];
  for (const child of children) {
    renderTaskTree(child, tasksByParentId, level + 1, lines);
  }
}

export function formatTaskList(
  tasks: Task[],
  title = 'Активные задачи',
  projectNames: Record<string, string> = {},
): string {
  if (tasks.length === 0) return '';

  const lines = [`*${title}* (${tasks.length}):`];

  const grouped = new Map<string, Task[]>();
  for (const task of tasks) {
    const projectId = getTaskProjectId(task);
    const list = grouped.get(projectId) ?? [];
    list.push(task);
    grouped.set(projectId, list);
  }

  for (const [projectId, projectTasks] of grouped.entries()) {
    const projectName = projectNames[projectId] ?? `Проект ${projectId}`;
    lines.push(`\n📁 *${projectName}* (${projectTasks.length})`);

    const tasksByParentId = new Map<string, Task[]>();
    const rootTasks: Task[] = [];

    for (const task of projectTasks) {
      const parentId = getTaskParentId(task);
      if (!parentId) {
        rootTasks.push(task);
        continue;
      }

      const siblings = tasksByParentId.get(parentId) ?? [];
      siblings.push(task);
      tasksByParentId.set(parentId, siblings);
    }

    for (const rootTask of rootTasks) {
      renderTaskTree(rootTask, tasksByParentId, 0, lines);
      lines.push('');
    }

    if (rootTasks.length === 0 && projectTasks.length > 0) {
      // Fallback: if only subtasks are present in project slice, render them flat.
      for (const task of projectTasks) {
        renderTaskTree(task, tasksByParentId, 0, lines);
      }
    }
  }

  return lines.join('\n').trimEnd();
}

export function formatEventList(events: CalendarEvent[], title = 'Сегодня'): string {
  if (events.length === 0) return '';

  const lines = [`*${title}* (${events.length} событий):`];
  for (const event of events) {
    const timeStr = event.startTime.toLocaleTimeString('ru-RU', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: process.env.TIMEZONE || 'Europe/Minsk',
    });
    const link = event.meetLink ? ` [ссылка](${event.meetLink})` : '';
    lines.push(`• ${timeStr} — ${event.title}${link}`);
  }
  return lines.join('\n');
}

export function formatDueDate(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = date.getTime() - now.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return 'сегодня';
  if (diffDays === 1) return 'завтра';
  if (diffDays === -1) return 'вчера';
  if (diffDays < 0) return `просрочено (${Math.abs(diffDays)}д)`;

  return date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

export function formatStaleTaskMessage(task: Task, hoursSince: number): string {
  const days = Math.floor(hoursSince / 24);
  const hours = hoursSince % 24;
  const timeStr = days > 0 ? `${days}д ${hours}ч` : `${hours}ч`;
  return `• *${task.content}* (без обновления ${timeStr})`;
}
