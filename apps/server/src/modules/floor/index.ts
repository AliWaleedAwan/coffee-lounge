/** Public interface of the floor module (other modules import only from here). */
export { customerFloorRoutes, type CustomerFloorOptions } from './customer.ts';
export { floorRoutes, type FloorRouteOptions } from './routes.ts';
export {
  guestFromToken,
  lockActiveSession,
  openOrJoinFromQr,
  scanStaleSessions,
  type EntryPoint,
  type GuestContext,
  type SessionRow,
} from './sessions.ts';
export { ENTRY_COOKIE, GUEST_COOKIE } from './tokens.ts';
