// Recao VPS · conector MCP (Streamable HTTP, sin estado, sin dependencias)
// Da a Claude acceso al servidor: ejecutar comandos y leer/escribir ficheros.
// Escucha solo en 127.0.0.1; Caddy lo publica con HTTPS en mcp.elrecao.com.
// La ruta secreta (/<MCP_SECRET>/mcp) actúa como contraseña.

import http from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const PORT = Number(process.env.MCP_PORT || 8787);
const HOST = process.env.MCP_HOST || "127.0.0.1";
const SECRET = process.env.MCP_SECRET || "";
const MAX_OUTPUT = 100_000; // caracteres por stream
const MAX_BODY = 20 * 1024 * 1024;

if (SECRET.length < 32) {
  console.error("MCP_SECRET ausente o demasiado corto (mínimo 32 caracteres)");
  process.exit(1);
}
const MCP_PATH = `/${SECRET}/mcp`;

const SERVER_INFO = { name: "recao-vps", version: "1.0.0" };
const SUPPORTED = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

// ---------- herramientas ----------
const TOOLS = [
  {
    name: "run_command",
    description:
      "Ejecuta un comando bash en el VPS de Recao (como root) y devuelve stdout, stderr y código de salida. Para procesos largos usa nohup o systemd en vez de esperar.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Comando bash a ejecutar" },
        cwd: { type: "string", description: "Directorio de trabajo (por defecto /root)" },
        timeout_seconds: { type: "number", description: "Límite de tiempo, por defecto 120, máximo 1800" },
      },
      required: ["command"],
    },
  },
  {
    name: "read_file",
    description: "Lee un fichero de texto del VPS. Admite leer por líneas con offset/limit.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Ruta absoluta" },
        offset: { type: "number", description: "Primera línea (1 = inicio)" },
        limit: { type: "number", description: "Número de líneas" },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Crea o sobrescribe un fichero de texto en el VPS (crea los directorios necesarios).",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Ruta absoluta" },
        content: { type: "string", description: "Contenido completo" },
        mode: { type: "string", description: "Permisos octales opcionales, ej. 600 o 755" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_file",
    description:
      "Sustituye un texto exacto por otro dentro de un fichero. old_text debe aparecer una sola vez salvo que replace_all sea true.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_text: { type: "string" },
        new_text: { type: "string" },
        replace_all: { type: "boolean" },
      },
      required: ["path", "old_text", "new_text"],
    },
  },
];

function truncate(s) {
  if (s.length <= MAX_OUTPUT) return s;
  return s.slice(0, MAX_OUTPUT) + `\n…[recortado: ${s.length - MAX_OUTPUT} caracteres más]`;
}

function runCommand({ command, cwd, timeout_seconds }) {
  const timeout = Math.min(Math.max(Number(timeout_seconds) || 120, 1), 1800) * 1000;
  return new Promise((resolve) => {
    const child = spawn("bash", ["-lc", command], {
      cwd: cwd || "/root",
      env: { ...process.env, MCP_SECRET: "" , DEBIAN_FRONTEND: "noninteractive" },
      detached: true,
    });
    let out = "", err = "", killed = false;
    child.stdout.on("data", (d) => { if (out.length < MAX_OUTPUT * 2) out += d; });
    child.stderr.on("data", (d) => { if (err.length < MAX_OUTPUT * 2) err += d; });
    const timer = setTimeout(() => {
      killed = true;
      try { process.kill(-child.pid, "SIGKILL"); } catch {}
    }, timeout);
    child.on("error", (e) => { clearTimeout(timer); resolve({ text: `Error al lanzar: ${e.message}`, isError: true }); });
    child.on("close", (code) => {
      clearTimeout(timer);
      const parts = [`exit_code: ${killed ? "timeout" : code}`];
      if (out) parts.push(`--- stdout ---\n${truncate(out)}`);
      if (err) parts.push(`--- stderr ---\n${truncate(err)}`);
      resolve({ text: parts.join("\n"), isError: killed || code !== 0 });
    });
  });
}

async function readFile({ path: p, offset, limit }) {
  const data = await fs.readFile(p, "utf8");
  if (!offset && !limit) return { text: truncate(data) };
  const lines = data.split("\n");
  const start = Math.max((Number(offset) || 1) - 1, 0);
  const end = limit ? start + Number(limit) : lines.length;
  const slice = lines.slice(start, end).map((l, i) => `${start + i + 1}\t${l}`).join("\n");
  return { text: truncate(`[${lines.length} líneas en total]\n${slice}`) };
}

