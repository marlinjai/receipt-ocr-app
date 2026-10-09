import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FileNotFoundError } from '@marlinjai/storage-brain-sdk';

/**
 * The batch server actions: input cleaning, the write permission, the
 * workspace always taken from the session, and what counts as a deleted
 * stored file. Auth, database and file store are replaced; the service is a
 * spy (its behaviour against a real database is in `batch.dbtest.ts`).
 */

const requireAction = vi.fn();
const setMealTypeForRows = vi.fn();
const deleteReceiptRows = vi.fn();
const deleteFile = vi.fn();
const setReceiptFileRotation = vi.fn();

vi.mock('@/lib/auth', () => ({ auth: { requireAction: (...a: unknown[]) => requireAction(...a) } }));
vi.mock('@/lib/auth-guards', () => {
  class ReceiptsAuthError extends Error {
    constructor(readonly status: number) {
      super('auth');
    }
  }
  return { ReceiptsAuthError, requireReceiptsSession: vi.fn(), requireRowAccess: vi.fn() };
});
vi.mock('@/lib/prisma', () => ({ prisma: { marker: 'prisma' } }));
vi.mock('@/lib/storage', () => ({ getStorageClient: () => ({ deleteFile: (...a: unknown[]) => deleteFile(...a) }) }));
vi.mock('@/lib/meals/service', () => {
  class MealServiceError extends Error {
    constructor(readonly code: string) {
      super(code);
    }
  }
  class TaxSettingsError extends Error {}
  return {
    MealServiceError,
    TaxSettingsError,
    setMealTypeForRows: (...a: unknown[]) => setMealTypeForRows(...a),
    deleteReceiptRows: (...a: unknown[]) => deleteReceiptRows(...a),
    setReceiptFileRotation: (...a: unknown[]) => setReceiptFileRotation(...a),
  };
});

import { MealServiceError } from '@/lib/meals/service';
import { deleteMealReceipts, markMealsNotMeal, restoreMeals, saveReceiptRotation } from './actions';

const WS = { id: 'ws-a', slug: 'beispiel-studio', role: 'member', tenantId: 't-a' };
const SESSION = { memberships: [WS], activeWorkspace: WS };
const EMPTY = { done: [], records: [], skipped: [] };

beforeEach(() => {
  requireAction.mockReset();
  setMealTypeForRows.mockReset();
  deleteReceiptRows.mockReset();
  deleteFile.mockReset();
  setReceiptFileRotation.mockReset();
  requireAction.mockResolvedValue(SESSION);
  setMealTypeForRows.mockResolvedValue(EMPTY);
  deleteReceiptRows.mockResolvedValue(EMPTY);
});

describe('batch actions: input', () => {
  it('refuses input that is not a usable list of ids, before any permission check or write', async () => {
    for (const bad of [undefined, 'row-1', [], [1, 2], [''], Array.from({ length: 201 }, (_, i) => `r${i}`)]) {
      expect(await markMealsNotMeal(bad as never)).toEqual({ ok: false, error: 'invalid_input', detail: 'row_ids' });
      expect(await deleteMealReceipts(bad as never)).toEqual({ ok: false, error: 'invalid_input', detail: 'row_ids' });
    }
    expect(requireAction).not.toHaveBeenCalled();
    expect(setMealTypeForRows).not.toHaveBeenCalled();
    expect(deleteReceiptRows).not.toHaveBeenCalled();
  });

  it('sends each id once, and the workspace is the active one of the session', async () => {
    await markMealsNotMeal(['a', 'b', 'a', ' b ']);
    expect(requireAction).toHaveBeenCalledWith('receipts.row.write');
    expect(setMealTypeForRows).toHaveBeenCalledWith(
      { marker: 'prisma' },
      { workspaceId: 'ws-a', tenantId: 't-a' },
      ['a', 'b'],
      'not_a_meal',
    );
  });

  it('take back sets the receipts to a business meal again', async () => {
    await restoreMeals(['a']);
    expect(setMealTypeForRows.mock.calls[0][3]).toBe('business_meal_external');
  });
});

