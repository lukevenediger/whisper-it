import { app, startupSweep, DATA_DIR, COMMIT_INFO } from "./app";

const PORT = process.env.PORT || 3000;

startupSweep();

app.listen(PORT, () => {
  console.log(`Whisper-It running at http://localhost:${PORT}`);
  console.log(`Data dir: ${DATA_DIR}`);
  console.log(`Version: ${COMMIT_INFO.COMMIT_SHORT} (${COMMIT_INFO.COMMIT})`);
});
