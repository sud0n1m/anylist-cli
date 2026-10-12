import { AnyListClient, newId } from './client.js';
import { loadConfig } from './config.js';
import { parseIngredient, parseQuantity, type ParsedQuantity } from './parser.js';
import type { WireIngredient, WireListItem, WireRecipe, WireShoppingList, WireUserData } from './proto.js';

export interface ItemView {
  id: string;
  name: string;
  quantity: string;
  details: string;
  checked: boolean;
}

export interface ListView {
  id: string;
  name: string;
  items: ItemView[];
}

export interface IngredientView {
  name: string;
  quantity: string;
  note: string;
  raw: string;
  isHeading: boolean;
}

export interface RecipeView {
  id: string;
  name: string;
  servings: string;
  sourceName: string;
  sourceUrl: string;
  note: string;
  ingredients: IngredientView[];
  steps: string[];
}

/** Human-readable quantity of a list item. */
function itemQuantity(item: WireListItem): string {
  const q = item.quantityPb;
  if (q?.rawQuantity) return q.rawQuantity;
  const joined = [q?.amount, q?.unit].filter(Boolean).join(' ');
  return joined || item.deprecatedQuantity || '';
}

export function toItemView(item: WireListItem): ItemView {
  return {
    id: item.identifier,
    name: item.name ?? '',
    quantity: itemQuantity(item),
    details: item.details ?? '',
    checked: item.checked === true
  };
}

export function toListView(list: WireShoppingList): ListView {
  return { id: list.identifier, name: list.name ?? '', items: (list.items ?? []).map(toItemView) };
}

/** True for section headers such as "Soak overnight" rather than real ingredients. */
export function isHeadingIngredient(ing: WireIngredient): boolean {
  if (ing.isHeading) return true;
  const hasContent = Boolean(ing.quantity) || Boolean(ing.note);
  const label = (ing.name || ing.rawIngredient || '').trim();
  return !hasContent && !ing.name && label.endsWith(':');
}

export function toRecipeView(recipe: WireRecipe): RecipeView {
  return {
    id: recipe.identifier,
    name: recipe.name ?? '',
    servings: recipe.servings ?? '',
    sourceName: recipe.sourceName ?? '',
    sourceUrl: recipe.sourceUrl ?? '',
    note: recipe.note ?? '',
    ingredients: (recipe.ingredients ?? []).map((ing) => ({
      name: ing.name || ing.rawIngredient || '',
      quantity: ing.quantity ?? '',
      note: ing.note ?? '',
      raw: ing.rawIngredient ?? '',
      isHeading: isHeadingIngredient(ing)
    })),
    steps: recipe.preparationSteps ?? []
  };
}

/** Normalise a name for matching: case, punctuation and a trailing plural "s". */
export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w))
    .join(' ');
}

/** What would be added to a list for one recipe ingredient. */
export interface PlannedItem {
  name: string;
  quantity: ParsedQuantity;
  details: string;
  rawIngredient: string;
}

export interface RecipeShoppingPlan {
  recipe: RecipeView;
  toAdd: PlannedItem[];
  alreadyOnList: PlannedItem[];
}

export function planFromIngredient(ing: WireIngredient): PlannedItem | null {
  if (isHeadingIngredient(ing)) return null;
  const raw = (ing.rawIngredient || [ing.quantity, ing.name].filter(Boolean).join(' ')).trim();
  if (!raw && !ing.name) return null;

  if (ing.name) {
    // The recipe already separates name and quantity; only the quantity needs parsing.
    const quantity = ing.quantity
      ? (parseQuantity(ing.quantity) ?? { amount: '', unit: '', rawQuantity: ing.quantity })
      : { amount: '', unit: '', rawQuantity: '' };
    return { name: ing.name, quantity, details: ing.note ?? '', rawIngredient: raw };
  }
  const parsed = parseIngredient(raw);
  return { ...parsed, details: parsed.details || ing.note || '', rawIngredient: raw };
}

export class AnyListService {
  private snapshot?: WireUserData;

  constructor(readonly client: AnyListClient) {}

  private async data(refresh = false): Promise<WireUserData> {
    if (!this.snapshot || refresh) this.snapshot = await this.client.getUserData();
    return this.snapshot;
  }

  private async rawLists(refresh = false): Promise<WireShoppingList[]> {
    const data = await this.data(refresh);
    return data.shoppingListsResponse?.newLists ?? [];
  }

  async lists(): Promise<ListView[]> {
    return (await this.rawLists()).map(toListView);
  }

  /** Resolve --list / default_list to a list; falls back to the only list if there is just one. */
  private async resolveList(name?: string): Promise<WireShoppingList> {
    const lists = await this.rawLists();
    const wanted = name ?? loadConfig().default_list;
    if (!wanted) {
      if (lists.length === 1) return lists[0];
      throw new Error(
        `No list specified. Use --list <name> or run \`anylist config set default_list <name>\`. Available lists: ${
          lists.map((l) => l.name).join(', ') || '(none)'
        }`
      );
    }
    const lower = wanted.toLowerCase();
    const found =
      lists.find((l) => l.identifier === wanted) ??
      lists.find((l) => (l.name ?? '').toLowerCase() === lower) ??
      lists.find((l) => (l.name ?? '').toLowerCase().includes(lower));
    if (!found) {
      throw new Error(`List "${wanted}" not found. Available lists: ${lists.map((l) => l.name).join(', ') || '(none)'}`);
    }
    return found;
  }

  async showList(name?: string): Promise<ListView> {
    return toListView(await this.resolveList(name));
  }

