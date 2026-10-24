/** Public interface of the orders module (other modules import only from here). */
export { scanUncollected } from './alerts.ts';
export { customerOrderRoutes, type CustomerOrderOptions } from './customer.ts';
export { requireOwnTable, type StaffAuth } from './lines.ts';
export { cleanNotes, priceLines, type LineInput } from './pricing.ts';
export {
  acceptRound,
  escalateOverdue,
  expireUnpaidTakeaways,
  mayDecide,
  rejectRound,
  submitRound,
  withdrawRound,
  type CommandContext,
  type Submitter,
} from './rounds.ts';
export { commandContext, orderRoutes, type OrderRouteOptions } from './routes.ts';
export { approvals, sessionRounds } from './views.ts';
