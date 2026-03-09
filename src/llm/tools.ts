export interface LLMTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export const financeTools: LLMTool[] = [
  {
    type: 'function',
    function: {
      name: 'add_transaction',
      description: 'Добавить финансовую операцию (трату или доход)',
      parameters: {
        type: 'object',
        properties: {
          amount: { type: 'number', description: 'Сумма в рублях' },
          type: { type: 'string', enum: ['income', 'expense'], description: 'Тип: income (доход) или expense (расход)' },
          category: {
            type: 'string',
            enum: ['Еда', 'Кафе и кофе', 'Транспорт', 'Квартира + коммуналка', 'Связь', 'GYM', 'Кредиты', 'Долг', 'Другое', 'Зарплата', 'Премия', 'ИП', 'Долг (возврат)', 'Иное'],
            description: 'Категория операции',
          },
          description: { type: 'string', description: 'Краткое описание (например: Пятёрочка, кофе, зп)' },
          date: { type: 'string', description: 'Дата в формате YYYY-MM-DD, если не указана — сегодня' },
          recurrence: {
            type: 'string',
            enum: ['once', 'daily', 'weekly', 'monthly', 'quarterly'],
            description: 'Периодичность: once (разовая), monthly, weekly, daily, quarterly',
          },
        },
        required: ['amount', 'type', 'category'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_finance_summary',
      description: 'Получить финансовую сводку за месяц: баланс, доходы, расходы по категориям',
      parameters: {
        type: 'object',
        properties: {
          year: { type: 'number', description: 'Год (по умолчанию текущий)' },
          month: { type: 'number', description: 'Месяц 1-12 (по умолчанию текущий)' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_transactions',
      description: 'Получить список транзакций за месяц',
      parameters: {
        type: 'object',
        properties: {
          year: { type: 'number', description: 'Год' },
          month: { type: 'number', description: 'Месяц 1-12' },
          limit: { type: 'number', description: 'Максимальное количество записей' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_budget',
      description: 'Установить лимит бюджета по категории',
      parameters: {
        type: 'object',
        properties: {
          category: {
            type: 'string',
            enum: ['Еда', 'Кафе и кофе', 'Транспорт', 'Квартира + коммуналка', 'Связь', 'GYM', 'Кредиты', 'Долг', 'Другое'],
            description: 'Категория расходов',
          },
          limit: { type: 'number', description: 'Лимит в рублях' },
          year: { type: 'number' },
          month: { type: 'number' },
        },
        required: ['category', 'limit'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_budget_status',
      description: 'Получить статус бюджетов по категориям за месяц',
      parameters: {
        type: 'object',
        properties: {
          year: { type: 'number' },
          month: { type: 'number' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_forecast',
      description: 'Получить прогноз баланса на период',
      parameters: {
        type: 'object',
        properties: {
          period: { type: 'string', enum: ['week', 'month', 'quarter', 'year'], description: 'Период прогноза' },
        },
        required: ['period'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'evaluate_unplanned_spend',
      description: 'Оценить, можно ли совершить внеплановую трату с учетом текущего баланса, регулярных платежей и лимитов бюджета',
      parameters: {
        type: 'object',
        properties: {
          amount: { type: 'number', description: 'Сумма предполагаемой внеплановой траты в рублях' },
          category: {
            type: 'string',
            enum: ['Еда', 'Кафе и кофе', 'Транспорт', 'Квартира + коммуналка', 'Связь', 'GYM', 'Кредиты', 'Долг', 'Другое'],
            description: 'Категория расхода (если пользователь указал)',
          },
          period: {
            type: 'string',
            enum: ['week', 'month', 'quarter', 'year'],
            description: 'Горизонт оценки с учетом регулярных платежей',
          },
        },
        required: ['amount'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_transaction',
      description: 'Удалить транзакцию по ID',
      parameters: {
        type: 'object',
        properties: {
          transaction_id: { type: 'string', description: 'ID транзакции' },
        },
        required: ['transaction_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_transaction',
      description: 'Обновить транзакцию (сумму, категорию, описание)',
      parameters: {
        type: 'object',
        properties: {
          transaction_id: { type: 'string', description: 'ID транзакции' },
          amount: { type: 'number' },
          category: { type: 'string' },
          description: { type: 'string' },
          date: { type: 'string' },
          recurrence: { type: 'string', enum: ['once', 'daily', 'weekly', 'monthly', 'quarterly'] },
        },
        required: ['transaction_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_finance_settings',
      description: 'Получить финансовые настройки (начальный баланс, минимальный порог)',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_finance_settings',
      description: 'Установить финансовые настройки',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', enum: ['min_balance', 'initial_balance', 'current_balance'], description: 'Ключ настройки' },
          value: { type: 'number', description: 'Значение' },
        },
        required: ['key', 'value'],
      },
    },
  },
];

export const tools: LLMTool[] = [
  {
    type: 'function',
    function: {
      name: 'create_task',
      description: 'Создать задачу в Todoist',
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'Название задачи' },
          due_string: { type: 'string', description: 'Срок задачи на русском, например "завтра", "среда", "через 3 дня"' },
          labels: { type: 'array', items: { type: 'string' }, description: 'Метки задачи (кроме bot и bitrix — они ставятся автоматически)' },
        },
        required: ['content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'complete_task',
      description: 'Отметить задачу как выполненную в Todoist',
      parameters: {
        type: 'object',
        properties: {
          task_name: { type: 'string', description: 'Название или часть названия задачи' },
          task_id: { type: 'string', description: 'ID задачи в Todoist (если известен)' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_task_status',
      description: 'Обновить статус задачи (метку) в Todoist. Если задача привязана к Bitrix24, статус дублируется туда.',
      parameters: {
        type: 'object',
        properties: {
          task_name: { type: 'string', description: 'Название или часть названия задачи' },
          task_id: { type: 'string', description: 'ID задачи в Todoist' },
          new_status: { type: 'string', description: 'Новый статус/метка' },
          comment: { type: 'string', description: 'Комментарий к обновлению статуса' },
        },
        required: ['new_status'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_task_deadline',
      description: 'Перенести дедлайн задачи. Если задача привязана к Bitrix24, дедлайн обновляется и там.',
      parameters: {
        type: 'object',
        properties: {
          task_name: { type: 'string', description: 'Название или часть названия задачи' },
          task_id: { type: 'string', description: 'ID задачи в Todoist' },
          due_string: { type: 'string', description: 'Новый срок, например "пятница", "следующий понедельник"' },
        },
        required: ['due_string'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'link_task_to_bitrix',
      description: 'Привязать задачу Todoist к задаче Bitrix24',
      parameters: {
        type: 'object',
        properties: {
          task_name: { type: 'string', description: 'Название или часть названия задачи в Todoist' },
          task_id: { type: 'string', description: 'ID задачи в Todoist' },
          bitrix_id: { type: 'string', description: 'ID задачи в Bitrix24' },
        },
        required: ['bitrix_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_calendar_event',
      description: 'Создать событие в Google Calendar',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Название события' },
          start_datetime: { type: 'string', description: 'Дата и время начала в формате ISO 8601' },
          end_datetime: { type: 'string', description: 'Дата и время окончания в формате ISO 8601' },
          description: { type: 'string', description: 'Описание события' },
          location: { type: 'string', description: 'Место проведения' },
          recurrence_rule: { type: 'string', description: 'Правило повторения в формате RRULE, например RRULE:FREQ=WEEKLY;BYDAY=TU' },
        },
        required: ['title', 'start_datetime', 'end_datetime'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_today_plan',
      description: 'Получить план на сегодня: активные задачи и события',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_tasks',
      description: 'Получить список активных задач по статусам',
      parameters: {
        type: 'object',
        properties: {
          filter: { type: 'string', enum: ['all', 'overdue', 'in_progress'], description: 'Фильтр задач' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_bitrix_comment',
      description: 'Добавить комментарий к задаче в Bitrix24 (через привязанную задачу в Todoist)',
      parameters: {
        type: 'object',
        properties: {
          task_name: { type: 'string', description: 'Название или часть названия задачи в Todoist' },
          task_id: { type: 'string', description: 'ID задачи в Todoist' },
          comment: { type: 'string', description: 'Текст комментария' },
        },
        required: ['comment'],
      },
    },
  },
  ...financeTools,
];
