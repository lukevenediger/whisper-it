import { app, startupSweep, DATA_DIR, COMMIT_INFO, telegram } from "./app";

const PORT = process.env.PORT || 3000;

startupSweep();

const server = app.listen(PORT, () => {
  console.log(`Whisper-It running at http://localhost:${PORT}`);
  console.log(`Data dir: ${DATA_DIR}`);
  console.log(`Version: ${COMMIT_INFO.COMMIT_SHORT} (${COMMIT_INFO.COMMIT})`);
  telegram?.start().catch((err) => console.error("[telegram] start failed:", err));
});

let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] ${signal} received, shutting down`);
  const forceExit = setTimeout(() => process.exit(1), 10_000);
  forceExit.unref();
  try {
    await telegram?.stop();
  } finally {
    server.close(() => process.exit(0));
  }
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
