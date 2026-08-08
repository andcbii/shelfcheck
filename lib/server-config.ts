import "server-only";

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse, stringify } from "yaml";

export type TraktApplication = { clientId: string; clientSecret: string };
export type TraktCredentials = TraktApplication & {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  redirectUri: string;
};

type ShelfcheckConfig = {
  trakt?: {
    client_id?: string;
    client_secret?: string;
    access_token?: string;
    refresh_token?: string;
    expires_at?: number;
    redirect_uri?: string;
  };
};

function configDirectory() {
  return process.env.SHELFCHECK_CONFIG_DIR || path.join(process.cwd(), ".runtime", "config");
}

export function configPath() {
  return path.join(configDirectory(), "config.yml");
}

async function readConfig(): Promise<ShelfcheckConfig> {
  try {
    return (parse(await readFile(configPath(), "utf8")) as ShelfcheckConfig | null) || {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

async function writeConfig(document: ShelfcheckConfig) {
  const directory = configDirectory();
  const target = configPath();
  const temporary = `${target}.tmp`;
  await mkdir(directory, { recursive: true });
  await writeFile(temporary, stringify(document), { encoding: "utf8", mode: 0o600 });
  await rename(temporary, target);
}

export async function readTraktApplication(): Promise<TraktApplication | null> {
  const document = await readConfig();
  const clientId = document.trakt?.client_id?.trim() || "";
  const clientSecret = document.trakt?.client_secret?.trim() || "";
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

export async function readTraktCredentials(): Promise<TraktCredentials | null> {
  const document = await readConfig();
  const application = await readTraktApplication();
  const accessToken = document.trakt?.access_token?.trim() || "";
  const refreshToken = document.trakt?.refresh_token?.trim() || "";
  const expiresAt = Number(document.trakt?.expires_at) || 0;
  const redirectUri = document.trakt?.redirect_uri?.trim() || "";
  return application && accessToken && refreshToken && expiresAt && redirectUri
    ? { ...application, accessToken, refreshToken, expiresAt, redirectUri }
    : null;
}

export async function writeTraktApplication(application: TraktApplication) {
  await writeConfig({ trakt: { client_id: application.clientId, client_secret: application.clientSecret } });
}

export async function writeTraktCredentials(credentials: TraktCredentials) {
  await writeConfig({
    trakt: {
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      access_token: credentials.accessToken,
      refresh_token: credentials.refreshToken,
      expires_at: credentials.expiresAt,
      redirect_uri: credentials.redirectUri,
    },
  });
}

export async function clearTraktAuthorization() {
  const application = await readTraktApplication();
  if (application) await writeTraktApplication(application);
}
