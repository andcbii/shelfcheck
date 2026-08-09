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

export type PlexProviders = {
  plexUrl: string;
  plexToken: string;
  tmdbToken: string;
  tvdbApiKey: string;
  tvdbPin?: string;
};
export type PlexProviderPatch = { [Key in keyof PlexProviders]?: PlexProviders[Key] | null };
export type PlexProviderStatus = {
  plexUrl: string;
  plexTokenSaved: boolean;
  tmdbTokenSaved: boolean;
  tvdbApiKeySaved: boolean;
  tvdbPinSaved: boolean;
  configured: boolean;
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
  plex?: { url?: string; token?: string };
  tmdb?: { token?: string };
  tvdb?: { api_key?: string; pin?: string };
};

function configDirectory() {
  return process.env.SHELFCHECK_CONFIG_DIR || path.join(process.cwd(), ".runtime", "config");
}

function configPath() {
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
  const document = await readConfig();
  await writeConfig({ ...document, trakt: { client_id: application.clientId, client_secret: application.clientSecret } });
}

export async function writeTraktCredentials(credentials: TraktCredentials) {
  const document = await readConfig();
  await writeConfig({ ...document,
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

export async function readPlexProviders(): Promise<PlexProviders | null> {
  const document = await readConfig();
  const plexUrl = document.plex?.url?.trim().replace(/\/$/, "") || "";
  const plexToken = document.plex?.token?.trim() || "";
  const tmdbToken = document.tmdb?.token?.trim() || "";
  const tvdbApiKey = document.tvdb?.api_key?.trim() || "";
  const tvdbPin = document.tvdb?.pin?.trim() || undefined;
  return plexUrl && plexToken && tmdbToken && tvdbApiKey
    ? { plexUrl, plexToken, tmdbToken, tvdbApiKey, ...(tvdbPin ? { tvdbPin } : {}) }
    : null;
}

export async function readPlexProviderStatus(): Promise<PlexProviderStatus> {
  const document = await readConfig();
  const plexUrl = document.plex?.url?.trim() || "";
  const plexTokenSaved = Boolean(document.plex?.token?.trim());
  const tmdbTokenSaved = Boolean(document.tmdb?.token?.trim());
  const tvdbApiKeySaved = Boolean(document.tvdb?.api_key?.trim());
  const tvdbPinSaved = Boolean(document.tvdb?.pin?.trim());
  return { plexUrl, plexTokenSaved, tmdbTokenSaved, tvdbApiKeySaved, tvdbPinSaved, configured: Boolean(plexUrl && plexTokenSaved && tmdbTokenSaved && tvdbApiKeySaved) };
}

export async function writePlexProviders(credentials: PlexProviderPatch) {
  const document = await readConfig();
  const plexUrl = credentials.plexUrl === null ? null : credentials.plexUrl?.replace(/\/$/, "");
  const has = (key: keyof PlexProviderPatch) => Object.prototype.hasOwnProperty.call(credentials, key);
  await writeConfig({
    ...document,
    ...(has("plexUrl") || has("plexToken") ? { plex: {
      ...document.plex,
      ...(has("plexUrl") ? { url: plexUrl || undefined } : {}),
      ...(has("plexToken") ? { token: credentials.plexToken || undefined } : {}),
    } } : {}),
    ...(has("tmdbToken") ? { tmdb: { ...document.tmdb, token: credentials.tmdbToken || undefined } } : {}),
    ...(has("tvdbApiKey") || has("tvdbPin") ? { tvdb: {
      ...document.tvdb,
      ...(has("tvdbApiKey") ? { api_key: credentials.tvdbApiKey || undefined } : {}),
      ...(has("tvdbPin") ? { pin: credentials.tvdbPin || undefined } : {}),
    } } : {}),
  });
}

export async function clearTraktAuthorization() {
  const application = await readTraktApplication();
  if (application) await writeTraktApplication(application);
}
