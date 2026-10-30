/** Public interface of the mail module (other modules import only from here). */
export { mailRoutes } from './routes.ts';
export { type MailDeps } from './account.ts';
export { sendDue } from './deliveries.ts';
export { scanSchedules } from './schedules.ts';
