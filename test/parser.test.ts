import { describe, expect, it } from 'vitest';
import { parseIngredient, parseNumber, parseQuantity } from '../src/parser.js';

describe('parseIngredient', () => {
  it('parses integer, unit and name', () => {
    expect(parseIngredient('2 cups milk')).toEqual({
      name: 'milk',
      quantity: { amount: '2', unit: 'cups', rawQuantity: '2 cups' },
      details: ''
    });
  });

  it('parses mixed fractions', () => {
    expect(parseIngredient('1 1/2 tbsp sugar')).toEqual({
      name: 'sugar',
      quantity: { amount: '1.5', unit: 'tbsp', rawQuantity: '1 1/2 tbsp' },
      details: ''
    });
  });

  it('parses unicode fractions', () => {
    expect(parseIngredient('½ cup oil')).toEqual({
      name: 'oil',
      quantity: { amount: '0.5', unit: 'cup', rawQuantity: '½ cup' },
      details: ''
    });
  });

  it('parses number words and drops "of"', () => {
    expect(parseIngredient('one ounce of cheese')).toEqual({
      name: 'cheese',
      quantity: { amount: '1', unit: 'ounce', rawQuantity: 'one ounce' },
      details: ''
    });
  });

  it('moves a trailing comma clause into details', () => {
    expect(parseIngredient('2 large eggs, beaten')).toEqual({
      name: 'large eggs',
      quantity: { amount: '2', unit: '', rawQuantity: '2' },
      details: 'beaten'
    });
  });

  it('moves parentheticals into details', () => {
    expect(parseIngredient('3 cloves garlic (minced)')).toEqual({
      name: 'garlic',
      quantity: { amount: '3', unit: 'cloves', rawQuantity: '3 cloves' },
      details: 'minced'
    });
  });

  it('combines parenthetical and comma details', () => {
    const r = parseIngredient('1 cup flour (sifted), plus more for dusting');
    expect(r.name).toBe('flour');
    expect(r.details).toBe('sifted; plus more for dusting');
  });

  it('parses simple fractions', () => {
    const r = parseIngredient('3/4 tsp salt');
    expect(r.quantity).toEqual({ amount: '0.75', unit: 'tsp', rawQuantity: '3/4 tsp' });
    expect(r.name).toBe('salt');
  });

  it('parses decimals', () => {
    const r = parseIngredient('2.5 lb potatoes');
    expect(r.quantity.amount).toBe('2.5');
    expect(r.quantity.unit).toBe('lb');
    expect(r.name).toBe('potatoes');
  });

  it('parses a number attached to a vulgar fraction', () => {
    const r = parseIngredient('1½ cups water');
    expect(r.quantity).toEqual({ amount: '1.5', unit: 'cups', rawQuantity: '1½ cups' });
    expect(r.name).toBe('water');
  });

  it('parses thirds as a rounded decimal', () => {
    expect(parseIngredient('⅓ cup honey').quantity.amount).toBe('0.3333');
  });

  it('keeps ranges in rawQuantity and uses the lower bound as amount', () => {
    const r = parseIngredient('2-3 tbsp butter');
    expect(r.quantity).toEqual({ amount: '2', unit: 'tbsp', rawQuantity: '2-3 tbsp' });
    expect(r.name).toBe('butter');
  });

  it('handles "to" ranges', () => {
    const r = parseIngredient('1 to 2 cups stock');
    expect(r.quantity.rawQuantity).toBe('1 to 2 cups');
    expect(r.name).toBe('stock');
  });

  it('does not mistake a word starting with "to" for a range', () => {
    const r = parseIngredient('2 tomatoes');
    expect(r.name).toBe('tomatoes');
    expect(r.quantity).toEqual({ amount: '2', unit: '', rawQuantity: '2' });
  });

  it('parses "a pinch of"', () => {
    const r = parseIngredient('a pinch of salt');
    expect(r.name).toBe('salt');
    expect(r.quantity).toEqual({ amount: '1', unit: 'pinch', rawQuantity: 'a pinch' });
  });

  it('parses "half a cup"', () => {
    const r = parseIngredient('half a cup sugar');
    expect(r.name).toBe('sugar');
    expect(r.quantity.amount).toBe('0.5');
    expect(r.quantity.unit).toBe('cup');
  });

  it('parses two-word number words', () => {
    const r = parseIngredient('two cans black beans');
    expect(r.name).toBe('black beans');
    expect(r.quantity).toEqual({ amount: '2', unit: 'cans', rawQuantity: 'two cans' });
  });

  it('handles fl oz as a single unit', () => {
    const r = parseIngredient('8 fl oz cream');
    expect(r.quantity.unit).toBe('fl oz');
    expect(r.name).toBe('cream');
  });

  it('accepts units with a trailing period', () => {
    const r = parseIngredient('2 tbsp. olive oil');
    expect(r.quantity.unit).toBe('tbsp');
    expect(r.name).toBe('olive oil');
  });

  it('is case-insensitive for units', () => {
    const r = parseIngredient('2 Tbsp Butter');
    expect(r.quantity.unit).toBe('Tbsp');
    expect(r.name).toBe('Butter');
  });

  it('trims and collapses whitespace', () => {
    const r = parseIngredient('   2   cups    milk  ');
    expect(r.name).toBe('milk');
    expect(r.quantity.rawQuantity).toBe('2 cups');
  });

  it('uses the whole string as name when there is no quantity', () => {
    expect(parseIngredient('milk')).toEqual({
      name: 'milk',
      quantity: { amount: '', unit: '', rawQuantity: '' },
      details: ''
    });
  });

  it('does not treat "a banana" as a quantity', () => {
    expect(parseIngredient('a banana').name).toBe('a banana');
  });

  it('falls back to the whole string when nothing follows the quantity', () => {
    const r = parseIngredient('2 cups');
    expect(r.name).toBe('2 cups');
    expect(r.quantity.amount).toBe('');
  });

  it('keeps details for text without a quantity', () => {
    const r = parseIngredient('fresh basil (torn)');
    expect(r.name).toBe('fresh basil');
    expect(r.details).toBe('torn');
    expect(r.quantity.amount).toBe('');
  });

  it('handles empty input', () => {
    expect(parseIngredient('   ').name).toBe('');
  });

  it('does not split names that merely start with a digit-like token', () => {
    expect(parseIngredient('7up').name).toBe('7up');
  });
});

describe('parseNumber', () => {
  it.each([
    ['1', 1],
    ['0.25', 0.25],
    ['.5', 0.5],
    ['1/4', 0.25],
    ['2 1/2', 2.5],
    ['¾', 0.75],
    ['2¼', 2.25]
  ])('parses %s', (input, expected) => {
    expect(parseNumber(input)).toBeCloseTo(expected);
  });

  it('rejects garbage and zero denominators', () => {
    expect(parseNumber('abc')).toBeNull();
    expect(parseNumber('1/0')).toBeNull();
    expect(parseNumber('')).toBeNull();
  });
});

describe('parseQuantity', () => {
  it('parses a structured recipe quantity', () => {
    expect(parseQuantity('1 1/2 cups')).toEqual({ amount: '1.5', unit: 'cups', rawQuantity: '1 1/2 cups' });
  });

  it('returns null when there is no quantity', () => {
    expect(parseQuantity('to taste')).toBeNull();
  });
});
