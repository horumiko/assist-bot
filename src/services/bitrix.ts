import axios from 'axios';
import { logger } from '../utils/logger';

export interface BitrixStage {
  id: string;
  title: string;
  color?: string;
}

export interface BitrixTask {
  id: string;
  title: string;
  status: string;
  deadline?: string;
  description?: string;
}

export class BitrixService {
  private webhookUrl: string;

  constructor() {
    const url = process.env.BITRIX_WEBHOOK_URL;
    if (!url) throw new Error('BITRIX_WEBHOOK_URL is not set');
    this.webhookUrl = url.replace(/\/$/, '');
  }

  private async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const url = `${this.webhookUrl}/${method}.json`;
    try {
      const response = await axios.post<{ result: T; error?: string }>(url, params);
      if (response.data.error) {
        throw new Error(`Bitrix24 API error: ${response.data.error}`);
      }
      return response.data.result;
    } catch (err) {
      logger.error({ err, method, params }, 'Bitrix24 API call failed');
      throw err;
    }
  }

  async getTask(taskId: string): Promise<BitrixTask> {
    const result = await this.call<{ task: Record<string, string> }>('tasks.task.get', { taskId });
    const t = result.task;
    return {
      id: t.id,
      title: t.title,
      status: t.status,
      deadline: t.deadline,
      description: t.description,
    };
  }

  async moveTaskToStage(taskId: string, stageId: string): Promise<void> {
    await this.call('task.stages.movetask', { id: taskId, stageId });
    logger.info({ taskId, stageId }, 'Bitrix24 task moved to stage');
  }

  async updateTaskStatus(taskId: string, status: string): Promise<void> {
    await this.call('tasks.task.update', { taskId, fields: { STATUS: status } });
    logger.info({ taskId, status }, 'Bitrix24 task status updated');
  }

  async updateTaskDeadline(taskId: string, deadline: string): Promise<void> {
    await this.call('tasks.task.update', { taskId, fields: { DEADLINE: deadline } });
    logger.info({ taskId, deadline }, 'Bitrix24 task deadline updated');
  }

  async addComment(taskId: string, text: string): Promise<void> {
    await this.call('task.commentitem.add', { TASKID: taskId, FIELDS: { POST_MESSAGE: text } });
    logger.info({ taskId }, 'Bitrix24 comment added');
  }

  async getKanbanStages(groupId?: string): Promise<BitrixStage[]> {
    const params: Record<string, unknown> = {};
    if (groupId) params.GROUP_ID = groupId;
    const result = await this.call<Record<string, { ID: string; TITLE: string; COLOR: string }>>('task.stages.get', params);
    return Object.values(result).map(s => ({
      id: s.ID,
      title: s.TITLE,
      color: s.COLOR,
    }));
  }
}