  private findItem(list: WireShoppingList, name: string, prefer?: boolean): WireListItem {
    const items = list.items ?? [];
    const lower = name.toLowerCase();
    const pools = prefer === undefined ? [items] : [items.filter((i) => (i.checked === true) === prefer), items];
    for (const pool of pools) {
      const exact = pool.filter((i) => (i.name ?? '').toLowerCase() === lower);
      if (exact.length > 0) return exact[0];
      const partial = pool.filter((i) => (i.name ?? '').toLowerCase().includes(lower));
      if (partial.length === 1) return partial[0];
      if (partial.length > 1) {
        throw new Error(
          `"${name}" matches several items: ${partial.map((i) => i.name).join(', ')}. Use the full name.`
        );
      }
    }
    throw new Error(`No item matching "${name}" on list "${list.name}".`);
  }

  async addItem(text: string, listName?: string): Promise<{ list: string; item: ItemView; parsed: PlannedItem }> {
    const list = await this.resolveList(listName);
    const parsed = parseIngredient(text);
    const item = this.buildItem(list, { ...parsed, rawIngredient: text.trim() });
    await this.client.sendListOperations([
      this.client.operation('add-shopping-list-item', list.identifier, { listItemId: item.identifier, listItem: item })
    ]);
    this.snapshot = undefined;
    return {
      list: list.name ?? '',
      item: toItemView(item),
      parsed: { ...parsed, rawIngredient: text.trim() }
    };
  }

  private buildItem(list: WireShoppingList, planned: PlannedItem, recipeId?: string): WireListItem {
    return {
      identifier: newId(),
      listId: list.identifier,
      name: planned.name,
      details: planned.details,
      checked: false,
      rawIngredient: planned.rawIngredient,
      quantityPb: { ...planned.quantity },
      ...(recipeId ? { recipeId } : {}),
      ...(this.client.userId ? { userId: this.client.userId } : {})
    };
  }

  async removeItem(name: string, listName?: string): Promise<ItemView> {
    const list = await this.resolveList(listName);
    const item = this.findItem(list, name);
    await this.client.sendListOperations([
      this.client.operation('remove-shopping-list-item', list.identifier, {
        listItemId: item.identifier,
        listItem: item
      })
    ]);
    this.snapshot = undefined;
    return toItemView(item);
  }

  async setChecked(name: string, checked: boolean, listName?: string): Promise<ItemView> {
    const list = await this.resolveList(listName);
    // Prefer items currently in the opposite state so "check milk" finds the unchecked one.
    const item = this.findItem(list, name, !checked);
    await this.client.sendListOperations([
      this.client.operation('set-list-item-checked', list.identifier, {
        listItemId: item.identifier,
        updatedValue: checked ? 'y' : 'n'
      })
    ]);
    this.snapshot = undefined;
    return { ...toItemView(item), checked };
  }

  async recipes(query?: string): Promise<RecipeView[]> {
    const all = ((await this.data()).recipeDataResponse?.recipes ?? []).map(toRecipeView);
    if (!query) return all;
    const q = query.toLowerCase();
    return all.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        r.ingredients.some((i) => i.name.toLowerCase().includes(q)) ||
        r.sourceName.toLowerCase().includes(q)
    );
  }

  private async rawRecipe(name: string): Promise<WireRecipe> {
    const all = (await this.data()).recipeDataResponse?.recipes ?? [];
    const lower = name.toLowerCase();
    const found =
      all.find((r) => r.identifier === name) ??
      all.find((r) => (r.name ?? '').toLowerCase() === lower);
    if (found) return found;
    const partial = all.filter((r) => (r.name ?? '').toLowerCase().includes(lower));
    if (partial.length === 1) return partial[0];
    if (partial.length > 1) {
      throw new Error(`"${name}" matches several recipes: ${partial.map((r) => r.name).join(', ')}.`);
    }
    throw new Error(`Recipe "${name}" not found.`);
  }

  async showRecipe(name: string): Promise<RecipeView> {
    return toRecipeView(await this.rawRecipe(name));
  }

  /** Split a recipe's real ingredients into those missing from the list and those already unchecked on it. */
  async planRecipe(name: string, listName?: string): Promise<RecipeShoppingPlan & { list: string }> {
    const [recipe, list] = [await this.rawRecipe(name), await this.resolveList(listName)];
    const onList = new Set(
      (list.items ?? []).filter((i) => i.checked !== true).map((i) => normalizeName(i.name ?? ''))
    );
    const toAdd: PlannedItem[] = [];
    const alreadyOnList: PlannedItem[] = [];
    const seen = new Set<string>();
    for (const ing of recipe.ingredients ?? []) {
      const planned = planFromIngredient(ing);
      if (!planned) continue;
      const key = normalizeName(planned.name);
      if (onList.has(key)) alreadyOnList.push(planned);
      else if (!seen.has(key)) {
        seen.add(key);
        toAdd.push(planned);
      }
    }
    return { recipe: toRecipeView(recipe), toAdd, alreadyOnList, list: list.name ?? '' };
  }

  async missing(name: string, listName?: string): Promise<RecipeShoppingPlan & { list: string }> {
    return this.planRecipe(name, listName);
  }

  async addRecipeToList(
    name: string,
    listName?: string,
    dryRun = false
  ): Promise<RecipeShoppingPlan & { list: string; dryRun: boolean }> {
    const plan = await this.planRecipe(name, listName);
    if (!dryRun && plan.toAdd.length > 0) {
      const list = await this.resolveList(listName);
      await this.client.sendListOperations(
        plan.toAdd.map((planned) => {
          const item = this.buildItem(list, planned, plan.recipe.id);
          return this.client.operation('add-shopping-list-item', list.identifier, {
            listItemId: item.identifier,
            listItem: item
          });
        })
      );
      this.snapshot = undefined;
    }
    return { ...plan, dryRun };
  }
}
