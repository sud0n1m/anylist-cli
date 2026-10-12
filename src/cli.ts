#!/usr/bin/env node
import { Command } from 'commander';
import { AnyListClient } from './client.js';
import {
  clearCredentials,
  configDir,
  CONFIG_KEYS,
  loadConfig,
  loadCredentials,
  setConfigValue
} from './config.js';
import { ask } from './prompt.js';
import { AnyListService, type ItemView, type PlannedItem, type RecipeView } from './service.js';

const program = new Command();
program
  .name('anylist')
  .description('Manage AnyList shopping lists and recipes from the command line')
  .version('0.1.0')
  .option('--json', 'print machine-readable JSON');

const isJson = (): boolean => Boolean(program.opts().json);

function out(data: unknown, human: () => string): void {
  console.log(isJson() ? JSON.stringify(data, null, 2) : human());
}

/** Wrap a command action so errors become a clean message and exit code 1. */
function action<A extends unknown[]>(fn: (...args: A) => Promise<void>): (...args: A) => Promise<void> {
  return async (...args: A) => {
    try {
      await fn(...args);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isJson()) console.error(JSON.stringify({ error: message }));
      else console.error(`Error: ${message}`);
      process.exitCode = 1;
    }
  };
}

const service = (): AnyListService => new AnyListService(new AnyListClient());

const fmtItem = (i: ItemView): string =>
  `${i.checked ? '[x]' : '[ ]'} ${[i.quantity, i.name].filter(Boolean).join(' ')}${i.details ? ` (${i.details})` : ''}`;

const fmtPlanned = (p: PlannedItem): string =>
  `${[p.quantity.rawQuantity, p.name].filter(Boolean).join(' ')}${p.details ? ` (${p.details})` : ''}`;

function fmtRecipe(r: RecipeView): string {
  const lines = [r.name];
  if (r.servings) lines.push(`Servings: ${r.servings}`);
  if (r.sourceName || r.sourceUrl) lines.push(`Source: ${[r.sourceName, r.sourceUrl].filter(Boolean).join(' ')}`);
  lines.push('', 'Ingredients:');
  for (const ing of r.ingredients) {
    if (ing.isHeading) lines.push('', `  ${ing.name.replace(/:$/, '')}:`);
    else lines.push(`  - ${[ing.quantity, ing.name].filter(Boolean).join(' ')}${ing.note ? ` (${ing.note})` : ''}`);
  }
  if (r.steps.length > 0) {
    lines.push('', 'Steps:');
    r.steps.forEach((s, i) => lines.push(`  ${i + 1}. ${s}`));
  }
  if (r.note) lines.push('', `Notes: ${r.note}`);
  return lines.join('\n');
}

// ---- auth ----
const auth = program.command('auth').description('Manage AnyList credentials');

auth
  .command('login')
  .description('Log in and store tokens')
  .option('--email <email>', 'account email (or ANYLIST_EMAIL)')
  .option('--password <password>', 'account password (or ANYLIST_PASSWORD)')
  .action(
    action(async (opts: { email?: string; password?: string }) => {
      const email = opts.email ?? process.env.ANYLIST_EMAIL ?? (await ask('Email: '));
      const password = opts.password ?? process.env.ANYLIST_PASSWORD ?? (await ask('Password: ', true));
      const client = new AnyListClient({ email, password });
      await client.login(email, password);
      out({ loggedIn: true, email, configDir: configDir() }, () => `Logged in as ${email}.`);
    })
  );

auth
  .command('logout')
  .description('Delete stored credentials')
  .action(
    action(async () => {
      const removed = clearCredentials();
      out({ loggedOut: true, removed }, () => (removed ? 'Logged out.' : 'No stored credentials.'));
    })
  );

auth
  .command('status')
  .description('Show login state')
  .action(
    action(async () => {
      const c = loadCredentials();
      const data = {
        loggedIn: Boolean(c.accessToken),
        email: c.email ?? process.env.ANYLIST_EMAIL ?? null,
        configDir: configDir()
      };
      out(data, () =>
        data.loggedIn ? `Logged in as ${data.email ?? '(unknown)'} (${data.configDir})` : 'Not logged in.'
      );
    })
  );

// ---- config ----
const config = program.command('config').description('Read and write CLI settings');

config
  .command('set <key> <value>')
  .description(`Set a config value (keys: ${CONFIG_KEYS.join(', ')})`)
  .action(
    action(async (key: string, value: string) => {
      setConfigValue(key, value);
      out({ [key]: value }, () => `${key} = ${value}`);
    })
  );

config
  .command('get [key]')
  .description('Show one config value, or all of them')
  .action(
    action(async (key?: string) => {
      const cfg = loadConfig() as Record<string, string | undefined>;
      if (key) {
        if (!(CONFIG_KEYS as readonly string[]).includes(key)) {
          throw new Error(`Unknown config key "${key}". Valid keys: ${CONFIG_KEYS.join(', ')}`);
        }
        out({ [key]: cfg[key] ?? null }, () => cfg[key] ?? '');
      } else {
        out(cfg, () => (Object.keys(cfg).length ? Object.entries(cfg).map(([k, v]) => `${k} = ${v}`).join('\n') : '(no settings)'));
      }
    })
  );

