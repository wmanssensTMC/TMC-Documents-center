// Validation of what the upload form sends. Everything from the browser is untrusted.
import { z } from "zod";
import { ENTITIES } from "../db/schema";
import { NAMED_TYPES } from "../naming";

const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine((s) => !/[\u0000-\u001f\u007f]/.test(s), "contains control characters");

const optionalText = (max: number) =>
  text(max)
    .optional()
    .transform((s) => (s ? s : null));

const isoDate = z
  .string()
  .trim()
  .optional()
  .transform((s) => (s ? s : null))
  .refine((s) => s === null || (/^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`))), {
    message: "invalid date",
  });

const fileRef = z.object({ key: z.string().max(200), filename: z.string().max(300) });

export const documentInput = z.object({
  type: z.enum(NAMED_TYPES),
  entity: z.enum(ENTITIES),
  productName: text(200).min(1, "product name is required"),
  fileNr: optionalText(50),
  batch: optionalText(100),
  inciName: optionalText(300),
  casNumber: optionalText(100),
  poNumber: optionalText(100),
  language: text(10).default("EN").transform((s) => s.toUpperCase() || "EN"),
  manufacturingDate: isoDate,
  expiryOrRetestDate: isoDate,
  supplierName: optionalText(200),
  tags: z.array(text(40).min(1)).max(10).default([]),
  files: z.object({ pdf: fileRef, docx: fileRef.optional(), source: fileRef.optional() }),
});

export type DocumentInput = z.input<typeof documentInput>;
export type ValidDocumentInput = z.output<typeof documentInput>;
