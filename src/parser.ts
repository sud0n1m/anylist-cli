/**
 * Ingredient / item text parser.
 *
 * AnyList's server does not interpret free text, so the client has to split
 * "2 cups milk" into a name, a quantity and some details before sending it.
 */

export interface ParsedQuantity {
  /** Numeric amount as a plain decimal string ("1.5"), or "" when absent. */
  amount: string;
  /** Unit as written by the user ("cups", "tbsp"), or "". */
  unit: string;
  /** The quantity text as written ("1 1/2 tbsp"), or "". */
  rawQuantity: string;
}

export interface ParsedIngredient {
  name: string;
  quantity: ParsedQuantity;
  details: string;
}

const VULGAR_FRACTIONS: Record<string, number> = {
  '¼': 0.25,
  '½': 0.5,
  '¾': 0.75,
  '⅓': 1 / 3,
  '⅔': 2 / 3,
  '⅕': 0.2,
  '⅖': 0.4,
  '⅗': 0.6,
  '⅘': 0.8,
  '⅙': 1 / 6,
  '⅚': 5 / 6,
  '⅛': 0.125,
  '⅜': 0.375,
  '⅝': 0.625,
  '⅞': 0.875
};

const NUMBER_WORDS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  half: 0.5
};

// "a"/"an" only count as a quantity when a unit follows, so that
// "a pinch of salt" parses but "a banana" falls back to the whole string.
const WEAK_NUMBER_WORDS = new Set(['a', 'an']);

const UNITS = new Set([
  'tsp', 'tsps', 'teaspoon', 'teaspoons',
  'tbsp', 'tbsps', 'tbs', 'tablespoon', 'tablespoons',
  'cup', 'cups', 'c',
  'oz', 'ounce', 'ounces',
  'lb', 'lbs', 'pound', 'pounds',
  'g', 'gram', 'grams', 'kg', 'kilogram', 'kilograms', 'mg',
  'ml', 'milliliter', 'milliliters', 'millilitre', 'millilitres',
  'l', 'liter', 'liters', 'litre', 'litres',
  'pt', 'pint', 'pints', 'qt', 'quart', 'quarts', 'gal', 'gallon', 'gallons',
  'fl',
  'pinch', 'pinches', 'dash', 'dashes', 'splash', 'handful', 'handfuls', 'dozen',
  'clove', 'cloves',
  'can', 'cans', 'jar', 'jars', 'bottle', 'bottles', 'box', 'boxes',
  'bag', 'bags', 'package', 'packages', 'pkg', 'packet', 'packets',
  'bunch', 'bunches', 'head', 'heads', 'stalk', 'stalks', 'sprig', 'sprigs',
  'slice', 'slices', 'piece', 'pieces', 'stick', 'sticks', 'sheet', 'sheets',
  'loaf', 'loaves', 'container', 'containers', 'carton', 'cartons'
]);

const FRACTION_CLASS = Object.keys(VULGAR_FRACTIONS).join('');

// "1 1/2", "1½", "½", "1/2", "2.5", "2" — optionally a range: "2-3", "2 to 3".
const NUMBER = `(?:\\d+[${FRACTION_CLASS}]|[${FRACTION_CLASS}]|\\d+\\s+\\d+\\/\\d+|\\d+\\/\\d+|\\d*\\.\\d+|\\d+)`;
const LEADING_QUANTITY = new RegExp(`^(${NUMBER})(?:\\s*(?:-|–|to)\\s*(?:${NUMBER}))?(?![\\d/.])`, 'i');

function round(n: number): string {
  const s = n.toFixed(4);
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
}

/** Convert a single numeric token ("1 1/2", "½", "1½", "0.5") to a number. */
export function parseNumber(token: string): number | null {
  const t = token.trim();
  if (!t) return null;

  let m = new RegExp(`^(\\d+)\\s*([${FRACTION_CLASS}])$`).exec(t);
  if (m) return Number(m[1]) + VULGAR_FRACTIONS[m[2]];

  if (t in VULGAR_FRACTIONS) return VULGAR_FRACTIONS[t];

  m = /^(\d+)\s+(\d+)\/(\d+)$/.exec(t);
  if (m) return Number(m[3]) === 0 ? null : Number(m[1]) + Number(m[2]) / Number(m[3]);

  m = /^(\d+)\/(\d+)$/.exec(t);
  if (m) return Number(m[2]) === 0 ? null : Number(m[1]) / Number(m[2]);

  if (/^(\d+\.?\d*|\.\d+)$/.test(t)) return Number(t);
  return null;
}

