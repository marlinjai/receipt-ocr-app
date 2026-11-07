import type OpenAI from 'openai';

export const TABLE_TOOLS: OpenAI.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'get_rows',
      description:
        'Get rows from the receipts table. Returns row data with all cell values. Use this to inspect data before making changes.',
      parameters: {
        type: 'object',
        properties: {
          filter: {
            type: 'object',
            description:
              'Optional filter. Keys are column names, values are substrings to match (case-insensitive).',
            additionalProperties: { type: 'string' },
          },
          limit: {
            type: 'number',
            description: 'Max rows to return. Default 50.',
          },
          includeText: {
            type: 'boolean',
            description:
              'Also return the recognized text of each receipt as "OCR Text". It is not part of the rows otherwise and is slower to fetch: ask for it only when the text is needed (for example to classify), and then with a limit of 25 or less.',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_columns',
      description: 'Get all column names and their types from the receipts table.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_select_options',
      description:
        'Get available options for a select column (e.g., Category, Status, Zuordnung). Returns option names and IDs.',
      parameters: {
        type: 'object',
        properties: {
          columnName: {
            type: 'string',
            description: 'Column name to get options for.',
          },
        },
        required: ['columnName'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_cells',
      description:
        'Update one or more cells for a single row. Used for editing, classifying, etc. For select columns, use the option name (not ID) — the system will resolve it.',
      parameters: {
        type: 'object',
        properties: {
          rowId: { type: 'string', description: 'The row ID to update.' },
          updates: {
            type: 'object',
            description: 'Map of column name → new value.',
            additionalProperties: {},
          },
        },
        required: ['rowId', 'updates'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'bulk_update',
      description:
        'Update the same field(s) across multiple rows at once. More efficient than individual update_cells calls.',
      parameters: {
        type: 'object',
        properties: {
          rowIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'Array of row IDs to update.',
          },
          updates: {
            type: 'object',
            description: 'Map of column name → new value to apply to all rows.',
            additionalProperties: {},
          },
        },
        required: ['rowIds', 'updates'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_row',
      description: 'Create a new row in the receipts table.',
      parameters: {
        type: 'object',
        properties: {
          cells: {
            type: 'object',
            description: 'Map of column name → value.',
            additionalProperties: {},
          },
        },
        required: ['cells'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_rows',
      description: 'Delete one or more rows from the table.',
      parameters: {
        type: 'object',
        properties: {
          rowIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'Array of row IDs to delete.',
          },
        },
        required: ['rowIds'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remember_statement',
      description:
        'Remember something the user states about their own situation that decides who bears the cost of receipts, as one short sentence in German ("Seit Mai 2026 studiere ich nicht mehr.", "Bei Amazon entscheidet, was gekauft wurde."). It is saved as a statement on the rules page, and the model that assigns new receipts (Geschäftlich, Universität, Privat) is given it. Use it only for what the user said about themselves, never for a guess of yours.',
      parameters: {
        type: 'object',
        properties: {
          statement: { type: 'string', description: 'The statement, one sentence in German, at most 300 characters.' },
          zuordnung: { type: 'string', description: 'The assignment the statement names, if it names exactly one (Geschäftlich, Universität or Privat); leave out otherwise.' },
        },
        required: ['statement'],
      },
    },
  },
];

const READ_ONLY_TOOLS = new Set(['get_rows', 'get_columns', 'get_select_options']);

export function isReadOnlyTool(name: string): boolean {
  return READ_ONLY_TOOLS.has(name);
}