describe('batch actions: permission and failures', () => {
  it('without the write permission nothing is changed or deleted', async () => {
    requireAction.mockRejectedValue(Object.assign(new Error('forbidden'), { status: 403 }));
    expect(await markMealsNotMeal(['a'])).toEqual({ ok: false, error: 'forbidden' });
    expect(await deleteMealReceipts(['a'])).toEqual({ ok: false, error: 'forbidden' });
    expect(setMealTypeForRows).not.toHaveBeenCalled();
    expect(deleteReceiptRows).not.toHaveBeenCalled();
  });

  it('an expired session is reported as such', async () => {
    requireAction.mockRejectedValue(Object.assign(new Error('unauthorized'), { status: 401 }));
    expect(await deleteMealReceipts(['a'])).toEqual({ ok: false, error: 'unauthorized' });
  });

  it('a Receipts table that is behind is reported, not swallowed', async () => {
    setMealTypeForRows.mockRejectedValue(new (MealServiceError as never as new (c: string) => Error)('schema_outdated'));
    expect(await markMealsNotMeal(['a'])).toEqual({ ok: false, error: 'not_initialized', detail: 'schema_outdated' });
  });

  it('passes a partial result through unchanged', async () => {
    const partial = { done: ['a'], records: [], skipped: [{ rowId: 'b', reason: 'not_found' }] };
    deleteReceiptRows.mockResolvedValue(partial);
    expect(await deleteMealReceipts(['a', 'b'])).toEqual({ ok: true, value: partial });
  });
});

describe('batch delete: the stored file', () => {
  async function storedFileDeleter(): Promise<(fileId: string) => Promise<void>> {
    await deleteMealReceipts(['a']);
    return deleteReceiptRows.mock.calls[0][3].deleteStoredFile;
  }

  it('deletes through the file store', async () => {
    deleteFile.mockResolvedValue(undefined);
    await (await storedFileDeleter())('file-1');
    expect(deleteFile).toHaveBeenCalledWith('file-1');
  });

  it('a file that is already gone counts as deleted', async () => {
    const remove = await storedFileDeleter();
    deleteFile.mockRejectedValueOnce(new FileNotFoundError('file-1'));
    await expect(remove('file-1')).resolves.toBeUndefined();
    deleteFile.mockRejectedValueOnce(Object.assign(new Error('gone'), { statusCode: 404 }));
    await expect(remove('file-1')).resolves.toBeUndefined();
  });

  it('any other failure of the file store rejects, so the receipt is kept', async () => {
    const remove = await storedFileDeleter();
    deleteFile.mockRejectedValueOnce(Object.assign(new Error('store down'), { statusCode: 503 }));
    await expect(remove('file-1')).rejects.toThrow('store down');
    deleteFile.mockRejectedValueOnce(new Error('network'));
    await expect(remove('file-1')).rejects.toThrow('network');
  });
});

describe('saveReceiptRotation', () => {
  it('refuses anything but a quarter turn and missing ids, before any permission check or write', async () => {
    for (const bad of [45, 360, -90, NaN, 'abc', null, undefined]) {
      expect(await saveReceiptRotation('row-1', 'ref-1', bad as never)).toEqual({ ok: false, error: 'invalid_input', detail: 'rotation' });
    }
    expect(await saveReceiptRotation('', 'ref-1', 90)).toMatchObject({ ok: false, error: 'invalid_input' });
    expect(await saveReceiptRotation('row-1', '', 90)).toMatchObject({ ok: false, error: 'invalid_input' });
    expect(requireAction).not.toHaveBeenCalled();
    expect(setReceiptFileRotation).not.toHaveBeenCalled();
  });

  it('needs the write permission and works in the active workspace of the session', async () => {
    setReceiptFileRotation.mockResolvedValue({ rowId: 'row-1' });
    expect(await saveReceiptRotation('row-1', 'ref-1', 270)).toEqual({ ok: true, value: { record: { rowId: 'row-1' } } });
    expect(requireAction).toHaveBeenCalledWith('receipts.row.write');
    expect(setReceiptFileRotation).toHaveBeenCalledWith({ marker: 'prisma' }, { workspaceId: 'ws-a', tenantId: 't-a' }, 'row-1', 'ref-1', 270);

    requireAction.mockRejectedValue(Object.assign(new Error('forbidden'), { status: 403 }));
    setReceiptFileRotation.mockClear();
    expect(await saveReceiptRotation('row-1', 'ref-1', 90)).toEqual({ ok: false, error: 'forbidden' });
    expect(setReceiptFileRotation).not.toHaveBeenCalled();
  });

  it('a receipt of another workspace or a deleted one reads as not found', async () => {
    setReceiptFileRotation.mockRejectedValue(new (MealServiceError as never as new (c: string) => Error)('row_not_found'));
    expect(await saveReceiptRotation('row-x', 'ref-x', 90)).toEqual({ ok: false, error: 'not_found', detail: 'row_not_found' });
  });
});
