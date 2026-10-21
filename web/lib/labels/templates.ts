// Label templates and the form fields (safe in the browser). The worker maps a template id to
// its file in engine/assets through this list only; a path never comes from the database.
import { LABEL_LANGUAGES } from "../constants";

export type LabelTemplate = { id: string; name: string; file: string; sample: boolean };

/** A sample template is for trying the flow: its labels can never become Final. */
export const LABEL_TEMPLATES: LabelTemplate[] = [
  { id: "sample", name: "SAMPLE template (not for use)", file: "TMC_LABEL_SAMPLE.docx", sample: true },
];

export const labelTemplate = (id: string) => LABEL_TEMPLATES.find((t) => t.id === id) ?? null;

/** Form values besides product name, file nr and batch (engine/scripts/make_label.py FIELDS). */
export const LABEL_FIELDS = [
  { key: "productionDate", label: "Production date", kind: "date" },
  { key: "expiryDate", label: "Expiry date", kind: "date" },
  { key: "netWeight", label: "Net weight (kg), also in the file name", kind: "number" },
  { key: "grossWeight", label: "Gross weight (kg)", kind: "number" },
] as const;

export type LabelFieldKey = (typeof LABEL_FIELDS)[number]["key"];

export { LABEL_LANGUAGES };