// ---- lists ----
const lists = program.command('lists').description('Shopping lists');

lists
  .command('list')
  .description('List all shopping lists')
  .action(
    action(async () => {
      const all = await service().lists();
      out(
        all.map((l) => ({ id: l.id, name: l.name, items: l.items.length, unchecked: l.items.filter((i) => !i.checked).length })),
        () => all.map((l) => `${l.name}  (${l.items.filter((i) => !i.checked).length} open / ${l.items.length} total)`).join('\n') || 'No lists.'
      );
    })
  );

lists
  .command('show')
  .description('Show the items on a list')
  .option('--list <name>', 'list name (default: config default_list)')
  .action(
    action(async (opts: { list?: string }) => {
      const list = await service().showList(opts.list);
      out(list, () => [list.name, ...list.items.map((i) => `  ${fmtItem(i)}`)].join('\n'));
    })
  );

// ---- items ----
const items = program.command('items').description('Items on a list');

items
  .command('add <text...>')
  .description('Add an item, e.g. `items add 2 cups milk`')
  .option('--list <name>', 'list name (default: config default_list)')
  .action(
    action(async (text: string[], opts: { list?: string }) => {
      const r = await service().addItem(text.join(' '), opts.list);
      out(r, () => `Added to ${r.list}: ${fmtItem(r.item)}`);
    })
  );

items
  .command('remove <name>')
  .description('Remove an item from a list')
  .option('--list <name>', 'list name (default: config default_list)')
  .action(
    action(async (name: string, opts: { list?: string }) => {
      const item = await service().removeItem(name, opts.list);
      out({ removed: item }, () => `Removed: ${item.name}`);
    })
  );

for (const [verb, checked] of [['check', true], ['uncheck', false]] as const) {
  items
    .command(`${verb} <name>`)
    .description(`${checked ? 'Cross off' : 'Restore'} an item`)
    .option('--list <name>', 'list name (default: config default_list)')
    .action(
      action(async (name: string, opts: { list?: string }) => {
        const item = await service().setChecked(name, checked, opts.list);
        out(item, () => `${checked ? 'Checked' : 'Unchecked'}: ${item.name}`);
      })
    );
}

// ---- recipes ----
const recipes = program.command('recipes').description('Recipes');

const summarize = (r: RecipeView) => ({
  id: r.id,
  name: r.name,
  ingredients: r.ingredients.filter((i) => !i.isHeading).length
});

recipes
  .command('list')
  .description('List all recipes')
  .action(
    action(async () => {
      const all = await service().recipes();
      out(all.map(summarize), () => all.map((r) => r.name).join('\n') || 'No recipes.');
    })
  );

recipes
  .command('search <query>')
  .description('Search recipes by name, source or ingredient')
  .action(
    action(async (query: string) => {
      const found = await service().recipes(query);
      out(found.map(summarize), () => found.map((r) => r.name).join('\n') || 'No matching recipes.');
    })
  );

recipes
  .command('show <name>')
  .description('Show a recipe with section headers kept apart from ingredients')
  .action(
    action(async (name: string) => {
      const r = await service().showRecipe(name);
      out(r, () => fmtRecipe(r));
    })
  );

recipes
  .command('missing <name>')
  .description('List recipe ingredients that are not unchecked on the list')
  .option('--list <name>', 'list name (default: config default_list)')
  .action(
    action(async (name: string, opts: { list?: string }) => {
      const plan = await service().missing(name, opts.list);
      out(
        { recipe: plan.recipe.name, list: plan.list, missing: plan.toAdd, alreadyOnList: plan.alreadyOnList },
        () =>
          plan.toAdd.length
            ? `Missing from ${plan.list}:\n${plan.toAdd.map((p) => `  - ${fmtPlanned(p)}`).join('\n')}`
            : `Everything for ${plan.recipe.name} is already on ${plan.list}.`
      );
    })
  );

recipes
  .command('add-to-list <name>')
  .description('Add missing recipe ingredients to a list')
  .option('--list <name>', 'list name (default: config default_list)')
  .option('--dry-run', 'show what would be added without changing anything')
  .action(
    action(async (name: string, opts: { list?: string; dryRun?: boolean }) => {
      const r = await service().addRecipeToList(name, opts.list, Boolean(opts.dryRun));
      out(
        { recipe: r.recipe.name, list: r.list, dryRun: r.dryRun, added: r.toAdd, skipped: r.alreadyOnList },
        () => {
          const verb = r.dryRun ? 'Would add' : 'Added';
          const lines = [
            r.toAdd.length ? `${verb} to ${r.list}:` : `Nothing to add to ${r.list}.`,
            ...r.toAdd.map((p) => `  + ${fmtPlanned(p)}`)
          ];
          if (r.alreadyOnList.length) {
            lines.push('Already on the list:', ...r.alreadyOnList.map((p) => `  = ${fmtPlanned(p)}`));
          }
          return lines.join('\n');
        }
      );
    })
  );

await program.parseAsync(process.argv);
