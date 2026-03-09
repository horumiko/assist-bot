import { getDb } from '../db/database';

export interface StatusMapping {
  todoistLabel: string;
  bitrixStageId: string;
  bitrixStageName?: string;
}

export async function getConfig(key: string): Promise<string | null> {
  const db = getDb();
  const { data, error } = await db
    .from('config')
    .select('value')
    .eq('key', key)
    .single();
  if (error) return null;
  return data?.value ?? null;
}

export async function setConfig(key: string, value: string): Promise<void> {
  const db = getDb();
  const { error } = await db
    .from('config')
    .upsert({ key, value, updated_at: new Date().toISOString() });
  if (error) throw error;
}

export async function getStatusMappings(): Promise<StatusMapping[]> {
  const db = getDb();
  const { data, error } = await db
    .from('status_mapping')
    .select('todoist_label, bitrix_stage_id, bitrix_stage_name');
  if (error || !data) return [];
  return data.map((r: { todoist_label: string; bitrix_stage_id: string; bitrix_stage_name: string | null }) => ({
    todoistLabel: r.todoist_label,
    bitrixStageId: r.bitrix_stage_id,
    bitrixStageName: r.bitrix_stage_name ?? undefined,
  }));
}

export async function addStatusMapping(mapping: StatusMapping): Promise<void> {
  const db = getDb();
  const { error } = await db.from('status_mapping').insert({
    todoist_label: mapping.todoistLabel,
    bitrix_stage_id: mapping.bitrixStageId,
    bitrix_stage_name: mapping.bitrixStageName ?? null,
  });
  if (error) throw error;
}

export async function clearStatusMappings(): Promise<void> {
  const db = getDb();
  const { error } = await db.from('status_mapping').delete().not('id', 'is', null);
  if (error) throw error;
}

export async function getBriefingTime(): Promise<string> {
  return (await getConfig('briefing_time')) ?? '08:35';
}

export function getTimezone(): string {
  return process.env.TIMEZONE ?? 'Europe/Minsk';
}

export async function getStatusThresholdHours(): Promise<number> {
  const val = await getConfig('status_threshold_hours');
  return val ? parseInt(val, 10) : 48;
}
