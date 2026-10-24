/**
 * A counter command marked [I] (API.md §3). The Idempotency-Key lives as long as the
 * intent: a retry after a dropped connection sends the same key with the same body, so a
 * payment is never taken twice (AT-11); a different body is a different intent.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { api, ApiError } from '../../api/client.ts';

export interface Command {
  path: string;
  body?: unknown;
}

export function useCommand<T>(onDone?: (result: T) => void) {
  const client = useQueryClient();
  const intent = useRef<{ key: string; body: string } | null>(null);
  return useMutation({
    mutationFn: (c: Command) => {
      const body = JSON.stringify([c.path, c.body ?? {}]);
      if (intent.current?.body !== body) intent.current = { key: crypto.randomUUID(), body };
      return api<T>(c.path, {
        method: 'POST',
        body: c.body ?? {},
        idempotencyKey: intent.current.key,
      });
    },
    onSuccess: (result) => {
      intent.current = null;
      onDone?.(result);
    },
    onError: (error) => {
      // A definitive answer ends the intent; a lost connection keeps it for the retry.
      if (error instanceof ApiError && error.status > 0) intent.current = null;
    },
    onSettled: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: ['bills'] }),
        client.invalidateQueries({ queryKey: ['bill'] }),
        client.invalidateQueries({ queryKey: ['shift'] }),
        client.invalidateQueries({ queryKey: ['takeaway'] }),
      ]);
    },
  });
}

/** POST /auth/step-up: a manager approves on this device (RBAC.md §1.4). */
export async function approve(input: {
  action: string;
  entityType: string;
  entityId: string;
  username: string;
  pin: string;
  reason: string;
}): Promise<string> {
  const res = await api<{ stepUpId: string }>('/auth/step-up', {
    method: 'POST',
    body: {
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      approverUsername: input.username.trim(),
      approverPin: input.pin,
      reason: input.reason,
    },
  });
  return res.stepUpId;
}
