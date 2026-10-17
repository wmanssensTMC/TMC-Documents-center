// TMC Document Center worker. Runs on Railway (later Azure Container Apps) as a Docker image
// with Node, Python, LibreOffice and Tesseract. It sleeps until the app sends a wake-up call
// (POST /wake) and also checks for work every 30 minutes, so the free database can sleep.
import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { getDb } from "../lib/db";
import { claimNextJob, requeueStaleJobs } from "../lib/jobs/worker-state";
import { getStorage } from "../lib/storage";
import { processNeutraliseJob } from "./process";

const PORT = Number(process.env.PORT ?? 8080);
const SECRET = process.env.WORKER_WAKE_SECRET ?? "";
const SAFETY_CHECK_MS = 30 * 60 * 1000;

let draining = false;
let again = false;

async function drain() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set: the worker waits and processes nothing");
    return;
  }
  if (draining) {
    again = true;
    return;
  }
  draining = true;
  try {
    do {
      again = false;
      const db = await getDb();
      await requeueStaleJobs(db);
      for (let job = await claimNextJob(db); job; job = await claimNextJob(db)) {
        console.log(`job ${job.id} started (${job.kind}, ${job.route})`);
        // Finalise jobs arrive in step 2c.
        if (job.kind === "neutralise") await processNeutraliseJob(db, getStorage(), job);
        console.log(`job ${job.id} finished`);
      }
    } while (again);
  } catch (err) {
    console.error("worker error:", err instanceof Error ? err.message : err);
  } finally {
    draining = false;
  }
}

function authorised(header: string | undefined) {
  if (!SECRET || !header?.startsWith("Bearer ")) return false;
  const a = Buffer.from(header.slice(7));
  const b = Buffer.from(SECRET);
  return a.length === b.length && timingSafeEqual(a, b);
}

if (SECRET.length < 32) {
  console.error("WORKER_WAKE_SECRET must be set (32+ characters)");
  process.exit(1);
}

createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200).end("ok");
  } else if (req.method === "POST" && req.url === "/wake" && authorised(req.headers.authorization)) {
    res.writeHead(202).end("ok");
    void drain();
  } else {
    res.writeHead(404).end();
  }
}).listen(PORT, () => console.log(`worker listening on ${PORT}`));

setInterval(() => void drain(), SAFETY_CHECK_MS);
void drain();
