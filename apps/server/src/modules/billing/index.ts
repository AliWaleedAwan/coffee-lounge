/** Public interface of the billing module (other modules import only from here). */
export {
  allocate,
  computeBill,
  looksLikeCardNumber,
  type BillLineInput,
  type ComputedBill,
  type DiscountInput,
} from './compute.ts';
export {
  lockBill,
  lockInvoice,
  readBill,
  reopenBill,
  whoOf,
  type BillView,
  type InvoiceRow,
} from './invoices.ts';
export { recordPayments, settle, type PaymentInput } from './payments.ts';
export { assertCashInTill, counterTill, lockOpenShift } from './shifts.ts';
export { billingRoutes, type BillingRouteOptions } from './routes.ts';
