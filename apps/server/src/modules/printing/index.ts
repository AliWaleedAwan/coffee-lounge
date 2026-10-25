/** Public interface of the printing module (other modules import only from here). */
export {
  renderKitchenTicket,
  renderReceipt,
  renderShiftReport,
  renderTestPage,
  type KitchenTicketData,
  type PrintOptions,
  type ReceiptData,
  type ShiftReportData,
} from './documents.ts';
export {
  dispatchPrinter,
  requestPrint,
  stationPrinter,
  sweepPrinters,
  type DispatchDeps,
  type DocumentType,
} from './jobs.ts';
export { printingRoutes, type PrintingRouteOptions } from './routes.ts';
export {
  defaultTransports,
  spoolerTransport,
  tcpTransport,
  type PrinterTarget,
  type SendResult,
  type Transport,
} from './transports.ts';
