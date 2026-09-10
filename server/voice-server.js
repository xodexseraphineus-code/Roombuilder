// Local backend for the app's voice-command feature. Runs the `claude` CLI
// as a subprocess, so interpretation is billed against whatever the CLI is
// already logged into (a Pro/Max subscription or an API key) instead of the
// browser needing its own Anthropic API key.
//
// Run alongside the dev server: `npm run voice-server`, with `claude` logged
// in on this machine. The frontend calls this over HTTP -- see askClaude()
// in src/RoomBuilder.jsx.
import { createServer } from "node:http";
import { execFile } from "node:child_process";

const PORT = process.env.VOICE_SERVER_PORT || 8787;
const ALLOWED_ORIGIN = process.env.VOICE_SERVER_ORIGIN || "http://localhost:5173";
const MAX_BODY_BYTES = 1_000_000;

// The voice feature only needs a text-in/text-out classification, so every
// tool is denied -- the CLI subprocess can't touch files, run commands, or
// reach the network beyond the model call itself.
const DISALLOWED_TOOLS = [
  "Bash", "Edit", "Write", "Read", "Glob", "Grep",
  "WebFetch", "WebSearch", "NotebookEdit", "Agent", "TaskCreate",
].join(",");

function runClaude(transcript, systemPrompt) {
  return new Promise((resolve, reject) => {
    const args = [
      "-p", transcript,
      "--system-prompt", systemPrompt,
      "--output-format", "json",
      "--model", "haiku",
      "--restricted",
      "--strict-mcp-config",
      "--disallowedTools", DISALLOWED_TOOLS,
      "--disable-slash-commands",
      "--permission-prompts", "none",
    ];
    execFile("claude", args, { timeout: 30_000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr?.trim() || err.message));
        return;
      }
      try {
        const parsed = JSON.parse(stdout);
        if (parsed.is_error) {
          reject(new Error(typeof parsed.result === "string" ? parsed.result : "Claude reported an error"));
          return;
        }
        resolve(typeof parsed.result === "string" ? parsed.result : "");
      } catch (e) {
        reject(new Error("Couldn't parse the claude CLI's output: " + e.message));
      }
    });
  });
}

const server = createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method !== "POST" || req.url !== "/api/voice-command") {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
    return;
  }

  let body = "";
  let tooLarge = false;
  req.on("data", (chunk) => {
    body += chunk;
    if (body.length > MAX_BODY_BYTES) {
      tooLarge = true;
      req.destroy();
    }
  });
  req.on("end", async () => {
    if (tooLarge) return;
    let payload;
    try {
      payload = JSON.parse(body || "{}");
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON body" }));
      return;
    }
    const { transcript, systemPrompt } = payload;
    if (typeof transcript !== "string" || !transcript.trim()) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing transcript" }));
      return;
    }
    try {
      const text = await runClaude(transcript, typeof systemPrompt === "string" ? systemPrompt : "");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ text }));
    } catch (err) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message || "Voice command failed" }));
    }
  });
});

server.listen(PORT, () => {
  console.log(`Voice command server listening on http://localhost:${PORT}`);
  console.log("Interpreting speech via the local `claude` CLI -- make sure it's logged in.");
});
