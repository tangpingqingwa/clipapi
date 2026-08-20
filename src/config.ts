const DEFAULT_PORT = 3000;
const DEFAULT_DATABASE_PATH = "./data/clipapi.sqlite";

export type AppConfig = {
  port: number;
  databasePath: string;
  bootstrapKey: string | undefined;
  nodeEnv: string;
  fixtureOnly: boolean;
  liveTikTok: boolean;
};

/** BUILD env flags are `"1"` to enable; anything else is off. */
export function isEnvFlagEnabled(value: string | undefined): boolean {
  return value === "1";
}

/**
 * Live public-TikTok adapter. CLIPAPI_FIXTURE_ONLY=1 always wins so CI/test.sh
 * stay offline even if CLIPAPI_LIVE leaks into the environment.
 */
export function shouldUseLiveTikTok(env: NodeJS.ProcessEnv = process.env): boolean {
  if (isEnvFlagEnabled(env.CLIPAPI_FIXTURE_ONLY)) {
    return false;
  }
  return isEnvFlagEnabled(env.CLIPAPI_LIVE);
}

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
  const fixtureOnly = isEnvFlagEnabled(env.CLIPAPI_FIXTURE_ONLY);
  return {
    port: parseListenPort(env.PORT),
    databasePath:
      databasePath !== undefined && databasePath !== ""
        ? databasePath
        : DEFAULT_DATABASE_PATH,
    bootstrapKey:
      bootstrapKey !== undefined && bootstrapKey !== "" ? bootstrapKey : undefined,
    nodeEnv,
    fixtureOnly,
    liveTikTok: shouldUseLiveTikTok(env),
  };
}
