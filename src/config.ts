const DEFAULT_PORT = 3000;
const DEFAULT_DATABASE_PATH = "./data/clipapi.sqlite";

export type AppConfig = {
  port: number;
  databasePath: string;
  bootstrapKey: string | undefined;
  nodeEnv: string;
};

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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = env.NODE_ENV ?? "development";
  const databasePath = env.CLIPAPI_DATABASE;
  if ((databasePath === undefined || databasePath === "") && nodeEnv === "production") {
    throw new Error("CLIPAPI_DATABASE is required in production");
  }
  const bootstrapKey = env.CLIPAPI_BOOTSTRAP_KEY;
  return {
    port: parseListenPort(env.PORT),
    databasePath:
      databasePath !== undefined && databasePath !== ""
        ? databasePath
        : DEFAULT_DATABASE_PATH,
    bootstrapKey:
      bootstrapKey !== undefined && bootstrapKey !== "" ? bootstrapKey : undefined,
    nodeEnv,
  };
}
