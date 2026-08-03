import "server-only";

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse, stringify } from "yaml";

export type TraktCredentials = {
  clientId: string;
  accessToken: string;
};

type ShelfcheckConfig = {
  trakt?: {
    client_id?: string;
    access_token?: string;
  };
};

function configDirectory() {
  return process.env.SHELFCHECK_CONFIG_DIR || path.join(process.cwd(), ".runtime", "config");
}

export function configPath() {
  return path.join(configDirectory(), "config.yml");
}

export async function readTraktCredentials(): Promise<TraktCredentials | null> {
  try {
    const document = parse(await readFile(configPath(), "utf8")) as ShelfcheckConfig | null;
    const clientId = document?.trakt?.client_id?.trim() || "";
    const accessToken = document?.trakt?.access_token?.trim() || "";
    return clientId && accessToken ? { clientId, accessToken } : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function writeTraktCredentials(credentials: TraktCredentials) {
  const directory = configDirectory();
  const target = configPath();
  const temporary = `${target}.tmp`;
  await mkdir(directory, { recursive: true });
  await writeFile(temporary, stringify({
    trakt: {
      client_id: credentials.clientId,
      access_token: credentials.accessToken,
    },
  }), { encoding: "utf8", mode: 0o600 });
  await rename(temporary, target);
}
