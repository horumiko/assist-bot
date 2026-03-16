import { Task } from '@doist/todoist-api-typescript';
import { logger } from '../utils/logger';
import { getDb } from '../db/database';

const LABEL_BOT = 'bot';
const LABEL_BITRIX = 'bitrix';

export interface TaskStatusLog {
  todoistTaskId: string;
  bitrixTaskId: string | null;
  lastStatus: string | null;
  lastStatusUpdate: string;
}

interface TodoistProject {
  id: string;
  name: string;
}

interface TodoistSection {
  id: string;
  name: string;
  project_id: string;
}

const STATUS_SECTION_ALIASES: Record<string, string[]> = {
  'in progress': ['in progress', 'inprogress', 'в работе', 'doing', 'progress'],
  review: ['review', 'на ревью', 'ревью', 'на проверке', 'feedback'],
  paused: ['paused', 'on hold', 'hold', 'pause', 'пауза', 'блокер'],
  completed: ['done', 'completed', 'готово', 'выполнено'],
};

export interface TodoistComment {
  id: string;
  content: string;
  postedAt: string;
}

export class TodoistService {
  private token: string;
  private readonly baseUrl = 'https://api.todoist.com/api/v1';

  constructor() {
    const token = process.env.TODOIST_API_TOKEN;
    if (!token) throw new Error('TODOIST_API_TOKEN is not set');
    this.token = token;
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    options?: {
      query?: Record<string, string | number | null | undefined>;
      body?: unknown;
    },
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);

    if (options?.query) {
      for (const [key, value] of Object.entries(options.query)) {
        if (value !== undefined && value !== null) {
          url.searchParams.set(key, String(value));
        }
      }
    }

    const response = await fetch(url.toString(), {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: options?.body ? JSON.stringify(options.body) : undefined,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown Todoist API error');
      throw new Error(`Todoist API error: HTTP ${response.status} ${errorText}`);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    const text = await response.text();
    if (!text) {
      return undefined as T;
    }

    return JSON.parse(text) as T;
  }

  private async getPaginatedTasks(path: string, query?: Record<string, string | number | null | undefined>): Promise<Task[]> {
    const tasks: Task[] = [];
    let cursor: string | null = null;

    do {
      const page: { results?: Task[]; next_cursor?: string | null } = await this.request('GET', path, {
        query: {
          ...(query ?? {}),
          limit: 200,
          cursor,
        },
      });

      if (Array.isArray(page.results)) {
        tasks.push(...page.results);
      }

      cursor = page.next_cursor ?? null;
    } while (cursor);

    return tasks;
  }

  private async getAllProjects(): Promise<TodoistProject[]> {
    const projects: TodoistProject[] = [];
    let cursor: string | null = null;

    do {
      const page: { results?: TodoistProject[]; next_cursor?: string | null } = await this.request('GET', '/projects', {
        query: {
          limit: 200,
          cursor,
        },
      });

      if (Array.isArray(page.results)) {
        projects.push(...page.results);
      }

      cursor = page.next_cursor ?? null;
    } while (cursor);

    return projects;
  }

  private async getProjectNameById(projectId: string): Promise<string | null> {
    try {
      const project = await this.request<TodoistProject>('GET', `/projects/${projectId}`);
      return project.name;
    } catch (err) {
      logger.warn({ err, projectId }, 'Failed to resolve project name by id');
      return null;
    }
  }

  private ensureProjectPrefix(content: string, projectName: string | null | undefined): string {
    const trimmedContent = content.trim();
    if (!projectName) return trimmedContent;

    const prefix = `[${projectName.trim()}]`;
    if (trimmedContent === prefix || trimmedContent.startsWith(`${prefix} `)) {
      return trimmedContent;
    }

    if (/^\[[^\]]+\]\s*/.test(trimmedContent)) {
      return trimmedContent.replace(/^\[[^\]]+\]\s*/, `${prefix} `);
    }

