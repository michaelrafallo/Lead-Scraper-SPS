import fs from "node:fs";
import path from "node:path";

import { google } from "googleapis";

const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];

type CredentialsFile = {
  installed?: {
    client_id: string;
    client_secret: string;
    redirect_uris?: string[];
  };
  web?: {
    client_id: string;
    client_secret: string;
    redirect_uris?: string[];
  };
};

function getRepoRootPath() {
  // Next.js runs with CWD = web/ by default. Credentials are kept in repo root.
  return path.resolve(process.cwd(), "..");
}

function getCredentialsPath() {
  return process.env.GOOGLE_OAUTH_CREDENTIALS_PATH
    ? path.resolve(process.env.GOOGLE_OAUTH_CREDENTIALS_PATH)
    : path.join(getRepoRootPath(), "credentials.json");
}

function getTokenPath() {
  return process.env.GOOGLE_OAUTH_TOKEN_PATH
    ? path.resolve(process.env.GOOGLE_OAUTH_TOKEN_PATH)
    : path.join(getRepoRootPath(), "token.json");
}

function getRedirectUriFromEnvOrDefault() {
  if (process.env.GOOGLE_REDIRECT_URI) return process.env.GOOGLE_REDIRECT_URI;
  // Default for local dev (make sure this redirect URI is allowed in Google Cloud).
  return "http://localhost:3000/api/auth/callback";
}

function readClientSecrets(): {
  clientId: string;
  clientSecret: string;
  redirectUris?: string[];
} {
  const credentialsPath = getCredentialsPath();
  const raw = fs.readFileSync(credentialsPath, "utf8");
  const parsed = JSON.parse(raw) as CredentialsFile;

  const block = parsed.installed ?? parsed.web;
  if (!block?.client_id || !block?.client_secret) {
    throw new Error(
      `Invalid credentials file at ${credentialsPath}. Expected 'installed' or 'web' OAuth client.`,
    );
  }

  return {
    clientId: block.client_id,
    clientSecret: block.client_secret,
    redirectUris: block.redirect_uris,
  };
}

export function createOAuthClient() {
  const { clientId, clientSecret, redirectUris } = readClientSecrets();
  void redirectUris; // kept for debugging / future use
  const redirectUri = getRedirectUriFromEnvOrDefault();
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

export function getAuthUrl() {
  const oauth2 = createOAuthClient();
  return oauth2.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent",
  });
}

export function loadOAuthTokenIfExists(oauth2: InstanceType<typeof google.auth.OAuth2>) {
  const tokenPath = getTokenPath();
  if (!fs.existsSync(tokenPath)) return false;
  const tokenJson = fs.readFileSync(tokenPath, "utf8");
  oauth2.setCredentials(JSON.parse(tokenJson));
  return true;
}

export async function exchangeCodeAndStoreToken(code: string) {
  const oauth2 = createOAuthClient();
  const { tokens } = await oauth2.getToken(code);
  oauth2.setCredentials(tokens);

  const tokenPath = getTokenPath();
  fs.writeFileSync(tokenPath, JSON.stringify(tokens, null, 2), "utf8");
  return tokens;
}

export function getAuthorizedGoogleAuthOrAuthUrl(): {
  auth?: InstanceType<typeof google.auth.OAuth2>;
  authUrl?: string;
} {
  const oauth2 = createOAuthClient();
  const ok = loadOAuthTokenIfExists(oauth2);
  if (!ok) return { authUrl: getAuthUrl() };
  return { auth: oauth2 };
}
