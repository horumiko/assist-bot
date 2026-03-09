/**
 * Supabase migrations — run SQL manually in the Supabase SQL editor
 * or via this script using the service key.
 *
 * Tables:
 *   task_status_log  — tracks when each Todoist task status was last updated
 *   config           — key/value bot settings
 *   status_mapping   — Todoist label <-> Bitrix24 stage mapping
 *   calendar_reminders — tracks which reminders have been sent
 */

import 'dotenv/config';
import { getDb } from './database';
import { logger } from '../utils/logger';

const SQL = `
-- finance_transactions
create table if not exists finance_transactions (
  id uuid primary key default gen_random_uuid(),
  amount numeric not null,
  type text not null check (type in ('income', 'expense')),
  category text not null,
  description text,
  date date not null default current_date,
  recurrence text not null default 'once',
  recurrence_end date,
  created_at timestamptz not null default now()
);

-- finance_budgets
create table if not exists finance_budgets (
  id bigserial primary key,
  category text not null,
  limit_amount numeric not null,
  year int not null,
  month int not null,
  unique(category, year, month)
);

-- finance_settings
create table if not exists finance_settings (
  key text primary key,
  value text not null
);

-- task_status_log
create table if not exists task_status_log (
  id bigserial primary key,
  todoist_task_id text not null unique,
  bitrix_task_id text,
  last_status text,
  last_status_update timestamptz not null default now(),
  created_at timestamptz not null default now()
);

-- config
create table if not exists config (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

-- status_mapping
create table if not exists status_mapping (
  id bigserial primary key,
  todoist_label text not null,
  bitrix_stage_id text not null,
  bitrix_stage_name text,
  created_at timestamptz not null default now()
);

-- calendar_reminders
create table if not exists calendar_reminders (
  id bigserial primary key,
  event_id text not null unique,
  event_title text not null,
  start_time timestamptz not null,
  reminder_sent boolean not null default false,
  created_at timestamptz not null default now()
);
`;

export async function runMigrations(): Promise<void> {
  const db = getDb();

  // Note: exec_sql RPC is optional. If it is not present, migrations should be run manually in SQL Editor.
  try {
    const { error } = await (db as any).rpc('exec_sql', { sql: SQL });
    if (error) {
      logger.warn({ error }, 'exec_sql RPC returned an error; use Supabase SQL Editor to run migrations manually');
    }
  } catch (err) {
    logger.info('exec_sql RPC is unavailable; run SQL in src/db/migrate.ts manually in Supabase SQL Editor');
    logger.debug({ err }, 'exec_sql RPC call failed');
  }
}

if (require.main === module) {
  runMigrations()
    .then(() => {
      logger.info('Migration script done. Please run the SQL in your Supabase dashboard if tables are missing.');
      process.exit(0);
    })
    .catch(err => {
      logger.error({ err }, 'Migration failed');
      process.exit(1);
    });
}
