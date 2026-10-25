/**
 * "Picked up" with a 5-second Undo (UI_UX.md R5-3, AT-92). The device holds the request
 * while the toast shows and sends it only when the toast closes, so Undo simply means
 * nothing is sent: no reversal, and stock counters still only move forward. If the
 * device is offline when the time is up, nothing is sent and the toast says "Not sent".
 * A new tap sends the one still held at once, then holds the new one.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, messageOf } from '../api/client.ts';
import { connection } from '../connection/store.ts';

export const HOLD_MS = 5_000;

interface Held {
  id: number;
  label: string;
  run: () => Promise<unknown>;
}

type Toast =
  { kind: 'held'; label: string } | { kind: 'not_sent'; label: string; detail: string } | null;

export function useHeldAction(onSent?: () => void) {
  const held = useRef<Held | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const counter = useRef(0);
  const [toast, setToast] = useState<Toast>(null);

  const send = useCallback(
    async (action: Held) => {
      if (connection.getSnapshot().status !== 'online') {
        setToast({
          kind: 'not_sent',
          label: action.label,
          detail: 'No connection. It is still waiting for pickup.',
        });
        return;
      }
      try {
        await action.run();
        setToast((t) => (t?.kind === 'held' ? null : t));
        onSent?.();
      } catch (error) {
        const detail =
          error instanceof ApiError && error.code === 'NETWORK_ERROR'
            ? 'No connection. It is still waiting for pickup.'
            : messageOf(error);
        setToast({ kind: 'not_sent', label: action.label, detail });
        onSent?.();
      }
    },
    [onSent],
  );

  const flush = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const action = held.current;
    held.current = null;
    if (action) void send(action);
  }, [send]);

  const hold = useCallback(
    (label: string, run: () => Promise<unknown>) => {
      flush();
      counter.current += 1;
      held.current = { id: counter.current, label, run };
      setToast({ kind: 'held', label });
      timer.current = setTimeout(flush, HOLD_MS);
    },
    [flush],
  );

  const undo = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    held.current = null;
    setToast(null);
  }, []);

  // Leaving the screen sends what is held: the tap was meant.
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      const action = held.current;
      held.current = null;
      if (action && connection.getSnapshot().status === 'online')
        void action.run().catch(() => undefined);
    },
    [],
  );

  return {
    hold,
    undo,
    toast,
    dismiss: () => {
      setToast(null);
    },
  };
}

export function HeldToast({
  toast,
  onUndo,
  onDismiss,
}: {
  toast: Toast;
  onUndo: () => void;
  onDismiss: () => void;
}) {
  if (!toast) return null;
  return (
    <div
      className={toast.kind === 'held' ? 'toast' : 'toast toast-danger'}
      role="status"
      aria-live="polite"
    >
      {toast.kind === 'held' ? (
        <>
          <span>{toast.label}</span>
          <button type="button" className="btn btn-secondary" onClick={onUndo}>
            Undo
          </button>
        </>
      ) : (
        <>
          <span>
            Not sent: {toast.label}. {toast.detail}
          </span>
          <button type="button" className="btn btn-ghost" onClick={onDismiss}>
            Close
          </button>
        </>
      )}
    </div>
  );
}
