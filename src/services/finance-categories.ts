export const EXPENSE_CATEGORIES = [
  'Еда',
  'Кафе и кофе',
  'Транспорт',
  'Квартира + коммуналка',
  'Связь',
  'GYM',
  'Кредиты',
  'Долг',
  'Другое',
] as const;

export const INCOME_CATEGORIES = [
  'Зарплата',
  'Премия',
  'ИП',
  'Долг (возврат)',
  'Иное',
] as const;

export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];
export type IncomeCategory = (typeof INCOME_CATEGORIES)[number];
export type TransactionCategory = ExpenseCategory | IncomeCategory;

const EXPENSE_CATEGORY_MAP: Record<ExpenseCategory, string> = {
  'Еда': 'Продукты',
  'Кафе и кофе': 'Кафе и рестораны',
  'Транспорт': 'Транспорт',
  'Квартира + коммуналка': 'Квартира',
  'Связь': 'Связь и интернет',
  'GYM': 'Другое',
  'Кредиты': 'Кредиты и кредитки',
  'Долг': 'Долги',
  'Другое': 'Другое',
};

const INCOME_CATEGORY_MAP: Record<IncomeCategory, string> = {
  'Зарплата': 'Зарплата',
  'Премия': 'Премия',
  'ИП': 'Иное',
  'Долг (возврат)': 'Иное',
  'Иное': 'Иное',
};

export function toApiCategory(category: string, type: 'income' | 'expense'): string {
  if (type === 'expense') {
    return EXPENSE_CATEGORY_MAP[category as ExpenseCategory] ?? 'Другое';
  }
  return INCOME_CATEGORY_MAP[category as IncomeCategory] ?? 'Иное';
}

export function getAllCategories(type: 'income' | 'expense'): readonly string[] {
  return type === 'expense' ? EXPENSE_CATEGORIES : INCOME_CATEGORIES;
}

export function getCategoryByIndex(type: 'income' | 'expense', index: number): string | undefined {
  const cats = type === 'expense' ? EXPENSE_CATEGORIES : INCOME_CATEGORIES;
  return cats[index];
}

export function isExpenseCategory(category: string): category is ExpenseCategory {
  return (EXPENSE_CATEGORIES as readonly string[]).includes(category);
}

export function isIncomeCategory(category: string): category is IncomeCategory {
  return (INCOME_CATEGORIES as readonly string[]).includes(category);
}
