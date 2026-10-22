// Labels (phase 3): a person fills the form, the worker makes Word + PDF with the engine
// (engine/scripts/make_label.py). The label is a LABEL document in the library: checked and
// approved like any other document, never Final by itself, never Final from a sample template.
import "server-only";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { logAudit, type Actor } from "../audit";
import type { Db } from "../db";
import { documents, ENTITIES, jobs, type Document } from "../db/schema";
import { getEntity } from "../entities";
import { countOpenJobs, MAX_OPEN_JOBS_PER_USER, wakeWorker } from "../jobs";
import { LABEL_FIELDS, LABEL_LANGUAGES, labelTemplate, type LabelTemplate } from "./templates";

export class LabelError extends Error {}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine((s) => !/[\u0000-\u001f\u007f\u2028\u2029\p{Cf}]/u.test(s), "contains control characters")
    .refine((s) => !s.startsWith("-"), 'cannot start with "-"')
    // the template's own placeholders look like {{batch}}: a typed one is refused, not filled in
    .refine((s) => !s.includes("{{") && !s.includes("}}"), "cannot contain {{ or }}");

const optional = (schema: z.ZodType<string>) => z.union([z.literal(""), schema]).optional().default("");
const isoDate = z.iso.date("use a date (yyyy-mm-dd)");
const weight = z
  .string()
  .trim()
  .transform((s) => s.replace(",", "."))
  .pipe(z.string().regex(/^\d{1,7}(\.\d{1,3})?$/, "use a number in kg, e.g. 25 or 25.5"));

export const labelInput = z.object({
  template: z.string().refine((id) => !!labelTemplate(id), "unknown label template"),
  language: z.enum(LABEL_LANGUAGES),
  entity: z.enum(ENTITIES),
  productName: text(200).min(1, "product name is required"),
  batch: text(100).min(1, "batch is required"),
  fileNr: optional(text(50)),
  productionDate: optional(isoDate),
  expiryDate: optional(isoDate),
  netWeight: optional(weight),
  grossWeight: optional(weight),
});

export type LabelInput = z.input<typeof labelInput>;

/** Files one label job. Supplier name stays empty: a label never takes it from the library. */
export async function createLabelJob(db: Db, actor: Actor, raw: unknown): Promise<string> {
  const r = labelInput.safeParse(raw);
  if (!r.success) throw new LabelError(r.error.issues.map((i) => `${i.path.join(".") || "form"}: ${i.message}`).join("; "));
  const input = r.data;
  if ((await countOpenJobs(db, actor.email)) >= MAX_OPEN_JOBS_PER_USER) {
    throw new LabelError(`you already have many documents waiting; wait until fewer than ${MAX_OPEN_JOBS_PER_USER} are open`);
  }
  // Never invent an entity's address: no record, no label.
  if (!(await getEntity(db, input.entity))) {
    throw new LabelError(`no details entered yet for entity ${input.entity}; an admin adds them under Settings > Entities`);
  }
  const fields: Record<string, string> = {};
  for (const f of LABEL_FIELDS) if (input[f.key]) fields[f.key] = input[f.key];
  const id = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(jobs)
      .values({
        kind: "label",
        entity: input.entity,
        productName: input.productName,
        fileNr: input.fileNr || null,
        batch: input.batch,
        supplierName: null,
        label: { template: input.template, language: input.language, fields, sample: labelTemplate(input.template)!.sample },
        createdBy: actor.email,
      })
      .returning({ id: jobs.id });
    await logAudit(tx, actor, "job.created", null, { job: row.id, kind: "label", template: input.template, language: input.language });
    return row.id;
  });
  await wakeWorker();
  return id;
}

/** The template a label document was made with (null: unknown, treated as not approvable). */
export async function templateOfLabel(db: Db | Tx, doc: Pick<Document, "jobId">): Promise<(LabelTemplate & { madeAsSample: boolean }) | null> {
  if (!doc.jobId) return null;
  const [job] = await db.select({ label: jobs.label }).from(jobs).where(eq(jobs.id, doc.jobId));
  if (!job?.label) return null;
  const t = labelTemplate(job.label.template);
  return t ? { ...t, madeAsSample: job.label.sample !== false } : null;
}

/** Labels from a sample (or unknown) template never become Final: a sample when it was made, or now. */
export async function assertLabelApprovable(db: Db | Tx, doc: Pick<Document, "type" | "jobId">, onRefuse: (msg: string) => Error) {
  if (doc.type !== "LABEL") return;
  const t = await templateOfLabel(db, doc);
  if (!t || t.sample || t.madeAsSample) {
    throw onRefuse("this label was made with the SAMPLE template and can never become Final; Kars' real template replaces it");
  }
}

/** Final COAs to start a label from: the values a label can take from them (never the supplier). */
export async function finalCoas(db: Db, limit = 300) {
  return db
    .select({
      id: documents.id,
      name: documents.name,
      entity: documents.entity,
      productName: documents.productName,
      fileNr: documents.fileNr,
      batch: documents.batch,
      manufacturingDate: documents.manufacturingDate,
      expiryOrRetestDate: documents.expiryOrRetestDate,
    })
    .from(documents)
    .where(and(eq(documents.type, "COA"), eq(documents.status, "Final")))
    .orderBy(desc(documents.createdAt))
    .limit(limit);
}
