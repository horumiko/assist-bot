import { getDb } from '../db/database';
import { logger } from '../utils/logger';

const TZ = process.env.TIMEZONE || 'Europe/Minsk';

function getTodayIso(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
}

export interface BodyMeasurement {
  id: string;
  date: string;
  weight_kg: number | null;
  waist_cm: number | null;
  notes?: string;
}

export interface NutritionEntry {
  id: string;
  date: string;
  calories: number | null;
  protein_g: number | null;
  fat_g: number | null;
  carbs_g: number | null;
  notes?: string;
}

export interface WorkoutSession {
  id: string;
  date: string;
  name: string | null;
  notes?: string;
}

export interface WorkoutSet {
  id: string;
  session_id: string;
  exercise: string;
  set_number: number;
  reps: number | null;
  weight_kg: number | null;
  notes?: string;
}

export interface ParsedExercise {
  exercise: string;
  sets: Array<{ reps: number | null; weight_kg: number | null }>;
}

export class FitnessService {
  // ── Body measurements ──────────────────────────────────────────────────

  async upsertMeasurement(data: {
    date?: string;
    weight_kg?: number;
    waist_cm?: number;
    notes?: string;
  }): Promise<BodyMeasurement> {
    const db = getDb();
    const date = data.date ?? getTodayIso();

    const { data: row, error } = await db
      .from('body_measurements')
      .upsert(
        {
          date,
          ...(data.weight_kg !== undefined && { weight_kg: data.weight_kg }),
          ...(data.waist_cm !== undefined && { waist_cm: data.waist_cm }),
          ...(data.notes !== undefined && { notes: data.notes }),
        },
        { onConflict: 'date', ignoreDuplicates: false },
      )
      .select()
      .single();

    if (error) throw new Error(error.message);
    return this._mapMeasurement(row);
  }

  async getMeasurements(limit = 30): Promise<BodyMeasurement[]> {
    const db = getDb();
    const { data, error } = await db
      .from('body_measurements')
      .select('*')
      .order('date', { ascending: false })
      .limit(limit);
    if (error) throw new Error(error.message);
    return (data ?? []).map(this._mapMeasurement);
  }

  async getLatestMeasurement(): Promise<BodyMeasurement | null> {
    const rows = await this.getMeasurements(1);
    return rows[0] ?? null;
  }

  private _mapMeasurement(row: any): BodyMeasurement {
    return {
      id: row.id,
      date: row.date,
      weight_kg: row.weight_kg !== null ? Number(row.weight_kg) : null,
      waist_cm: row.waist_cm !== null ? Number(row.waist_cm) : null,
      notes: row.notes ?? undefined,
    };
  }

  // ── Nutrition ──────────────────────────────────────────────────────────

  async upsertNutrition(data: {
    date?: string;
    calories?: number;
    protein_g?: number;
    fat_g?: number;
    carbs_g?: number;
    notes?: string;
  }): Promise<NutritionEntry> {
    const db = getDb();
    const date = data.date ?? getTodayIso();

    const { data: row, error } = await db
      .from('nutrition_log')
      .upsert(
        {
          date,
          ...(data.calories !== undefined && { calories: data.calories }),
          ...(data.protein_g !== undefined && { protein_g: data.protein_g }),
          ...(data.fat_g !== undefined && { fat_g: data.fat_g }),
          ...(data.carbs_g !== undefined && { carbs_g: data.carbs_g }),
          ...(data.notes !== undefined && { notes: data.notes }),
        },
        { onConflict: 'date', ignoreDuplicates: false },
      )
      .select()
      .single();

    if (error) throw new Error(error.message);
    return this._mapNutrition(row);
  }

  async getNutrition(date?: string): Promise<NutritionEntry | null> {
    const db = getDb();
    const { data, error } = await db
      .from('nutrition_log')
      .select('*')
      .eq('date', date ?? getTodayIso())
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data ? this._mapNutrition(data) : null;
  }

