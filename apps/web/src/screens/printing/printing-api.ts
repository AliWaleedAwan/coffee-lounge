/** Printer status and print jobs for the staff app (API.md §5.7, PRINTING_HARDWARE.md §6). */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type RequestOptions } from '../../api/client.ts';

export interface PrinterStatus {
  kitchenPrinterMissing: boolean;
  printers: {
    id: string;
    name: string;
    state: 'ok' | 'retrying' | 'needs_attention';
    openJobs: number;
    uncertain: number;
    lastError: string | null;
  }[];
}

export interface PrintJob {
  id: string;
  printer: string;
  document: string;
  documentType: string;
  copyNo: number;
  status: 'queued' | 'sending' | 'retrying' | 'needs_attention' | 'uncertain';
  attempts: number;
  lastError: string | null;
  createdAt: string;
}

export interface ManagedPrinter {
  id: string;
  name: string;
  connection: 'spooler' | 'tcp';
  address: string;
  paperWidthMm: 58 | 80;
  charsPerLine: number;
  supportsStatus: boolean;
  canCut: boolean;
  isActive: boolean;
  version: number;
}

const TOPICS = { topics: ['printers'] } as const;

/** Every signed-in device shows the printer banner; it also refreshes on its own. */
export function usePrinterStatus(enabled: boolean) {
  return useQuery({
    queryKey: ['printers', 'status'],
    queryFn: ({ signal }) => api<PrinterStatus>('/printers/status', { signal }),
    meta: TOPICS,
    enabled,
    // Staff without the printers topic still see a paper-out within half a minute.
    refetchInterval: 30_000,
  });
}

export function usePrintJobs() {
  return useQuery({
    queryKey: ['printers', 'jobs'],
    queryFn: ({ signal }) => api<{ items: PrintJob[] }>('/print-jobs?status=open', { signal }),
    meta: TOPICS,
  });
}

export function useManagedPrinters() {
  return useQuery({
    queryKey: ['printers', 'manage'],
    queryFn: ({ signal }) =>
      api<{
        items: ManagedPrinter[];
        stations: { id: string; name: string; printerId: string | null }[];
      }>('/printers', { signal }),
    meta: TOPICS,
  });
}

export function usePrintWrite<T = unknown>(onDone?: (result: T) => void) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (w: { path: string; method?: RequestOptions['method']; body?: unknown }) =>
      api<T>(w.path, { method: w.method ?? 'POST', body: w.body ?? {} }),
    onSuccess: (r) => {
      onDone?.(r);
    },
    onSettled: () => client.invalidateQueries({ queryKey: ['printers'] }),
  });
}