function isUnit(word: string): boolean {
  return UNITS.has(word.toLowerCase().replace(/\.$/, ''));
}

function emptyQuantity(): ParsedQuantity {
  return { amount: '', unit: '', rawQuantity: '' };
}

/** Strip a leading quantity (number or number word, plus optional unit). */
function takeQuantity(text: string): { quantity: ParsedQuantity; rest: string } | null {
  const input = text.trim();
  let amount: number;
  let rest: string;

  const numeric = LEADING_QUANTITY.exec(input);
  if (numeric) {
    const value = parseNumber(numeric[1]);
    if (value === null) return null;
    amount = value;
    rest = input.slice(numeric[0].length);
  } else {
    const word = /^([a-z]+)\b/i.exec(input);
    const key = word?.[1].toLowerCase();
    if (!word || !key || !(key in NUMBER_WORDS)) return null;
    rest = input.slice(word[0].length);
    if (key === 'half') rest = rest.replace(/^\s+a\s+/i, ' ');
    if (WEAK_NUMBER_WORDS.has(key) && !isUnit(/^\s*([a-z.]+)/i.exec(rest)?.[1] ?? '')) return null;
    amount = NUMBER_WORDS[key];
  }

  let unit = '';
  const unitMatch = /^\s*([A-Za-z]+\.?)(?=\s|$)/.exec(rest);
  if (unitMatch && isUnit(unitMatch[1])) {
    unit = unitMatch[1].replace(/\.$/, '');
    rest = rest.slice(unitMatch[0].length);
    // "8 fl oz milk"
    const oz = unit.toLowerCase() === 'fl' ? /^\s*(oz\.?)(?=\s|$)/i.exec(rest) : null;
    if (oz) {
      unit = `${unit} ${oz[1].replace(/\.$/, '')}`;
      rest = rest.slice(oz[0].length);
    }
  } else if (/^[^\s]/.test(rest)) {
    // Quantity glued to a non-unit word ("7up", "one-pot"): not a quantity.
    return null;
  }

  const rawQuantity = input.slice(0, input.length - rest.length).trim();
  rest = rest.replace(/^\s+/, '').replace(/^of\s+/i, '');

  return { quantity: { amount: round(amount), unit, rawQuantity }, rest };
}

/** Pull "(...)" groups and a trailing ", ..." clause out of the text. */
function splitDetails(text: string): { head: string; details: string[] } {
  const details: string[] = [];
  let head = text.replace(/\(([^()]*)\)/g, (_m, inner: string) => {
    const t = inner.trim();
    if (t) details.push(t);
    return ' ';
  });
  const comma = head.indexOf(',');
  if (comma >= 0) {
    const tail = head.slice(comma + 1).trim();
    if (tail) details.push(tail);
    head = head.slice(0, comma);
  }
  return { head: head.replace(/\s+/g, ' ').trim(), details };
}

/**
 * Parse only the quantity at the start of a string such as "1 1/2 cups".
 * Returns null when the text does not start with a quantity.
 */
export function parseQuantity(text: string): ParsedQuantity | null {
  return takeQuantity(text ?? '')?.quantity ?? null;
}

/**
 * Parse free text such as "2 large eggs, beaten" into name, quantity and
 * details. If the text cannot be understood, the whole string becomes the name.
 */
export function parseIngredient(text: string): ParsedIngredient {
  const original = (text ?? '').trim();
  const fallback: ParsedIngredient = { name: original, quantity: emptyQuantity(), details: '' };
  if (!original) return fallback;

  // Details come out first so commas and parentheses never leak into the name.
  const { head, details } = splitDetails(original);
  const q = takeQuantity(head);

  if (!q) {
    if (head && details.length > 0) {
      return { name: head, quantity: emptyQuantity(), details: details.join('; ') };
    }
    return fallback;
  }

  const name = q.rest.replace(/\s+/g, ' ').trim();
  if (!name) return fallback;

  return { name, quantity: q.quantity, details: details.join('; ') };
}