  async getRecentNutrition(days = 7): Promise<NutritionEntry[]> {
    const db = getDb();
    const { data, error } = await db
      .from('nutrition_log')
      .select('*')
      .order('date', { ascending: false })
      .limit(days);
    if (error) throw new Error(error.message);
    return (data ?? []).map(this._mapNutrition);
  }

  private _mapNutrition(row: any): NutritionEntry {
    return {
      id: row.id,
      date: row.date,
      calories: row.calories !== null ? Number(row.calories) : null,
      protein_g: row.protein_g !== null ? Number(row.protein_g) : null,
      fat_g: row.fat_g !== null ? Number(row.fat_g) : null,
      carbs_g: row.carbs_g !== null ? Number(row.carbs_g) : null,
      notes: row.notes ?? undefined,
    };
  }

  // ── Workout sessions ───────────────────────────────────────────────────

  async createSession(data: { date?: string; name?: string; notes?: string }): Promise<WorkoutSession> {
    const db = getDb();
    const { data: row, error } = await db
      .from('workout_sessions')
      .insert({ date: data.date ?? getTodayIso(), name: data.name ?? null, notes: data.notes ?? null })
      .select()
      .single();
    if (error) throw new Error(error.message);
    return this._mapSession(row);
  }

  async getRecentSessions(limit = 10): Promise<WorkoutSession[]> {
    const db = getDb();
    const { data, error } = await db
      .from('workout_sessions')
      .select('*')
      .order('date', { ascending: false })
      .limit(limit);
    if (error) throw new Error(error.message);
    return (data ?? []).map(this._mapSession);
  }

  async getSessionSets(sessionId: string): Promise<WorkoutSet[]> {
    const db = getDb();
    const { data, error } = await db
      .from('workout_sets')
      .select('*')
      .eq('session_id', sessionId)
      .order('exercise')
      .order('set_number');
    if (error) throw new Error(error.message);
    return (data ?? []).map(this._mapSet);
  }

  async addSets(sessionId: string, exercises: ParsedExercise[]): Promise<void> {
    const db = getDb();
    const rows = exercises.flatMap((ex) =>
      ex.sets.map((s, i) => ({
        session_id: sessionId,
        exercise: ex.exercise,
        set_number: i + 1,
        reps: s.reps ?? null,
        weight_kg: s.weight_kg ?? null,
      })),
    );
    if (rows.length === 0) return;
    const { error } = await db.from('workout_sets').insert(rows);
    if (error) throw new Error(error.message);
  }

