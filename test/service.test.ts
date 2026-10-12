import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnyListClient, AnyListHttpError, type CredentialStore } from '../src/client.js';
import { decodeUserData, encodeOperations, UserDataResponse, ListOperationList } from '../src/proto.js';
import { AnyListService } from '../src/service.js';
import type { Credentials } from '../src/config.js';

function memoryStore(initial: Credentials = {}): CredentialStore & { current: Credentials } {
  const s = { current: { ...initial }, load: () => ({ ...s.current }), save: (c: Credentials) => void (s.current = { ...c }) };
  return s;
}

const userData = UserDataResponse.encode(
  UserDataResponse.fromObject({
    shoppingListsResponse: {
      newLists: [
        {
          identifier: 'list1',
          name: 'Groceries',
          items: [
            { identifier: 'i1', name: 'Eggs', checked: false },
            { identifier: 'i2', name: 'Flour', checked: true },
            { identifier: 'i3', name: 'Milk', checked: false, quantityPb: { amount: '2', unit: 'cups', rawQuantity: '2 cups' } }
          ]
        }
      ]
    },
    recipeDataResponse: {
      recipes: [
        {
          identifier: 'r1',
          name: 'Overnight Beans',
          ingredients: [
            { name: 'Soak overnight', isHeading: true },
            { rawIngredient: '1 cup dried beans', name: 'dried beans', quantity: '1 cup' },
            { rawIngredient: '2 eggs', name: 'eggs', quantity: '2' },
            { rawIngredient: '1 cup flour', name: 'flour', quantity: '1 cup' }
          ]
        }
      ]
    }
  })
).finish();

function mockFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => handler(String(url), init ?? {}));
}

const tokenResponse = () => new Response(JSON.stringify({ access_token: 'A2', refresh_token: 'R2' }), { status: 200 });

describe('protobuf round-trip', () => {
  it('decodes user data', () => {
    const data = decodeUserData(userData);
    expect(data.shoppingListsResponse?.newLists?.[0].items).toHaveLength(3);
    expect(data.recipeDataResponse?.recipes?.[0].ingredients?.[0].isHeading).toBe(true);
  });

  it('encodes list operations', () => {
    const bytes = encodeOperations([
      {
        metadata: { operationId: 'op', handlerId: 'add-shopping-list-item' },
        listId: 'list1',
        listItemId: 'x',
        listItem: { identifier: 'x', name: 'milk', quantityPb: { amount: '2', unit: 'cups', rawQuantity: '2 cups' }, rawIngredient: '2 cups milk' }
      }
    ]);
    const decoded = ListOperationList.toObject(ListOperationList.decode(bytes)) as any;
    expect(decoded.operations[0].listItem.quantityPb.unit).toBe('cups');
    expect(decoded.operations[0].listItem.rawIngredient).toBe('2 cups milk');
  });
});

