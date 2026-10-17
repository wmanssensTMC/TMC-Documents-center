// Success / error line from a ?ok= or ?error= query parameter. React escapes the text.
export function Notice({ ok, error }: { ok?: string | string[]; error?: string | string[] }) {
  const text = (v?: string | string[]) => (Array.isArray(v) ? v[0] : v)?.slice(0, 300);
  if (error)
    return (
      <p role="alert" className="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 ring-1 ring-red-200">
        {text(error)}
      </p>
    );
  if (ok)
    return (
      <p role="status" className="mt-4 rounded-md bg-green-50 px-3 py-2 text-sm text-green-800 ring-1 ring-green-200">
        {text(ok)}
      </p>
    );
  return null;
}
