/** Public interface of the expenses module (other modules import only from here). */
export { expenseRoutes } from './routes.ts';
export { listExpenses, readExpense } from './service.ts';
