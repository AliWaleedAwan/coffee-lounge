/** Public interface of the reports module (other modules import only from here). */
export { reportRoutes } from './routes.ts';
export { salesKpis, type SalesFilter } from './kpi.ts';
export { runReport, type Report } from './engine.ts';
