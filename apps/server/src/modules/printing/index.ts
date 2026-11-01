/** Public interface of the printing module (other modules import only from here). */
export {
  renderDayEnd,
  renderKitchenTicket,
  renderReceipt,
  renderShiftReport,
  renderTestPage,
  shopTime,
  type DayEndPrintData,
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
export {
  previewReceipt,
  readReceiptDesign,
  receiptLayout,
  saveReceiptDesign,
} from './receipt-design.ts';
