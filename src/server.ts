import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const app = await buildApp({
  logger: true,
  databasePath: config.databasePath,
  bootstrapKey: config.bootstrapKey,
});
await app.listen({ host: "0.0.0.0", port: config.port });
