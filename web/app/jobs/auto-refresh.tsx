"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { refreshStep } from "@/lib/refresh";

/** Reloads the page data while jobs are still waiting or running: every few seconds at first,
 * every 30 seconds after two minutes, never while the tab is in the background, and not at all
 * after half an hour (a job waiting that long needs a person, and it saves the free Vercel
 * allowance; 26/10/2026, first live run). */
export function AutoRefresh({ seconds }: { seconds: number }) {
  const router = useRouter();
  const [stopped, setStopped] = useState(false);
  useEffect(() => {
    const start = Date.now();
    let t: ReturnType<typeof setTimeout>;
    const tick = () => {
      const step = refreshStep(Date.now() - start, seconds, document.visibilityState === "visible");
      if (!step) return setStopped(true);
      if (step.refresh) router.refresh();
      t = setTimeout(tick, step.nextMs);
    };
    t = setTimeout(tick, seconds * 1000);
    return () => clearTimeout(t);
  }, [router, seconds]);
  return (
    <p className="mt-2 text-xs text-gray-500">
      {stopped ? "This page stopped updating itself. Reload it to see new results." : "This page updates itself while jobs are running."}
    </p>
  );
}
