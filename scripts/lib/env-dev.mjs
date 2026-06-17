import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";

export function parseDotenvDev(content, env = {}) {
  for (const [key, value] of Object.entries(parseEnv(content))) {
    if (env[key] === undefined) env[key] = value;
  }
  return env;
}

export function loadDotenvDev({ cwd = process.cwd(), env = process.env } = {}) {
  const file = resolve(cwd, ".env.dev");
  if (!existsSync(file)) return;
  parseDotenvDev(readFileSync(file, "utf8"), env);
}

export function defaultWebUrl(env = process.env) {
  return (optionalEnv(env.COSHEAF_WEB_URL) ?? `http://localhost:${serverPort(env)}`).replace(/\/+$/, "");
}

export function defaultApiUrl(env = process.env) {
  return optionalEnv(env.COSHEAF_API_URL) ?? new URL("/api/v1", defaultWebUrl(env)).toString();
}

export function defaultServerUrl(env = process.env) {
  return optionalEnv(env.COSHEAF_SERVER_URL) ?? `http://localhost:${serverPort(env)}`;
}

export function defaultViteUrl(env = process.env) {
  return viteOrigin(env.COSHEAF_VITE_ORIGIN) ?? (viteUrlFromWebUrl(env) ?? `http://localhost:${vitePort(env)}`).replace(/\/+$/, "");
}

function viteUrlFromWebUrl(env) {
  const webUrl = optionalEnv(env.COSHEAF_WEB_URL);
  if (!webUrl) return null;
  try {
    const url = new URL(webUrl);
    if (url.protocol !== "http:") return null;
    url.port = vitePort(env);
    url.pathname = "/";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch (_err) {
    return null;
  }
}

function optionalEnv(value) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function viteOrigin(value) {
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

export function serverPort(env = process.env) {
  return envPort(env.COSHEAF_PORT, "COSHEAF_PORT", "3030");
}

export function vitePort(env = process.env) {
  return envPort(env.COSHEAF_VITE_PORT, "COSHEAF_VITE_PORT", "5173");
}

function envPort(value, name, fallback) {
  const port = optionalEnv(value) ?? fallback;
  if (!/^\d+$/.test(port) || Number(port) > 65535) {
    throw new Error(`${name} must be an integer TCP port`);
  }
  return port;
}
