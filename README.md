# vinext-starter

A clean full-stack starter running on
[vinext](https://github.com/cloudflare/vinext), with optional Cloudflare D1 and
Drizzle support.

## Prerequisites

- Node.js `>=22.13.0`

## Quick Start

```bash
npm install
npm run dev
npm run build
```

## Trakt credentials (Windows PowerShell)

Shelfcheck needs a Trakt **Client ID** and **OAuth access token**. The Client
Secret is used only while creating the token and must not be entered into
Shelfcheck, committed to Git, or shared with anyone.

### 1. Create a Trakt application

1. Open [Trakt API Applications](https://trakt.tv/oauth/applications).
2. Create an application and copy its **Client ID** and **Client Secret**.
3. Add this redirect URI:

   ```text
   urn:ietf:wg:oauth:2.0:oob
   ```

4. For local development, add this JavaScript (CORS) origin:

   ```text
   http://localhost:3000
   ```

### 2. Request a device code

Open PowerShell and run:

```powershell
$clientId = Read-Host "Trakt Client ID"

$device = Invoke-RestMethod `
  -Method Post `
  -Uri "https://api.trakt.tv/oauth/device/code" `
  -ContentType "application/json" `
  -Body (@{ client_id = $clientId } | ConvertTo-Json)

$device
```

PowerShell will display a `user_code`. Open
[trakt.tv/activate](https://trakt.tv/activate), enter that code, and approve the
application.

### 3. Exchange the approved code for an access token

After approving the code, run this in the same PowerShell window:

```powershell
$clientSecretSecure = Read-Host "Trakt Client Secret" -AsSecureString
$clientSecret = [System.Net.NetworkCredential]::new("", $clientSecretSecure).Password

$token = Invoke-RestMethod `
  -Method Post `
  -Uri "https://api.trakt.tv/oauth/device/token" `
  -ContentType "application/json" `
  -Body (@{
    code          = $device.device_code
    client_id     = $clientId
    client_secret = $clientSecret
  } | ConvertTo-Json)

$token.access_token
```

Copy the resulting access token. In Shelfcheck settings, enter:

- **Client ID:** the same Client ID used above
- **Access token:** the value printed by `$token.access_token`

The credentials are stored only in that browser's local storage. Never commit
the Client Secret or access token to this repository.

This starter does not use `wrangler.jsonc`.

## Included Shape

- edit site code under `app/`
- `.openai/hosting.json` declares optional Sites D1 and R2 bindings
- `vite.config.ts` simulates declared bindings for local development
- `db/schema.ts` starts intentionally empty
- `examples/d1/` contains an optional D1 example surface
- `drizzle.config.ts` supports local migration generation when needed

## Workspace Auth Headers

Signed-in visitors receive both `oai-authenticated-user-id` and `oai-authenticated-user-email`. Private Sites require every visitor to sign in; public Sites may also have anonymous visitors, for whom neither header is present.

The user ID is stable for the same user on the same Site and different across Sites. Email and name are intended for display or contact purposes.

SIWC-authenticated workspace sites may also receive
`oai-authenticated-user-full-name` when the user's SIWC profile has a non-empty
`name` claim. The full-name value is percent-encoded UTF-8 and is accompanied by
`oai-authenticated-user-full-name-encoding: percent-encoded-utf-8`.

Treat the full name as optional and fall back to email when it is absent:

```tsx
import { headers } from "next/headers";

export default async function Home() {
  const requestHeaders = await headers();
  const userId = requestHeaders.get("oai-authenticated-user-id");
  const email = requestHeaders.get("oai-authenticated-user-email");
  const encodedFullName = requestHeaders.get("oai-authenticated-user-full-name");
  const fullName =
    encodedFullName &&
    requestHeaders.get("oai-authenticated-user-full-name-encoding") ===
      "percent-encoded-utf-8"
      ? decodeURIComponent(encodedFullName)
      : null;

  const displayName = fullName ?? email;
  // ...
}
```

## Optional Dispatch-Owned ChatGPT Sign-In

Import the ready-to-use helpers from `app/chatgpt-auth.ts` when the site needs
optional or required ChatGPT sign-in:

- Use `getChatGPTUser()` for optional signed-in UI.
- Use `requireChatGPTUser(returnTo)` for server-rendered pages that should send
  anonymous visitors through Sign in with ChatGPT.
- Use `chatGPTSignInPath(returnTo)` and `chatGPTSignOutPath(returnTo)` for
  browser links or actions.
- Pass a same-origin relative `returnTo` path for the destination after sign-in
  or sign-out. The helper validates and safely encodes it.
- Mark protected pages with `export const dynamic = "force-dynamic"` because
  they depend on per-request identity headers.

Dispatch owns `/signin-with-chatgpt`, `/signout-with-chatgpt`, `/callback`, the
OAuth cookies, and identity header injection. Do not implement app routes for
those reserved paths. Routes that do not import and call the helper remain
anonymous-compatible.

SIWC establishes identity only; it does not prove workspace membership. Use the
Sites hosting platform's access policy controls for workspace-wide restrictions,
or enforce explicit server-side membership or allowlist checks.

Use SIWC for account pages, user-specific dashboards, saved records, and write
actions tied to the current ChatGPT user. Leave public content anonymous.

## Useful Commands

- `npm run dev`: start local development
- `npm run build`: verify the vinext build output
- `npm test`: build the starter and verify its rendered loading skeleton
- `npm run db:generate`: generate Drizzle migrations after schema changes

## Learn More

- [vinext Documentation](https://github.com/cloudflare/vinext)
- [Drizzle D1 Guide](https://orm.drizzle.team/docs/get-started/d1-new)
