"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Reloads the page data every few seconds while jobs are still waiting or running. */
export function AutoRefresh({ seconds }: { seconds: number }) {
  const router = useRouter();
  useEffect(() => {
    const t = setInterval(() => router.refresh(), seconds * 1000);
    return () => clearInterval(t);
  }, [router, seconds]);
  return <p className="mt-2 text-xs text-gray-500">This page updates itself while jobs are running.</p>;
}
