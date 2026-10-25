/** Request schemas shared by the staff and customer round routes. */
import { z } from 'zod';

const id = z.string().regex(/^\d{1,18}$/, 'must be a numeric id');

export const lineSchema = z
  .object({
    variantId: id,
    qty: z.number().int().min(1).max(20),
    modifierOptionIds: z.array(id).max(20).default([]),
    notes: z.string().max(400).optional(),
    quotedUnitPrice: z
      .string()
      .regex(/^\d{1,9}(\.\d{1,2})?$/)
      .optional(),
  })
  .strict();

export const linesSchema = z.array(lineSchema).min(1).max(30);
