import { spawn } from "node:child_process";

// Vite builds the initial static asset directory needed by local Wrangler.
const build = spawn("npm", ["exec", "vite", "build"], { stdio: "inherit" });
build.on("exit", (code) => {
  if (code) process.exit(code);
  const children = [
    spawn("npm", ["run", "dev:worker"], { stdio: "inherit" }),
    spawn("npm", ["run", "dev:client"], { stdio: "inherit" }),
  ];
  const stop = () => children.forEach((child) => child.kill("SIGTERM"));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  children.forEach((child) => child.on("exit", stop));
});