async function writeFile({ path: p, content, mode }) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, content, "utf8");
  if (mode) await fs.chmod(p, parseInt(mode, 8));
  return { text: `Escrito ${p} (${Buffer.byteLength(content)} bytes)` };
}

async function editFile({ path: p, old_text, new_text, replace_all }) {
  const data = await fs.readFile(p, "utf8");
  const count = data.split(old_text).length - 1;
  if (count === 0) return { text: "old_text no aparece en el fichero", isError: true };
  if (count > 1 && !replace_all)
    return { text: `old_text aparece ${count} veces; amplía el texto o usa replace_all`, isError: true };
  const next = replace_all ? data.split(old_text).join(new_text) : data.replace(old_text, () => new_text);
  await fs.writeFile(p, next, "utf8");
  return { text: `Editado ${p} (${replace_all ? count : 1} sustitución/es)` };
}

const HANDLERS = { run_command: runCommand, read_file: readFile, write_file: writeFile, edit_file: editFile };

async function callTool(params) {
  const fn = HANDLERS[params?.name];
  if (!fn) throw { code: -32602, message: `Herramienta desconocida: ${params?.name}` };
  const args = params.arguments || {};
  for (const req of TOOLS.find((t) => t.name === params.name).inputSchema.required || [])
    if (args[req] === undefined) return { content: [{ type: "text", text: `Falta el argumento ${req}` }], isError: true };
  try {
    const r = await fn(args);
    return { content: [{ type: "text", text: r.text }], isError: !!r.isError };
  } catch (e) {
    return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
  }
}

// ---------- JSON-RPC ----------
async function handleMessage(msg) {
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    if (msg && msg.id !== undefined && msg.method === undefined) return null; // respuesta de cliente
    return { jsonrpc: "2.0", id: msg?.id ?? null, error: { code: -32600, message: "Petición inválida" } };
  }
  const isNotification = msg.id === undefined || msg.id === null;
  try {
    let result;
    switch (msg.method) {
      case "initialize": {
        const asked = msg.params?.protocolVersion;
        result = {
          protocolVersion: SUPPORTED.includes(asked) ? asked : SUPPORTED[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions:
            "Acceso de administración al VPS de Recao (Ubuntu, Hetzner). Ejecutas como root: antes de borrar datos, cambiar el firewall o SSH, o reiniciar servicios en producción, explica el cambio al usuario.",
        };
        break;
      }
      case "ping": result = {}; break;
      case "tools/list": result = { tools: TOOLS }; break;
      case "tools/call": result = await callTool(msg.params); break;
      case "resources/list": result = { resources: [] }; break;
      case "prompts/list": result = { prompts: [] }; break;
      default:
        if (msg.method.startsWith("notifications/")) return null;
        throw { code: -32601, message: `Método no soportado: ${msg.method}` };
    }
    return isNotification ? null : { jsonrpc: "2.0", id: msg.id, result };
  } catch (e) {
    if (isNotification) return null;
    return { jsonrpc: "2.0", id: msg.id, error: { code: e.code || -32603, message: e.message || String(e) } };
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error("too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res, status, obj, extra = {}) {
  const body = obj === undefined ? "" : JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json", ...extra });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/health") return send(res, 200, { ok: true });
  if (url.pathname !== MCP_PATH) return send(res, 404, { error: "not found" });

  if (req.method === "GET" || req.method === "DELETE")
    return send(res, 405, { error: "method not allowed" }, { Allow: "POST" });
  if (req.method !== "POST") return send(res, 405, { error: "method not allowed" }, { Allow: "POST" });

  let payload;
  try { payload = JSON.parse(await readBody(req)); }
  catch { return send(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "JSON inválido" } }); }

  if (Array.isArray(payload)) {
    const out = (await Promise.all(payload.map(handleMessage))).filter(Boolean);
    return out.length ? send(res, 200, out) : (res.writeHead(202), res.end());
  }
  const out = await handleMessage(payload);
  if (!out) { res.writeHead(202); return res.end(); }
  send(res, 200, out);
});

server.requestTimeout = 0;      // los comandos largos no deben cortarse
server.headersTimeout = 60_000;
server.listen(PORT, HOST, () => console.log(`recao-vps MCP en ${HOST}:${PORT}`));
