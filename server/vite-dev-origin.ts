export function viteDevOrigin(env: NodeJS.ProcessEnv = process.env): string {
  return (viteOrigin(env.COSHEAF_VITE_ORIGIN) ?? viteOriginFromWebUrl(env) ?? `http://localhost:${vitePort(env)}`).replace(/\/+$/, "");
}

function viteOriginFromWebUrl(env: NodeJS.ProcessEnv): string | null {
  const webUrl = optionalEnv(env.COSHEAF_WEB_URL);
  if (!webUrl) return null;
  const port = vitePort(env);
  try {
    const url = new URL(webUrl);
    if (url.protocol !== "http:") return null;
    url.port = port;
    url.pathname = "/";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch (_err) {
    return null;
  }
}

function optionalEnv(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function viteOrigin(value: string | undefined): string | null {
  const origin = optionalEnv(value);
  if (!origin) return null;
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
    return url.origin;
  } catch (_err) {
    throw new Error("COSHEAF_VITE_ORIGIN must be a valid http(s) URL origin");
  }
}

function vitePort(env: NodeJS.ProcessEnv): string {
  const port = optionalEnv(env.COSHEAF_VITE_PORT) ?? "5173";
  if (!/^\d+$/.test(port) || Number(port) > 65535) {
    throw new Error("COSHEAF_VITE_PORT must be an integer TCP port");
  }
  return port;
}