describe('AnyListClient HTTP behaviour', () => {
  it('refreshes the token on 401 and retries once', async () => {
    const calls: string[] = [];
    const fetchMock = mockFetch((url, init) => {
      calls.push(url.replace('https://www.anylist.com', ''));
      if (url.endsWith('/auth/token/refresh')) return tokenResponse();
      const auth = (init.headers as Record<string, string>).Authorization;
      return auth === 'Bearer A2' ? new Response(userData, { status: 200 }) : new Response('expired', { status: 401 });
    });
    const store = memoryStore({ accessToken: 'A1', refreshToken: 'R1', clientId: 'c' });
    const client = new AnyListClient({ fetch: fetchMock as any, store });
    const data = await client.getUserData();
    expect(data.shoppingListsResponse?.newLists).toHaveLength(1);
    expect(calls).toEqual(['/data/user-data/get', '/auth/token/refresh', '/data/user-data/get']);
    expect(store.current.accessToken).toBe('A2');
  });

  it('retries only once and reports status and body', async () => {
    const fetchMock = mockFetch((url) =>
      url.endsWith('/auth/token/refresh') ? tokenResponse() : new Response('still no', { status: 401 })
    );
    const client = new AnyListClient({ fetch: fetchMock as any, store: memoryStore({ accessToken: 'A1', refreshToken: 'R1' }) });
    const err = await client.getUserData().catch((e) => e);
    expect(err).toBeInstanceOf(AnyListHttpError);
    expect(err.status).toBe(401);
    expect(err.message).toContain('401');
    expect(err.message).toContain('still no');
    // data, refresh, data
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('includes status and body for other errors without retrying', async () => {
    const fetchMock = mockFetch(() => new Response('boom', { status: 500 }));
    const client = new AnyListClient({ fetch: fetchMock as any, store: memoryStore({ accessToken: 'A1', refreshToken: 'R1' }) });
    await expect(client.getUserData()).rejects.toThrow(/500.*boom/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to a password login when the refresh token is rejected', async () => {
    let dataCalls = 0;
    const fetchMock = mockFetch((url) => {
      if (url.endsWith('/auth/token/refresh')) return new Response('bad refresh', { status: 401 });
      if (url.endsWith('/auth/token')) return tokenResponse();
      return ++dataCalls === 1 ? new Response('', { status: 401 }) : new Response(userData, { status: 200 });
    });
    const store = memoryStore({ accessToken: 'A1', refreshToken: 'R1', email: 'you@example.com', password: 'pw' });
    const client = new AnyListClient({ fetch: fetchMock as any, store, email: undefined, password: undefined });
    await client.getUserData();
    expect(store.current.accessToken).toBe('A2');
  });

  it('throws a helpful error when not logged in', async () => {
    const client = new AnyListClient({ fetch: mockFetch(() => new Response('')) as any, store: memoryStore(), email: undefined, password: undefined });
    delete process.env.ANYLIST_EMAIL;
    await expect(client.getUserData()).rejects.toThrow(/anylist auth login/);
  });
});

describe('AnyListService', () => {
  const sent: any[] = [];
  const build = () => {
    sent.length = 0;
    const fetchMock = mockFetch(async (url, init) => {
      if (url.endsWith('/data/shopping-lists/update')) {
        const form = init.body as FormData;
        const blob = form.get('operations') as Blob;
        const decoded = ListOperationList.toObject(ListOperationList.decode(new Uint8Array(await blob.arrayBuffer()))) as any;
        sent.push(...decoded.operations);
        return new Response('', { status: 200 });
      }
      return new Response(userData, { status: 200 });
    });
    const client = new AnyListClient({ fetch: fetchMock as any, store: memoryStore({ accessToken: 'A', refreshToken: 'R', clientId: 'c' }) });
    return new AnyListService(client);
  };

  it('shows recipes with section headers flagged', async () => {
    const recipe = await build().showRecipe('beans');
    expect(recipe.ingredients[0]).toMatchObject({ name: 'Soak overnight', isHeading: true });
    expect(recipe.ingredients.filter((i) => !i.isHeading)).toHaveLength(3);
  });

  it('reports only ingredients not unchecked on the list', async () => {
    const plan = await build().missing('Overnight Beans', 'Groceries');
    // eggs is unchecked on the list; flour is checked so it still needs buying; header skipped
    expect(plan.toAdd.map((p) => p.name)).toEqual(['dried beans', 'flour']);
    expect(plan.alreadyOnList.map((p) => p.name)).toEqual(['eggs']);
  });

  it('add-to-list --dry-run sends nothing', async () => {
    const result = await build().addRecipeToList('Overnight Beans', 'Groceries', true);
    expect(result.toAdd).toHaveLength(2);
    expect(sent).toHaveLength(0);
  });

  it('add-to-list sends parsed items with quantityPb and rawIngredient', async () => {
    await build().addRecipeToList('Overnight Beans', 'Groceries');
    expect(sent).toHaveLength(2);
    const beans = sent[0].listItem;
    expect(beans.name).toBe('dried beans');
    expect(beans.quantityPb).toEqual({ amount: '1', unit: 'cup', rawQuantity: '1 cup' });
    expect(beans.rawIngredient).toBe('1 cup dried beans');
    expect(sent[0].metadata.handlerId).toBe('add-shopping-list-item');
  });

  it('adds free-text items with parsing', async () => {
    await build().addItem('2 large eggs, beaten', 'groceries');
    const item = sent[0].listItem;
    expect(item).toMatchObject({ name: 'large eggs', details: 'beaten', rawIngredient: '2 large eggs, beaten' });
    expect(item.quantityPb.amount).toBe('2');
  });

  it('checks the unchecked match and unchecks the checked one', async () => {
    const svc = build();
    await svc.setChecked('flour', false, 'Groceries');
    expect(sent[0]).toMatchObject({ listItemId: 'i2', updatedValue: 'n' });
    await svc.setChecked('eggs', true, 'Groceries');
    expect(sent[1]).toMatchObject({ listItemId: 'i1', updatedValue: 'y' });
  });

  it('removes an item', async () => {
    await build().removeItem('Milk', 'Groceries');
    expect(sent[0].metadata.handlerId).toBe('remove-shopping-list-item');
    expect(sent[0].listItemId).toBe('i3');
  });

  it('errors on unknown lists with the available names', async () => {
    await expect(build().showList('Nope')).rejects.toThrow(/Groceries/);
  });
});

describe('config storage', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anylist-cli-'));
    process.env.ANYLIST_CONFIG_DIR = path.join(dir, 'cfg');
  });
  afterEach(() => {
    delete process.env.ANYLIST_CONFIG_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes private files and directories', async () => {
    const cfg = await import('../src/config.js');
    cfg.saveCredentials({ email: 'you@example.com', accessToken: 'x' });
    cfg.setConfigValue('default_list', 'Groceries');
    expect(fs.statSync(process.env.ANYLIST_CONFIG_DIR!).mode & 0o777).toBe(0o700);
    expect(fs.statSync(cfg.credentialsPath()).mode & 0o777).toBe(0o600);
    expect(fs.statSync(cfg.configPath()).mode & 0o777).toBe(0o600);
    expect(cfg.loadConfig().default_list).toBe('Groceries');
  });

  it('rejects unknown config keys', async () => {
    const cfg = await import('../src/config.js');
    expect(() => cfg.setConfigValue('nope', 'x')).toThrow(/Unknown config key/);
  });

  it('falls back to default_list', async () => {
    const cfg = await import('../src/config.js');
    cfg.setConfigValue('default_list', 'Groceries');
    const fetchMock = mockFetch(() => new Response(userData, { status: 200 }));
    const client = new AnyListClient({ fetch: fetchMock as any, store: memoryStore({ accessToken: 'A' }) });
    expect((await new AnyListService(client).showList()).name).toBe('Groceries');
  });
});
