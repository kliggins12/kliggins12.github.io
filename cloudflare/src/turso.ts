import { createClient, type Client } from "@libsql/client/web";

export interface TursoEnv {
  TURSO_DATABASE_URL?: string;
  TURSO_AUTH_TOKEN?: string;
}

let client: Client | null = null;
let clientKey = "";

export function getTursoClient(env: TursoEnv): Client {
  if (!env.TURSO_DATABASE_URL || !env.TURSO_AUTH_TOKEN) {
    throw new Error("Turso is not configured. Set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN.");
  }
  const key = env.TURSO_DATABASE_URL;
  if (!client || clientKey !== key) {
    client = createClient({
      url: env.TURSO_DATABASE_URL,
      authToken: env.TURSO_AUTH_TOKEN
    });
    clientKey = key;
  }
  return client;
}

export async function checkTurso(env: TursoEnv): Promise<{ ok: boolean }> {
  const db = getTursoClient(env);
  await db.execute("SELECT 1 AS ok");
  return { ok: true };
}
