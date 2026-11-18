# WizzCards MCP image uploader

This service exposes an authenticated Streamable HTTP MCP endpoint at `/mcp` and a health check at `/health`. It forwards original image bytes to the existing `wizzcards-upload-card-image` Supabase Edge Function. It does not put images in GitHub.

## Required environment variables

- `PORT` (optional; defaults to 8080)
- `MCP_BEARER_TOKEN`: random secret of at least 32 characters. Configure the same value as the MCP connector's bearer token.
- `SUPABASE_URL`: project URL.
- `SUPABASE_ANON_KEY`: publishable/anon key (not service_role).
- `WIZZ_ADMIN_EMAIL`: dedicated Supabase Auth admin account email, allow-listed in `public.wizz_admins`.
- `WIZZ_ADMIN_PASSWORD`: password for that dedicated account. Store only in the hosting provider's encrypted secret manager; never commit it or share it in chat.

The service signs in to Supabase Auth and refreshes its session server-side. The existing Edge Function verifies the JWT and checks `wizz_admins` before writing to Storage.

## Deploy

Deploy this directory as a Docker web service on a host that supports persistent environment secrets and HTTPS. Set the variables above. The service listens on `0.0.0.0:8080` by default.

After deployment, verify `https://YOUR-HOST/health` returns `{"ok":true,...}`. Register the MCP server URL `https://YOUR-HOST/mcp` in a ChatGPT custom connector, using HTTP Bearer authentication with `MCP_BEARER_TOKEN`.

## Tool

`upload_wizzcard_image` accepts:
- `card_id` (existing card UUID)
- `side` (`front` or `back`)
- `filename`
- `mime_type` (`image/jpeg`, `image/png`, or `image/webp`)
- `image_base64` (original file bytes, base64 encoded)

Maximum image size is 5 MB, matching the existing bucket/function limit. The tool returns the Storage path and public URL after the Edge Function confirms success.

## Security notes

- Never use or expose the Supabase `service_role` key in this service.
- Use a dedicated admin account, not a personal account, and rotate its password if compromised.
- Restrict access to the MCP endpoint with a long random bearer token and HTTPS.
- Do not add secrets to GitHub, Docker image layers, logs, or this README.
- The existing Edge Function remains the final authorization gate and validates the admin allow-list.
