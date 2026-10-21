/** Public interface of the billing module (other modules import only from here). */
export {
  allocate,
  computeBill,
  looksLikeCardNumber,
  type BillLineInput,
  type ComputedBill,
  type DiscountInput,
} from './compute.ts';
export { readBill, type BillView } from './invoices.ts';
export { billingRoutes, type BillingRouteOptions } from './routes.ts';
