/** Public interface of the floor module (other modules import only from here). */
export {
  customerFloorRoutes,
  resolveEntry,
  setGuestCookie,
  type CustomerFloorOptions,
} from './customer.ts';
export { floorRoutes, type FloorRouteOptions } from './routes.ts';
export {
  expireSession,
  guestFromToken,
  lockActiveSession,
  openOrJoinFromQr,
  openTakeawaySession,
  scanStaleSessions,
  setCheckoutLocked,
  settleSession,
  type EntryPoint,
  type GuestContext,
  type SessionRow,
} from './sessions.ts';
export { ENTRY_COOKIE, GUEST_COOKIE, GUEST_TTL_SECONDS, looksLikeToken } from './tokens.ts';
