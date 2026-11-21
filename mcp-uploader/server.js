import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const {
  PORT = "8080",
  MCP_BEARER_TOKEN,
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  WIZZ_ADMIN_EMAIL,
  WIZZ_ADMIN_PASSWORD,
} = process.env;

for (const [key, value] of Object.entries({ MCP_BEARER_TOKEN, SUPABASE_URL, SUPABASE_ANON_KEY, WIZZ_ADMIN_EMAIL, WIZZ_ADMIN_PASSWORD })) {
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
}
if (MCP_BEARER_TOKEN.length < 32) throw new Error("MCP_BEARER_TOKEN must contain at least 32 characters");

const projectUrl = SUPABASE_URL.replace(/\/$/, "");
const uploadFunctionUrl = `${projectUrl}/functions/v1/wizzcards-upload-card-image`;
let authSession = null;

async function getAdminAccessToken() {
  if (authSession && authSession.expires_at > Date.now() + 60_000) return authSession.access_token;

  const refreshing = authSession?.refresh_token;
  const endpoint = refreshing
    ? `${projectUrl}/auth/v1/token?grant_type=refresh_token`
    : `${projectUrl}/auth/v1/token?grant_type=password`;
  const payload = refreshing
    ? { refresh_token: refreshing }
    : { email: WIZZ_ADMIN_EMAIL, password: WIZZ_ADMIN_PASSWORD };

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY },
    body: JSON.stringify(payload),
  });
  const data = await response.json();
  if (!response.ok) {
    authSession = null;
    throw new Error(`Supabase admin authentication failed: ${data.msg || data.message || response.status}`);
  }
  authSession = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + (data.expires_in || 3600) * 1000,
  };
  return authSession.access_token;
}

function makeServer() {
  const server = new McpServer({ name: "wizzcards-image-uploader", version: "1.0.0" });

  server.tool(
    "upload_wizzcard_image",
    "Upload the original front or back image for an existing WizzCards catalog card to Supabase Storage. Provide the image bytes as base64; never alter the original image.",
    {
      card_id: z.string().uuid(),
      side: z.enum(["front", "back"]),
      filename: z.string().min(1).max(200),
      mime_type: z.enum(["image/jpeg", "image/png", "image/webp"]),
      image_base64: z.string().min(1),
    },
    async ({ card_id, side, filename, mime_type, image_base64 }) => {
      const normalized = image_base64.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, "");
      const bytes = Buffer.from(normalized, "base64");
      if (!bytes.length || bytes.length > 5 * 1024 * 1024) {
        throw new Error("Image must be between 1 byte and 5 MB");
      }
      // Reject malformed base64 instead of silently uploading truncated data.
      if (bytes.toString("base64").replace(/=+$/, "") !== normalized.replace(/=+$/, "")) {
        throw new Error("Invalid base64 image data");
      }

      const token = await getAdminAccessToken();
      const form = new FormData();
      form.append("card_id", card_id);
      form.append("side", side);
      form.append("file", new Blob([bytes], { type: mime_type }), filename);

      const response = await fetch(uploadFunctionUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_ANON_KEY },
        body: form,
      });
      const result = await response.json();
      if (!response.ok || !result.success) {
        throw new Error(result.error || `Supabase upload failed: ${response.status}`);
      }
      return {
        content: [{ type: "text", text: JSON.stringify({
          success: true,
          card_id,
          side,
          storage_path: result.image?.storage_path,
          public_url: result.public_url,
        }) }],
      };
    }
  );

  return server;
}

const app = express();
app.use(express.json({ limit: "8mb" }));
app.all("/mcp", async (req, res) => {
  const supplied = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (supplied.length !== MCP_BEARER_TOKEN.length || supplied !== MCP_BEARER_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const server = makeServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => { void transport.close(); void server.close(); });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    if (!res.headersSent) res.status(500).json({ error: "MCP request failed" });
  }
});

app.get("/health", (_req, res) => res.json({ ok: true, service: "wizzcards-mcp-uploader" }));
app.listen(Number(PORT), "0.0.0.0", () => {
  console.log(`WizzCards MCP uploader listening on port ${PORT}`);
});
