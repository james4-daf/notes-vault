export interface Env {
  VAULT: R2Bucket;
  VAULT_TOKEN: string;
}

const MANIFEST_KEY = "vault/manifest.bin";
const SALT_KEY = "vault/salt.bin";
const NOTE_PREFIX = "vault/notes/";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return cors(new Response(null, { status: 204 }));
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (path === "/health" && request.method === "GET") {
      return cors(json({ ok: true }));
    }

    if (!authorized(request, env)) {
      return cors(json({ error: "unauthorized" }, 401));
    }

    try {

      if (path === "/salt") {
        if (request.method === "GET") return cors(await getObject(env, SALT_KEY));
        if (request.method === "PUT") return cors(await putObject(env, SALT_KEY, request));
      }

      if (path === "/manifest") {
        if (request.method === "GET") return cors(await getObject(env, MANIFEST_KEY));
        if (request.method === "PUT") return cors(await putObject(env, MANIFEST_KEY, request));
      }

      const noteMatch = path.match(/^\/notes\/([a-f0-9]{64})$/);
      if (noteMatch) {
        const key = `${NOTE_PREFIX}${noteMatch[1]}.bin`;
        if (request.method === "GET") return cors(await getObject(env, key));
        if (request.method === "PUT") return cors(await putObject(env, key, request));
        if (request.method === "DELETE") {
          await env.VAULT.delete(key);
          return cors(new Response(null, { status: 204 }));
        }
      }

      return cors(json({ error: "not found" }, 404));
    } catch (error) {
      const message = error instanceof Error ? error.message : "server error";
      return cors(json({ error: message }, 500));
    }
  },
};

function authorized(request: Request, env: Env): boolean {
  const expected = env.VAULT_TOKEN;
  if (!expected) return false;
  const header = request.headers.get("Authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return !!match && timingSafeEqual(match[1], expected);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i += 1) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

async function getObject(env: Env, key: string): Promise<Response> {
  const obj = await env.VAULT.get(key);
  if (!obj) return new Response(null, { status: 404 });
  const bytes = await obj.arrayBuffer();
  return new Response(bytes, {
    status: 200,
    headers: {
      "Content-Type": "application/octet-stream",
      "Cache-Control": "no-store",
    },
  });
}

async function putObject(env: Env, key: string, request: Request): Promise<Response> {
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength === 0) {
    return json({ error: "empty body" }, 400);
  }
  if (bytes.byteLength > 8 * 1024 * 1024) {
    return json({ error: "too large" }, 413);
  }
  await env.VAULT.put(key, bytes);
  return new Response(null, { status: 204 });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function cors(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET, PUT, DELETE, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
  headers.set("Access-Control-Max-Age", "86400");
  return new Response(response.body, { status: response.status, headers });
}
