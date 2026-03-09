import { BodyMeasurement, NutritionEntry, WorkoutSession, WorkoutSet, ParsedExercise } from '../services/fitness';

const SEP = '——————————————';

// ── Measurements ──────────────────────────────────────────────────────────

export function formatMeasurementEntry(m: BodyMeasurement): string {
  const parts: string[] = [];
  if (m.weight_kg !== null) parts.push(`⚖️ ${m.weight_kg} кг`);
  if (m.waist_cm !== null) parts.push(`📏 ${m.waist_cm} см`);
  return parts.join('  ');
}

export function formatMeasurementHistory(measurements: BodyMeasurement[]): string {
  if (measurements.length === 0) return '📏 *Замеры*\n\n_Записей нет_';

  const latest = measurements[0]!;
  const lines: string[] = ['📏 *Замеры*\n'];

  if (latest.weight_kg !== null) lines.push(`Вес сейчас: *${latest.weight_kg} кг*`);
  if (latest.waist_cm !== null) lines.push(`Живот сейчас: *${latest.waist_cm} см*`);

  // Trend vs 7 days ago
  const weekAgo = measurements.find((_, i) => i >= 5);
  if (weekAgo) {
    if (weekAgo.weight_kg !== null && latest.weight_kg !== null) {
      const diff = latest.weight_kg - weekAgo.weight_kg;
      const sign = diff > 0 ? '+' : '';
      lines.push(`_За последние записи: ${sign}${diff.toFixed(1)} кг_`);
    }
  }

  lines.push('');
  lines.push(SEP);
  lines.push('_История:_');

  for (const m of measurements.slice(0, 10)) {
    const dateStr = formatShortDate(m.date);
    const entry = formatMeasurementEntry(m);
    lines.push(`${dateStr}  ${entry}`);
  }

  if (measurements.length > 10) lines.push(`_... и ещё ${measurements.length - 10} записей_`);

  lines.push('');
  lines.push('_Запиши: "вес 82.5" или "вес 82 живот 89"_');

  return lines.join('\n');
}

// ── Nutrition ─────────────────────────────────────────────────────────────

export function formatNutritionEntry(n: NutritionEntry): string {
  const lines: string[] = [];
  if (n.calories !== null) lines.push(`🔥 ${n.calories} ккал`);

  const macros: string[] = [];
  if (n.protein_g !== null) macros.push(`Б ${n.protein_g}г`);
  if (n.fat_g !== null) macros.push(`Ж ${n.fat_g}г`);
  if (n.carbs_g !== null) macros.push(`У ${n.carbs_g}г`);
  if (macros.length > 0) lines.push(macros.join('  '));

  return lines.join('\n');
}

export function formatNutritionHistory(entries: NutritionEntry[]): string {
  if (entries.length === 0) return '🍎 *Питание*\n\n_Записей нет_';

  const lines: string[] = ['🍎 *Питание*\n'];

  const today = entries[0];
  if (today) {
    lines.push('_Сегодня:_');
    lines.push(formatNutritionEntry(today));
    lines.push('');
  }

  if (entries.length > 1) {
    // Average for last week
    const withCal = entries.filter((e) => e.calories !== null);
    if (withCal.length > 1) {
      const avgCal = Math.round(withCal.reduce((s, e) => s + (e.calories ?? 0), 0) / withCal.length);
      lines.push(`_Среднее за ${withCal.length} дней: ${avgCal} ккал_`);
      lines.push('');
    }

    lines.push(SEP);
    lines.push('_История:_');
    for (const e of entries.slice(0, 7)) {
      const dateStr = formatShortDate(e.date);
      const kcal = e.calories !== null ? `${e.calories} ккал` : '—';
      const macros = [
        e.protein_g !== null ? `Б${e.protein_g}` : null,
        e.fat_g !== null ? `Ж${e.fat_g}` : null,
        e.carbs_g !== null ? `У${e.carbs_g}` : null,
      ].filter(Boolean).join('/');
      lines.push(`${dateStr}  ${kcal}${macros ? `  ${macros}` : ''}`);
    }
  }

  lines.push('');
  lines.push('_Запиши: "2200 ккал б180 ж70 у200" или "2200/180/70/200"_');

  return lines.join('\n');
}

