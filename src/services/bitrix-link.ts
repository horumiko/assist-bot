/**
 * Parses Bitrix24 task IDs from Todoist task descriptions.
 * Supports two formats:
 *   [bitrix:12345]
 *   https://company.bitrix24.ru/workgroups/group/1/tasks/task/view/12345/
 */

const SHORT_FORMAT_RE = /\[bitrix:(\d+)\]/ig;
const URL_FORMAT_RE = /bitrix24\.[a-z.]+\/.*?\/tasks\/task\/view\/(\d+)\//ig;

export function parseBitrixIds(description: string): string[] {
  const ids = new Set<string>();

  for (const match of description.matchAll(SHORT_FORMAT_RE)) {
    if (match[1]) ids.add(match[1]);
  }

  for (const match of description.matchAll(URL_FORMAT_RE)) {
    if (match[1]) ids.add(match[1]);
  }

  return Array.from(ids);
}

export function parseBitrixId(description: string): string | null {
  const ids = parseBitrixIds(description);
  return ids[0] ?? null;
}

export function formatBitrixLink(bitrixId: string): string {
  return `[bitrix:${bitrixId}]`;
}