  async getExerciseHistory(exercise: string, limit = 5): Promise<Array<{ date: string; sets: WorkoutSet[] }>> {
    const db = getDb();
    // Find sessions that contain this exercise
    const { data: setsData, error } = await db
      .from('workout_sets')
      .select('*, workout_sessions(date)')
      .ilike('exercise', `%${exercise}%`)
      .order('created_at', { ascending: false })
      .limit(limit * 10);

    if (error) throw new Error(error.message);

    const bySession = new Map<string, { date: string; sets: WorkoutSet[] }>();
    for (const row of (setsData ?? [])) {
      if (!bySession.has(row.session_id)) {
        const sessionDate = (row.workout_sessions as any)?.date ?? '';
        bySession.set(row.session_id, { date: sessionDate, sets: [] });
      }
      bySession.get(row.session_id)!.sets.push(this._mapSet(row));
    }

    return Array.from(bySession.values())
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, limit);
  }

  private _mapSession(row: any): WorkoutSession {
    return { id: row.id, date: row.date, name: row.name ?? null, notes: row.notes ?? undefined };
  }

  private _mapSet(row: any): WorkoutSet {
    return {
      id: row.id,
      session_id: row.session_id,
      exercise: row.exercise,
      set_number: Number(row.set_number),
      reps: row.reps !== null ? Number(row.reps) : null,
      weight_kg: row.weight_kg !== null ? Number(row.weight_kg) : null,
      notes: row.notes ?? undefined,
    };
  }

  // ── Progression analysis ───────────────────────────────────────────────

  /**
   * Suggests weight progression for an exercise based on last sessions.
   * Returns null if not enough data.
   */
  getProgressionSuggestion(history: Array<{ date: string; sets: WorkoutSet[] }>): string | null {
    if (history.length < 2) return null;

    const last = history[0]!;
    const prev = history[1]!;

    const lastSets = last.sets.filter((s) => s.weight_kg !== null && s.reps !== null);
    const prevSets = prev.sets.filter((s) => s.weight_kg !== null && s.reps !== null);

    if (lastSets.length === 0 || prevSets.length === 0) return null;

    const lastAvgWeight = lastSets.reduce((s, x) => s + (x.weight_kg ?? 0), 0) / lastSets.length;
    const prevAvgWeight = prevSets.reduce((s, x) => s + (x.weight_kg ?? 0), 0) / prevSets.length;

    const lastAvgReps = lastSets.reduce((s, x) => s + (x.reps ?? 0), 0) / lastSets.length;
    const targetReps = prevSets[0]?.reps ?? 8;

    // If same weight as last session and hit target reps → increase
    if (Math.abs(lastAvgWeight - prevAvgWeight) < 0.1 && lastAvgReps >= targetReps) {
      const increment = lastAvgWeight < 40 ? 2.5 : 5;
      return `Прогресс! Попробуй ${lastAvgWeight + increment} кг в следующий раз`;
    }

    // If weight increased compared to prev session → acknowledge
    if (lastAvgWeight > prevAvgWeight + 0.1) {
      return `Вес вырос с ${prevAvgWeight} до ${lastAvgWeight} кг — хорошая динамика`;
    }

    return null;
  }

  // ── Text parsers ───────────────────────────────────────────────────────

  /**
   * Parse measurement input like "вес 82.5 живот 89" or "82.5кг 89см"
   */
  static parseMeasurement(text: string): { weight_kg?: number; waist_cm?: number } | null {
    const result: { weight_kg?: number; waist_cm?: number } = {};

    const weightMatch =
      text.match(/(?:вес\s*|weight\s*)(\d+(?:[.,]\d+)?)\s*(?:кг|kg)?/i) ??
      text.match(/(\d+(?:[.,]\d+)?)\s*кг/i);
    if (weightMatch) result.weight_kg = parseFloat(weightMatch[1]!.replace(',', '.'));

    const waistMatch =
      text.match(/(?:живот\s*|талия\s*|waist\s*)(\d+(?:[.,]\d+)?)\s*(?:см|cm)?/i) ??
      text.match(/(\d+(?:[.,]\d+)?)\s*см/i);
    if (waistMatch) result.waist_cm = parseFloat(waistMatch[1]!.replace(',', '.'));

    if (!result.weight_kg && !result.waist_cm) return null;
    return result;
  }

  /**
   * Parse nutrition input like "2200 ккал б180 ж70 у200" or "2200/180/70/200"
   */
  static parseNutrition(text: string): {
    calories?: number;
    protein_g?: number;
    fat_g?: number;
    carbs_g?: number;
  } | null {
    const result: { calories?: number; protein_g?: number; fat_g?: number; carbs_g?: number } = {};

    // Format: 2200/180/70/200 (ккал/б/ж/у)
    const slashMatch = text.match(/(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)/);
    if (slashMatch) {
      result.calories = Number(slashMatch[1]);
      result.protein_g = Number(slashMatch[2]);
      result.fat_g = Number(slashMatch[3]);
      result.carbs_g = Number(slashMatch[4]);
      return result;
    }

    const calMatch = text.match(/(\d+)\s*(?:ккал|калор|cal|kcal)/i);
    if (calMatch) result.calories = Number(calMatch[1]);

    const protMatch = text.match(/(?:б|белк|protein|p)\s*(\d+)/i);
    if (protMatch) result.protein_g = Number(protMatch[1]);

    const fatMatch = text.match(/(?:ж|жир|fat|f)\s*(\d+)/i);
    if (fatMatch) result.fat_g = Number(fatMatch[1]);

    const carbMatch = text.match(/(?:у|угл|carb|c)\s*(\d+)/i);
    if (carbMatch) result.carbs_g = Number(carbMatch[1]);

    if (!result.calories && !result.protein_g && !result.fat_g && !result.carbs_g) return null;
    return result;
  }

  /**
   * Parse workout text like:
   *   "жим лёжа 70кг 3×8" or "жим 3x8 70" or "подтягивания 3×10"
   * Returns array of exercises with sets.
   */
  static parseWorkout(text: string): ParsedExercise[] {
    const results: ParsedExercise[] = [];

    // Split by newline or semicolon for multiple exercises
    const lines = text.split(/[\n;,]/).map((l) => l.trim()).filter(Boolean);

    for (const line of lines) {
      const ex = FitnessService._parseExerciseLine(line);
      if (ex) results.push(ex);
    }

    return results;
  }

  private static _parseExerciseLine(line: string): ParsedExercise | null {
    // Pattern: {name} {weight}кг {sets}×{reps} — or variations
    const patterns = [
      // "жим лёжа 70кг 3×8" or "жим 70кг 3x8"
      /^(.+?)\s+(\d+(?:[.,]\d+)?)\s*(?:кг|kg)\s+(\d+)\s*[×x×]\s*(\d+)/i,
      // "жим лёжа 3×8 70кг"
      /^(.+?)\s+(\d+)\s*[×x×]\s*(\d+)\s+(\d+(?:[.,]\d+)?)\s*(?:кг|kg)/i,
      // "подтягивания 3×10" (no weight = bodyweight)
      /^(.+?)\s+(\d+)\s*[×x×]\s*(\d+)/i,
      // "жим 3 по 8 70кг"
      /^(.+?)\s+(\d+)\s+(?:по|подх|сет)\s*(\d+)\s*(?:(\d+(?:[.,]\d+)?)\s*(?:кг|kg))?/i,
    ];

    // Pattern 1: name weight sets×reps
    let m = line.match(/^(.+?)\s+(\d+(?:[.,]\d+)?)\s*(?:кг|kg)\s+(\d+)\s*[×xх]\s*(\d+)/i);
    if (m) {
      const name = m[1]!.trim();
      const weight = parseFloat(m[2]!.replace(',', '.'));
      const sets = parseInt(m[3]!);
      const reps = parseInt(m[4]!);
      return {
        exercise: name,
        sets: Array.from({ length: sets }, () => ({ reps, weight_kg: weight })),
      };
    }

    // Pattern 2: name sets×reps weight
    m = line.match(/^(.+?)\s+(\d+)\s*[×xх]\s*(\d+)\s+(\d+(?:[.,]\d+)?)\s*(?:кг|kg)/i);
    if (m) {
      const name = m[1]!.trim();
      const sets = parseInt(m[2]!);
      const reps = parseInt(m[3]!);
      const weight = parseFloat(m[4]!.replace(',', '.'));
      return {
        exercise: name,
        sets: Array.from({ length: sets }, () => ({ reps, weight_kg: weight })),
      };
    }

    // Pattern 3: name sets×reps (bodyweight)
    m = line.match(/^(.+?)\s+(\d+)\s*[×xх]\s*(\d+)/i);
    if (m) {
      const name = m[1]!.trim();
      const sets = parseInt(m[2]!);
      const reps = parseInt(m[3]!);
      return {
        exercise: name,
        sets: Array.from({ length: sets }, () => ({ reps, weight_kg: null })),
      };
    }

    void patterns; // used for documentation only
    return null;
  }
}