// ── Workout ───────────────────────────────────────────────────────────────

export function formatWorkoutSession(session: WorkoutSession, sets: WorkoutSet[]): string {
  const dateStr = formatShortDate(session.date);
  const name = session.name ? ` — ${session.name}` : '';
  const lines: string[] = [`🏋️ *${dateStr}${name}*\n`];

  const byExercise = new Map<string, WorkoutSet[]>();
  for (const s of sets) {
    if (!byExercise.has(s.exercise)) byExercise.set(s.exercise, []);
    byExercise.get(s.exercise)!.push(s);
  }

  for (const [exercise, exSets] of byExercise.entries()) {
    const setsStr = exSets.map((s) => {
      const weight = s.weight_kg !== null ? `${s.weight_kg}кг` : 'б/в';
      const reps = s.reps !== null ? `×${s.reps}` : '';
      return `${weight}${reps}`;
    }).join(', ');
    lines.push(`• ${exercise}: ${setsStr}`);
  }

  return lines.join('\n');
}

export function formatWorkoutHistory(sessions: Array<{ session: WorkoutSession; sets: WorkoutSet[] }>): string {
  if (sessions.length === 0) {
    return '🏋️ *Тренировки*\n\n_Записей нет_\n\n_Запиши: "жим лёжа 70кг 3×8, приседания 80кг 4×6"_';
  }

  const lines: string[] = ['🏋️ *Тренировки*\n'];

  for (const { session, sets } of sessions.slice(0, 5)) {
    lines.push(formatWorkoutSession(session, sets));
    lines.push('');
  }

  if (sessions.length > 5) lines.push(`_... и ещё ${sessions.length - 5} тренировок_`);

  lines.push('_Запиши: "жим лёжа 70кг 3×8, тяга 100кг 3×6"_');

  return lines.join('\n');
}

export function formatParsedExercises(exercises: ParsedExercise[]): string {
  if (exercises.length === 0) return '_Упражнения не распознаны_';
  return exercises.map((ex) => {
    const setsStr = ex.sets.map((s) => {
      const w = s.weight_kg !== null ? `${s.weight_kg}кг` : 'б/в';
      const r = s.reps !== null ? `×${s.reps}` : '';
      return `${w}${r}`;
    }).join(', ');
    return `• ${ex.exercise}: ${setsStr}`;
  }).join('\n');
}

export function formatProgressionInsight(
  exercise: string,
  history: Array<{ date: string; sets: WorkoutSet[] }>,
  suggestion: string | null,
): string {
  if (history.length === 0) return `_По "${exercise}" истории нет_`;

  const lines: string[] = [`📈 *${exercise}*\n`];

  for (const { date, sets } of history.slice(0, 4)) {
    const dateStr = formatShortDate(date);
    const setsStr = sets.map((s) => {
      const w = s.weight_kg !== null ? `${s.weight_kg}кг` : 'б/в';
      const r = s.reps !== null ? `×${s.reps}` : '';
      return `${w}${r}`;
    }).join(', ');
    lines.push(`${dateStr}: ${setsStr}`);
  }

  if (suggestion) {
    lines.push('');
    lines.push(`💡 ${suggestion}`);
  }

  return lines.join('\n');
}

// ── Utils ─────────────────────────────────────────────────────────────────

const SHORT_MONTH = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

function formatShortDate(iso: string): string {
  const d = new Date(`${iso}T12:00:00`);
  return `${String(d.getDate()).padStart(2, '0')} ${SHORT_MONTH[d.getMonth()] ?? ''}`;
}
