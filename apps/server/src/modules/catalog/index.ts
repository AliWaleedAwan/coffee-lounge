/** Public interface of the catalogue module (other modules import only from here). */
export { catalogRoutes, type CatalogRouteOptions } from './routes.ts';
export {
  checkModifierSelection,
  describeModifierProblem,
  type ModifierGroupRule,
} from './modifiers.ts';
export { bestPromotion, localMoment, type PromotionRule } from './promotions.ts';
export {
  createCategory,
  createItem,
  createModifierGroup,
  loadPromotionRules,
  readMenu,
  type Who,
} from './service.ts';
