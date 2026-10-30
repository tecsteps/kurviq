// Starts the scenes server and the excalidraw dev server together and
// restarts either one if it crashes (e.g. Vite occasionally dies while
// restarting after a config change), so agents never lose the scenes server.
import { spawn } from "node:child_process";

const SCRIPTS = ["start:server", "start:app"];
let stopping = false;
const procs = new Map();

const start = (script) => {
  const proc = spawn("npm", ["run", "--silent", script], { stdio: "inherit" });
  procs.set(script, proc);
  proc.on("exit", (code, signal) => {
    if (stopping) {
      return;
    }
    console.error(
      `[start] ${script} exited (${signal || code}), restarting in 1s…`,
    );
    setTimeout(() => !stopping && start(script), 1000);
  });
};

const stop = () => {
  stopping = true;
  procs.forEach((proc) => proc.kill());
  setTimeout(() => process.exit(0), 500);
};

SCRIPTS.forEach(start);
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
