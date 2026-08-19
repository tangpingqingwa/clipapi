import { buildApp } from "./app.js";

const DEFAULT_PORT = 3000;

export function parseListenPort(value = process.env.PORT): number {
  if (value === undefined || value === "") {
    return DEFAULT_PORT;
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be an integer 1-65535, got ${JSON.stringify(value)}`);
  }
  return port;
}

const app = await buildApp({ logger: true });
await app.listen({ host: "0.0.0.0", port: parseListenPort() });
