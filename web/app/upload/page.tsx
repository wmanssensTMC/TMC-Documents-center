import { PageShell } from "@/components/app-header";
import { requireUser } from "@/lib/auth";
import { getStorage } from "@/lib/storage";
import { UploadForm } from "./upload-form";

export const metadata = { title: "Upload · TMC Document Center" };

export default async function UploadPage() {
  const user = await requireUser();
  return (
    <PageShell user={user}>
      <h1 className="text-xl font-semibold text-tmc">Upload a finished TMC document</h1>
      <p className="mt-1 text-sm text-gray-600">
        The file name is made from the details below, exactly like the neutralizer does. Uploading a document that
        already exists saves a new version; the old one stays available.
      </p>
      <p className="mt-1 text-sm font-medium text-amber-800">Test documents only, until the pilot is approved for real documents.</p>
      <UploadForm uploadMode={getStorage().mode} />
    </PageShell>
  );
}
