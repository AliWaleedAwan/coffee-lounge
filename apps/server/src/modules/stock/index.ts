/** Public interface of the stock module (other modules import only from here). */
export { stockAvailability, type StockAvailability } from './availability.ts';
export {
  consume,
  findStockMismatches,
  postOpeningBalance,
  raiseMismatchAlerts,
  raiseStaleReservationAlerts,
  release,
  reserve,
  wasteIngredient,
  WASTE_REASONS,
  holdStock,
  type LineRequirement,
  type LineTakes,
  type StockHold,
  type Shortage,
  type StockContext,
  type StockMismatch,
  type Take,
} from './ledger.ts';
export {
  explodeRecipe,
  issueValue,
  ORDER_TYPES,
  requirement,
  type ModifierRecipeRule,
  type OrderType,
  type RecipeComponent,
} from './math.ts';
export {
  activateRecipe,
  createRecipeDraft,
  loadActiveRecipes,
  loadModifierRules,
  rulesForVariant,
  setStockMode,
  type ComponentInput,
} from './recipes.ts';
export {
  addModifierRule,
  createInventoryItem,
  type InventoryItemInput,
  type ModifierRuleInput,
} from './items.ts';
export {
  addBarcode,
  addPackSize,
  archiveItem,
  createItem,
  deactivateBarcode,
  listItems,
  lookupBarcode,
  readItem,
  updateItem,
  updatePackSize,
  type Barcode,
  type ItemSummary,
  type ItemUpdate,
  type PackSize,
  type ScanMatch,
} from './inventory.ts';
export { stockRoutes } from './routes.ts';