    return `${prefix} ${trimmedContent}`;
  }

  async listProjects(): Promise<Array<{ id: string; name: string }>> {
    const projects = await this.getAllProjects();
    return projects
      .map(p => ({ id: p.id, name: p.name }))
      .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  }

  async listSections(projectId: string): Promise<Array<{ id: string; name: string; projectId: string }>> {
    const sections: TodoistSection[] = [];
    let cursor: string | null = null;

    do {
      const page: { results?: TodoistSection[]; next_cursor?: string | null } = await this.request('GET', '/sections', {
        query: {
          project_id: projectId,
          limit: 200,
          cursor,
        },
      });

      if (Array.isArray(page.results)) {
        sections.push(...page.results);
      }

      cursor = page.next_cursor ?? null;
    } while (cursor);

    return sections
      .map(s => ({ id: s.id, name: s.name, projectId: s.project_id }))
      .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  }

  getTaskProjectId(task: Task): string {
    const withSnake = task as unknown as { project_id?: string };
    const withCamel = task as unknown as { projectId?: string };
    return withSnake.project_id ?? withCamel.projectId ?? 'unknown';
  }

  getTaskParentId(task: Task): string | null {
    const withSnake = task as unknown as { parent_id?: string | null };
    const withCamel = task as unknown as { parentId?: string | null };
    return withSnake.parent_id ?? withCamel.parentId ?? null;
  }

  getTaskSectionId(task: Task): string | null {
    const withSnake = task as unknown as { section_id?: string | null };
    const withCamel = task as unknown as { sectionId?: string | null };
    return withSnake.section_id ?? withCamel.sectionId ?? null;
  }

  private normalizeSectionName(value: string): string {
    return value
      .toLowerCase()
      .replace(/[\s_\-]+/g, ' ')
      .trim();
  }

  private canonicalSectionName(value: string): string {
    return this.normalizeSectionName(value).replace(/\s+/g, '');
  }

  private async findSectionForStatus(task: Task, newStatus: string): Promise<string | null> {
    const projectId = this.getTaskProjectId(task);
    if (!projectId || projectId === 'unknown') return null;

    const sections = await this.listSections(projectId);
    if (sections.length === 0) return null;

    const normalizedStatus = this.normalizeSectionName(newStatus);
    const aliases = STATUS_SECTION_ALIASES[normalizedStatus] ?? [];
    const desiredNames = new Set([normalizedStatus, ...aliases.map((a) => this.normalizeSectionName(a))]);
    const desiredCanonical = new Set(Array.from(desiredNames).map((name) => this.canonicalSectionName(name)));

    const exactByStatus = sections.find((section) => {
      const normalizedSection = this.normalizeSectionName(section.name);
      const canonicalSection = this.canonicalSectionName(section.name);
      return desiredNames.has(normalizedSection) || desiredCanonical.has(canonicalSection);
    });
    if (exactByStatus) return exactByStatus.id;

    const fuzzy = sections.find((section) => {
      const normalizedSection = this.normalizeSectionName(section.name);
      const canonicalSection = this.canonicalSectionName(section.name);
      return Array.from(desiredNames).some((name) => {
        const canonicalName = this.canonicalSectionName(name);
        return normalizedSection.includes(name)
          || name.includes(normalizedSection)
          || canonicalSection.includes(canonicalName)
          || canonicalName.includes(canonicalSection);
      });
    });

    return fuzzy?.id ?? null;
  }

  async getProjectNamesMapForTasks(tasks: Task[]): Promise<Record<string, string>> {
    const projectIds = new Set(tasks.map(t => this.getTaskProjectId(t)).filter(Boolean));
    if (projectIds.size === 0) return {};

    try {
      const projects = await this.getAllProjects();
      const map: Record<string, string> = {};
      for (const p of projects) {
        if (projectIds.has(p.id)) {
          map[p.id] = p.name;
        }
      }
      return map;
    } catch (err) {
      logger.warn({ err }, 'Failed to fetch Todoist projects map');
      return {};
    }
  }

  async getSectionNamesMapForTasks(tasks: Task[]): Promise<Record<string, string>> {
    const projectIds = Array.from(new Set(
      tasks
        .map((task) => this.getTaskProjectId(task))
        .filter((id) => Boolean(id) && id !== 'unknown'),
    ));
    if (projectIds.length === 0) return {};

    const map: Record<string, string> = {};
    const sectionGroups = await Promise.all(
      projectIds.map(async (projectId) => {
        try {
          return await this.listSections(projectId);
        } catch (err) {
          logger.warn({ err, projectId }, 'Failed to fetch Todoist sections for project');
          return [];
        }
      }),
    );

    for (const sections of sectionGroups) {
      for (const section of sections) {
        map[section.id] = section.name;
      }
    }

    return map;
  }

  async getAllActiveTasks(): Promise<Task[]> {
    try {
      const tasks = await this.getPaginatedTasks('/tasks');
      return tasks;
    } catch (err) {
      logger.error({ err }, 'Failed to get active tasks');
      throw err;
    }
  }

  async getOverdueTasks(): Promise<Task[]> {
    try {
      const tasks = await this.getPaginatedTasks('/tasks/filter', { query: 'overdue' });
      return tasks;
    } catch (err) {
      logger.error({ err }, 'Failed to get overdue tasks');
      throw err;
    }
  }

  async getCompletedTasksSince(since: Date): Promise<Task[]> {
    try {
      const until = new Date();
      const tasks: Task[] = [];
      let cursor: string | null = null;

      do {
        const params = new URLSearchParams({
          since: since.toISOString(),
          until: until.toISOString(),
          limit: '200',
        });
        if (cursor) params.set('cursor', cursor);

        const response = await fetch(`https://api.todoist.com/api/v1/tasks/completed/by_completion_date?${params.toString()}`, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${this.token}`,
          },
        });

        if (!response.ok) {
          const errorText = await response.text().catch(() => 'Unknown Todoist API error');
          throw new Error(`Todoist completed tasks API error: HTTP ${response.status} ${errorText}`);
        }

        const data = (await response.json()) as {
          items?: Task[];
          next_cursor?: string | null;
        };

        if (Array.isArray(data.items)) {
          tasks.push(...data.items);
        }

        cursor = data.next_cursor ?? null;
      } while (cursor);

      return tasks;
    } catch (err) {
      logger.error({ err }, 'Failed to get completed tasks');
      return [];
    }
  }

  async createTask(
    content: string,
    dueString?: string,
    labels?: string[],
    projectId?: string,
    sectionId?: string,
    description?: string,
    projectNameHint?: string,
  ): Promise<Task> {
    try {
      const resolvedProjectName = projectNameHint
        ?? (projectId ? await this.getProjectNameById(projectId) : 'Входящие');
      const contentWithProject = this.ensureProjectPrefix(content, resolvedProjectName);
      const taskLabels = [LABEL_BOT, ...(labels ?? [])].filter((l, i, arr) => arr.indexOf(l) === i);
      const task = await this.request<Task>('POST', '/tasks', {
        body: {
          content: contentWithProject,
          due_string: dueString,
          labels: taskLabels,
          project_id: projectId,
          section_id: sectionId,
          description,
        },
      });
      await this.upsertStatusLog(task.id, null, 'created');
      logger.info({ taskId: task.id, content: contentWithProject }, 'Task created');
      return task;
    } catch (err) {
      logger.error({ err }, 'Failed to create task');
      throw err;
    }
  }

  async completeTask(taskId: string): Promise<void> {
    try {
      await this.request('POST', `/tasks/${taskId}/close`);
      await this.updateStatusLog(taskId, 'completed');
      logger.info({ taskId }, 'Task completed');
    } catch (err) {
      logger.error({ err, taskId }, 'Failed to complete task');
      throw err;
    }
  }

  async updateTaskDue(taskId: string, dueString: string): Promise<Task> {
    try {
      const task = await this.request<Task>('POST', `/tasks/${taskId}`, {
        body: { due_string: dueString },
      });
      await this.updateStatusLog(taskId, 'due_updated');
      logger.info({ taskId, dueString }, 'Task due updated');
      return task;
    } catch (err) {
      logger.error({ err, taskId }, 'Failed to update task due');
      throw err;
    }
  }

  async addTaskComment(taskId: string, content: string): Promise<void> {
    await this.request('POST', '/comments', {
      body: {
        task_id: taskId,
        content,
      },
    });
  }

  async listTaskComments(taskId: string, sinceIso?: string): Promise<TodoistComment[]> {
    const comments: TodoistComment[] = [];
    let cursor: string | null = null;

    do {
      const page: {
        results?: Array<{
          id: string;
          content?: string;
          posted_at?: string;
          postedAt?: string;
        }>;
        next_cursor?: string | null;
      } = await this.request('GET', '/comments', {
        query: {
          task_id: taskId,
          limit: 200,
          cursor,
        },
      });

      if (Array.isArray(page.results)) {
        for (const c of page.results) {
          const postedAt = c.posted_at ?? c.postedAt;
          if (!postedAt) continue;
          if (sinceIso && postedAt <= sinceIso) continue;
          comments.push({
            id: c.id,
            content: c.content ?? '',
            postedAt,
          });
        }
      }

      cursor = page.next_cursor ?? null;
    } while (cursor);

    comments.sort((a, b) => a.postedAt.localeCompare(b.postedAt));
    return comments;
  }

  async updateTaskLabel(taskId: string, newStatus: string): Promise<Task> {
    try {
      const task = await this.request<Task>('GET', `/tasks/${taskId}`);
      const hasBotLabel = task.labels.includes(LABEL_BOT);
      const hasBitrixLabel = task.labels.includes(LABEL_BITRIX);
      const currentSectionId = this.getTaskSectionId(task);
      // Bitrix-linked tasks must keep their Todoist board placement unchanged.
      const targetSectionId = hasBitrixLabel
        ? null
        : await this.findSectionForStatus(task, newStatus);

      const updatedLabels = [
        ...(hasBotLabel ? [LABEL_BOT] : []),
        ...(hasBitrixLabel ? [LABEL_BITRIX] : []),
        newStatus,
      ].filter((l, i, arr) => arr.indexOf(l) === i);

      if (targetSectionId && targetSectionId !== currentSectionId) {
        await this.request('POST', `/tasks/${taskId}/move`, {
          body: { section_id: targetSectionId },
        });
      }

      const updated = await this.request<Task>('POST', `/tasks/${taskId}`, {
        body: { labels: updatedLabels },
      });
      await this.updateStatusLog(taskId, newStatus);
      logger.info({ taskId, newStatus, movedToSection: targetSectionId ?? null }, 'Task status updated');
      return updated;
    } catch (err) {
      logger.error({ err, taskId }, 'Failed to update task label');
      throw err;
    }
  }

  async moveTaskToSection(taskId: string, sectionId: string): Promise<Task> {
    try {
      await this.request('POST', `/tasks/${taskId}/move`, {
        body: { section_id: sectionId },
      });
      const updated = await this.getTask(taskId);
      logger.info({ taskId, sectionId }, 'Task moved to section');
      return updated;
    } catch (err) {
      logger.error({ err, taskId, sectionId }, 'Failed to move task to section');
      throw err;
    }
  }

  async addBitrixLink(taskId: string, bitrixId: string): Promise<Task> {
    try {
      const task = await this.request<Task>('GET', `/tasks/${taskId}`);
      const currentLabels = task.labels;
      const labels = currentLabels.includes(LABEL_BITRIX)
        ? currentLabels
        : [...currentLabels, LABEL_BITRIX];

      const currentDesc = task.description || '';
      const linkEntry = `[bitrix:${bitrixId}]`;
      const hasSameLink = new RegExp(`\\[bitrix:${bitrixId}\\]`).test(currentDesc);
      const newDesc = hasSameLink
        ? currentDesc
        : currentDesc ? `${currentDesc}\n${linkEntry}` : linkEntry;

      const updated = await this.request<Task>('POST', `/tasks/${taskId}`, {
        body: {
          labels,
          description: newDesc,
        },
      });

      await this.upsertStatusLog(
        taskId,
        bitrixId,
        task.labels.find(l => l !== LABEL_BOT && l !== LABEL_BITRIX) ?? null
      );
      logger.info({ taskId, bitrixId }, 'Bitrix link added to task');
      return updated;
    } catch (err) {
      logger.error({ err, taskId }, 'Failed to add bitrix link');
      throw err;
    }
  }

  async getTask(taskId: string): Promise<Task> {
    return this.request<Task>('GET', `/tasks/${taskId}`);
  }

  async listSubtasks(parentTaskId: string): Promise<Task[]> {
    const tasks = await this.getAllActiveTasks();
    return tasks.filter(task => this.getTaskParentId(task) === parentTaskId);
  }

  async findTaskByName(name: string): Promise<Task | null> {
    const tasks = await this.getAllActiveTasks();
    const lower = name.toLowerCase();
    return tasks.find(t => t.content.toLowerCase().includes(lower)) ?? null;
  }

  hasBitrixLabel(task: Task): boolean {
    return task.labels.includes(LABEL_BITRIX);
  }

  hasBotLabel(task: Task): boolean {
    return task.labels.includes(LABEL_BOT);
  }

  // Status log methods (Supabase)
  async upsertStatusLog(todoistTaskId: string, bitrixTaskId: string | null, status: string | null): Promise<void> {
    const db = getDb();
    const { error } = await db.from('task_status_log').upsert(
      {
        todoist_task_id: todoistTaskId,
        bitrix_task_id: bitrixTaskId,
        last_status: status,
        last_status_update: new Date().toISOString(),
      },
      { onConflict: 'todoist_task_id' }
    );
    if (error) throw error;
  }

  async updateStatusLog(todoistTaskId: string, status: string): Promise<void> {
    const db = getDb();
    const { error } = await db.from('task_status_log').upsert(
      {
        todoist_task_id: todoistTaskId,
        last_status: status,
        last_status_update: new Date().toISOString(),
      },
      { onConflict: 'todoist_task_id' }
    );
    if (error) throw error;
  }

  async getStatusLog(todoistTaskId: string): Promise<TaskStatusLog | null> {
    const db = getDb();
    const { data: row, error } = await db
      .from('task_status_log')
      .select('todoist_task_id, bitrix_task_id, last_status, last_status_update')
      .eq('todoist_task_id', todoistTaskId)
      .maybeSingle();

    if (error || !row) return null;

    return {
      todoistTaskId: row.todoist_task_id,
      bitrixTaskId: row.bitrix_task_id,
      lastStatus: row.last_status,
      lastStatusUpdate: row.last_status_update,
    };
  }

  async getStaleTaskIds(thresholdHours: number): Promise<string[]> {
    const db = getDb();
    const thresholdIso = new Date(Date.now() - thresholdHours * 3600 * 1000).toISOString();
    const { data: rows, error } = await db
      .from('task_status_log')
      .select('todoist_task_id')
      .lt('last_status_update', thresholdIso)
      .neq('last_status', 'completed');

    if (error || !rows) return [];
    return rows.map(r => r.todoist_task_id);
  }
}
