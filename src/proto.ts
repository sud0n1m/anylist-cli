import protobuf from 'protobufjs';

/**
 * Subset of AnyList's wire schema that this CLI needs: reading the user-data
 * snapshot (lists + recipes) and writing list operations.
 * Field numbers come from observing the service's protobuf messages.
 */
const SCHEMA = `
syntax = "proto2";
package anylist;

message PBItemQuantity {
  optional string amount = 1;
  optional string unit = 2;
  optional string rawQuantity = 3;
}

message ListItem {
  required string identifier = 1;
  optional double serverModTime = 2;
  optional string listId = 3;
  optional string name = 4;
  optional string details = 5;
  optional bool checked = 6;
  optional string recipeId = 7;
  optional string rawIngredient = 8;
  optional string category = 11;
  optional string userId = 12;
  optional string categoryMatchId = 13;
  optional PBItemQuantity quantityPb = 21;
  optional int32 manualSortIndex = 17;
  optional string deprecatedQuantity = 18;
}

message ShoppingList {
  required string identifier = 1;
  optional double timestamp = 2;
  optional string name = 3;
  repeated ListItem items = 4;
  optional string creator = 5;
}

message ShoppingListsResponse {
  repeated ShoppingList newLists = 1;
  repeated ShoppingList modifiedLists = 2;
}

message PBIngredient {
  optional string identifier = 6;
  optional string rawIngredient = 1;
  optional string name = 2;
  optional string quantity = 3;
  optional string note = 4;
  optional bool isHeading = 7;
}

message PBRecipe {
  required string identifier = 1;
  optional double timestamp = 2;
  optional string name = 3;
  optional string note = 5;
  optional string sourceName = 6;
  optional string sourceUrl = 7;
  repeated PBIngredient ingredients = 8;
  repeated string preparationSteps = 9;
  optional string servings = 20;
}

message PBRecipeDataResponse {
  repeated PBRecipe recipes = 3;
}

message PBUserDataResponse {
  optional ShoppingListsResponse shoppingListsResponse = 1;
  optional PBRecipeDataResponse recipeDataResponse = 3;
}

message PBOperationMetadata {
  optional string operationId = 1;
  optional string handlerId = 2;
  optional string userId = 3;
}

message PBListOperation {
  optional PBOperationMetadata metadata = 1;
  optional string listId = 2;
  optional string listItemId = 3;
  optional string updatedValue = 4;
  optional string originalValue = 5;
  optional ListItem listItem = 6;
}

message PBListOperationList {
  repeated PBListOperation operations = 1;
}
`;

const root = protobuf.parse(SCHEMA).root;

export const UserDataResponse = root.lookupType('anylist.PBUserDataResponse');
export const ListOperationList = root.lookupType('anylist.PBListOperationList');

export interface WireQuantity {
  amount?: string;
  unit?: string;
  rawQuantity?: string;
}

export interface WireListItem {
  identifier: string;
  listId?: string;
  name?: string;
  details?: string;
  checked?: boolean;
  recipeId?: string;
  rawIngredient?: string;
  userId?: string;
  quantityPb?: WireQuantity;
  deprecatedQuantity?: string;
}

export interface WireShoppingList {
  identifier: string;
  name?: string;
  items?: WireListItem[];
  creator?: string;
}

export interface WireIngredient {
  identifier?: string;
  rawIngredient?: string;
  name?: string;
  quantity?: string;
  note?: string;
  isHeading?: boolean;
}

export interface WireRecipe {
  identifier: string;
  name?: string;
  note?: string;
  sourceName?: string;
  sourceUrl?: string;
  servings?: string;
  ingredients?: WireIngredient[];
  preparationSteps?: string[];
}

export interface WireUserData {
  shoppingListsResponse?: { newLists?: WireShoppingList[]; modifiedLists?: WireShoppingList[] };
  recipeDataResponse?: { recipes?: WireRecipe[] };
}

export interface WireOperation {
  metadata: { operationId: string; handlerId: string; userId?: string };
  listId: string;
  listItemId?: string;
  updatedValue?: string;
  listItem?: WireListItem;
}

export function decodeUserData(bytes: Uint8Array): WireUserData {
  const message = UserDataResponse.decode(bytes);
  return UserDataResponse.toObject(message, { defaults: false, arrays: true }) as WireUserData;
}

export function encodeOperations(operations: WireOperation[]): Uint8Array {
  const payload = { operations };
  const problem = ListOperationList.verify(payload);
  if (problem) throw new Error(`Invalid list operation: ${problem}`);
  return ListOperationList.encode(ListOperationList.fromObject(payload)).finish();
}
