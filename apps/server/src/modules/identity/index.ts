/** Public interface of the identity module (other modules import only from here). */
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { registerStaffAuth } from './http.ts';
import { identityRoutes } from './routes.ts';

export { authOf, deviceOf, factsOf, setSessionCookie, type AccessConfig } from './http.ts';
export type { Grant, Scope, EffectivePermissions } from './permissions.ts';
export { loadEffectivePermissions } from './permissions.ts';
export {
  consumeStepUp,
  createOwner,
  createRegistrationCode,
  DEVICE_KINDS,
  type DeviceKind,
  recoverOwner,
  sessionStillValid,
  startDemoSession,
  STEP_UP_ACTIONS,
  type AuthContext,
  type DeviceInfo,
  type StepUpAction,
} from './service.ts';

export interface StaffIdentityOptions {
  pool: pg.Pool;
  secureCookies: boolean;
}

/**
 * Installs staff authentication (cookies, device/session/permission checks, CSRF) and
 * the identity routes. Call first inside the staff API scope; routes registered later
 * in the same scope are protected too.
 */
export async function registerStaffIdentity(
  app: FastifyInstance,
  options: StaffIdentityOptions,
): Promise<void> {
  await registerStaffAuth(app, options);
  await identityRoutes(app, options);
}
