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

-- fitness: body measurements (weight, waist)
create table if not exists body_measurements (
  id uuid primary key default gen_random_uuid(),
  date date not null unique,
  weight_kg numeric,
  waist_cm numeric,
  notes text,
  created_at timestamptz not null default now()
);

-- fitness: daily nutrition log (calories + macros)
create table if not exists nutrition_log (
  id uuid primary key default gen_random_uuid(),
  date date not null unique,
  calories int,
  protein_g numeric,
  fat_g numeric,
  carbs_g numeric,
  notes text,
  created_at timestamptz not null default now()
);

-- fitness: workout sessions
create table if not exists workout_sessions (
  id uuid primary key default gen_random_uuid(),
  date date not null,
  name text,
  notes text,
  created_at timestamptz not null default now()
);

-- fitness: exercise sets within a workout session
create table if not exists workout_sets (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references workout_sessions(id) on delete cascade,
  exercise text not null,
  set_number int not null default 1,
  reps int,
  weight_kg numeric,
  notes text,
  created_at timestamptz not null default now()
);

-- recurring_confirmations: tracks user decisions for each recurring payment occurrence
create table if not exists recurring_confirmations (
  id uuid primary key default gen_random_uuid(),
  recurring_tx_id text not null,
  date date not null,
  action text not null check (action in ('confirmed', 'skipped')),
  amount numeric,
  created_at timestamptz not null default now(),
  unique(recurring_tx_id, date)
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
