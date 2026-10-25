/**
 * Input validation: every request body, query and parameter is parsed with a Zod
 * schema before use (SECURITY.md §2.4). Unknown fields are rejected by strict schemas.
 */
import type { z } from 'zod';
import { AppError, fieldsFromZod } from './errors.ts';

export function parseInput<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new AppError('VALIDATION_FAILED', 'Some fields are invalid', {
      fields: fieldsFromZod(result.error),
    });
  }
  return result.data;
}
