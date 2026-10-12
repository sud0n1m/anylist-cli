# anylist-cli

A command-line tool and MCP server for [AnyList](https://www.anylist.com): read and edit your shopping lists, browse recipes, and add a recipe's missing ingredients to a list.

It ships two binaries:

- `anylist` — the CLI
- `anylist-mcp` — an MCP server (stdio by default, optional streamable HTTP) so assistants like Claude can use your lists

AnyList has no official public API. This project talks to the same HTTP endpoints the AnyList web app uses, so it may break if AnyList changes them. It is not affiliated with AnyList.

## Install

Requires Node.js 20 or newer.

```sh
# straight from git
npm i -g git+https://github.com/<your-account>/anylist-cli.git

# or clone and build
git clone https://github.com/<your-account>/anylist-cli.git
cd anylist-cli
npm install
npm run build
npm link        # puts `anylist` and `anylist-mcp` on your PATH
```

## Configuration

Files live in `$ANYLIST_CONFIG_DIR`, or `~/.config/anylist-cli/` if that is unset. The directory is created with mode `0700` and every file in it with mode `0600`.

| File | Contents |
| --- | --- |
| `credentials.json` | email, password, client id, access/refresh tokens |
| `config.json` | settings such as `default_list` |

The password is stored (in plain text, protected only by file permissions) so the CLI can sign in again when the refresh token expires. Run `anylist auth logout` to delete it.

Environment variables:

| Variable | Purpose |
| --- | --- |
| `ANYLIST_EMAIL` | account email (e.g. `you@example.com`) |
| `ANYLIST_PASSWORD` | account password |
| `ANYLIST_CONFIG_DIR` | where to keep config and credentials |

Settings:

```sh
anylist config set default_list Groceries
anylist config get                 # all settings
anylist config get default_list
```

Every command that takes `--list <name>` falls back to `default_list`. If neither is set and you have exactly one list, that list is used.

## Usage

Add `--json` to any command for machine-readable output.

```sh
# authentication
anylist auth login                              # prompts for email and password
anylist auth login --email you@example.com --password '…'
anylist auth status
anylist auth logout

# lists
anylist lists list
anylist lists show --list Groceries

# items (text is parsed: "2 cups milk" -> quantity 2 cups, name milk)
anylist items add 2 cups milk --list Groceries
anylist items add "2 large eggs, beaten"
anylist items check milk
anylist items uncheck milk
anylist items remove milk

# recipes
anylist recipes list
anylist recipes search chili
anylist recipes show "Overnight Beans"          # section headers are shown apart from ingredients
anylist recipes missing "Overnight Beans" --list Groceries
anylist recipes add-to-list "Overnight Beans" --dry-run
anylist recipes add-to-list "Overnight Beans" --list Groceries
```

Names match case-insensitively; an exact match wins, otherwise a unique partial match is used and an ambiguous one is an error.

### Recipes and the shopping list

- Recipe ingredients flagged as headings (such as "Soak overnight") are reported as section headers, never as ingredients, and are never added to a list.
- `recipes missing` and `recipes add-to-list` compare ingredient names with the **unchecked** items on the list (ignoring case, punctuation and a trailing plural "s"). Ingredients that are already there are skipped; checked-off items count as not present.

### Ingredient parsing

AnyList's server does not parse text, so `src/parser.ts` splits it before sending:

| Input | name | amount | unit | details |
| --- | --- | --- | --- | --- |
| `2 cups milk` | milk | 2 | cups | |
| `1 1/2 tbsp sugar` | sugar | 1.5 | tbsp | |
| `½ cup oil` | oil | 0.5 | cup | |
| `one ounce of cheese` | cheese | 1 | ounce | |
| `2 large eggs, beaten` | large eggs | 2 | | beaten |
| `3 cloves garlic (minced)` | garlic | 3 | cloves | minced |

Items are sent with `name`, `quantityPb {amount, unit, rawQuantity}`, `details` and `rawIngredient` set to your original text. If the text can't be parsed, the whole string becomes the name.

## MCP server

```sh
anylist-mcp                    # stdio
anylist-mcp --http --port 3000 # streamable HTTP at http://127.0.0.1:3000/mcp
```

The HTTP mode listens on localhost only and has no authentication of its own; don't expose it to a network you don't trust.

Log in once with `anylist auth login` (or provide `ANYLIST_EMAIL` / `ANYLIST_PASSWORD` in the server's environment).

Tools: `lists_list`, `lists_show`, `items_add`, `items_remove`, `items_check`, `items_uncheck`, `recipes_list`, `recipes_search`, `recipes_show`, `recipes_missing`, `recipes_add_to_list`.

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "anylist": {
      "command": "anylist-mcp",
      "env": {
        "ANYLIST_EMAIL": "you@example.com",
        "ANYLIST_PASSWORD": "your-password"
      }
    }
  }
}
```

If you've already run `anylist auth login`, the `env` block can be omitted. If you built from a clone without `npm link`, use `"command": "node"` with `"args": ["/path/to/anylist-cli/dist/mcp.js"]`.

### Claude Code

```sh
claude mcp add anylist -- anylist-mcp
```

or in `.mcp.json`:

```json
{
  "mcpServers": {
    "anylist": {
      "command": "anylist-mcp",
      "args": []
    }
  }
}
```

## Development

```sh
npm install
npm run build   # tsc -> dist/
npm test        # vitest
```

## License

MIT © 2026 Colin Nederkoorn
