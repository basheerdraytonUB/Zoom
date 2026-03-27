import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import pkg from "jsrsasign";
import path from "path";
import { fileURLToPath } from "url";
import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import puppeteer from "puppeteer";
import { execSync } from "child_process";

dotenv.config();

// ===== Install Chrome if not present =====
// Render's build step is unreliable — install at runtime instead.
try {
  console.log("Checking for Chrome...");
  execSync("npx puppeteer browsers install chrome", {
    stdio: "inherit",
    env: {
      ...process.env,
      PUPPETEER_CACHE_DIR: process.env.PUPPETEER_CACHE_DIR || "/opt/render/.cache/puppeteer"
    }
  });
  console.log("Chrome ready.");
} catch (err) {
  console.error("Chrome install warning:", err.message);
}

dotenv.config();

const { KJUR } = pkg;
const app = express();

app.use(cors());
app.use(express.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", activeBots: bots.size, ts: Date.now() });
});

const DEFAULT_AGENT_ID =
  process.env.ELEVENLABS_AGENT_ID || "agent_7401km5x2hhwemta4c2tm4azzap9";

const bots = new Map();
const sessions = new Map();

function sendToBrowser(browserWs, payload) {
  if (browserWs && browserWs.readyState === WebSocket.OPEN) {
    browserWs.send(JSON.stringify(payload));
  }
}

async function getElevenSignedUrl(agentId) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error("Missing ELEVENLABS_API_KEY");
  const response = await fetch(
    `https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${agentId}`,
    { method: "GET", headers: { "xi-api-key": apiKey } }
  );
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`ElevenLabs signed URL failed: ${text}`);
  }
  const body = await response.json();
  return body.signed_url;
}

app.post("/zoom-signature", (req, res) => {
  try {
    const { meetingNumber, role } = req.body;
    if (!meetingNumber) return res.status(400).json({ error: "meetingNumber is required" });
    const sdkKey = process.env.ZOOM_SDK_KEY;
    const sdkSecret = process.env.ZOOM_SDK_SECRET;
    if (!sdkKey || !sdkSecret) {
      return res.status(500).json({ error: "Missing ZOOM_SDK_KEY or ZOOM_SDK_SECRET" });
    }
    const iat = Math.floor(Date.now() / 1000) - 30;
    const exp = iat + 60 * 60 * 2;
    const payload = { sdkKey, mn: String(meetingNumber), role: Number(role ?? 0), iat, exp, appKey: sdkKey, tokenExp: exp };
    const header = { alg: "HS256", typ: "JWT" };
    const signature = KJUR.jws.JWS.sign("HS256", JSON.stringify(header), JSON.stringify(payload), sdkSecret);
    res.json({ signature, sdkKey });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Signed URL endpoint for the bot page
app.get("/eleven-signed-url", async (req, res) => {
  try {
    const agentId = req.query.agentId || DEFAULT_AGENT_ID;
    const signedUrl = await getElevenSignedUrl(agentId);
    res.json({ signed_url: signedUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function launchBot({ meetingNumber, password, userName, agentId, sessionId, browserWs }) {
  try {
    sendToBrowser(browserWs, { type: "bot_status", status: "launching", msg: "Launching headless browser..." });

    const browser = await puppeteer.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
        "--autoplay-policy=no-user-gesture-required",
        "--allow-running-insecure-content",
      ],
    });

    const page = await browser.newPage();
    const context = browser.defaultBrowserContext();
    const renderUrl = process.env.RENDER_EXTERNAL_URL || "https://zoom-bba4.onrender.com";
    await context.overridePermissions(renderUrl, ["microphone", "camera"]);

    page.on("console", (msg) => {
      const text = msg.text();
      console.log(`[bot:${sessionId}] ${text}`);
      sendToBrowser(browserWs, { type: "bot_log", msg: text });
    });

    page.on("pageerror", (err) => {
      console.error(`[bot:${sessionId}] Page error:`, err.message);
      sendToBrowser(browserWs, { type: "bot_log", msg: `ERROR: ${err.message}` });
    });

    const botUrl = `${renderUrl}/bot.html?` +
      `meetingNumber=${encodeURIComponent(meetingNumber)}` +
      `&password=${encodeURIComponent(password || "")}` +
      `&userName=${encodeURIComponent(userName || "Calle AI")}` +
      `&agentId=${encodeURIComponent(agentId || DEFAULT_AGENT_ID)}` +
      `&sessionId=${encodeURIComponent(sessionId)}`;

    console.log(`[bot:${sessionId}] Navigating to: ${botUrl}`);
    await page.goto(botUrl, { waitUntil: "networkidle2", timeout: 60000 });

    bots.set(sessionId, { browser, page, browserWs });
    sendToBrowser(browserWs, { type: "bot_status", status: "running", msg: "Bot is live in the meeting!" });
    console.log(`[bot:${sessionId}] Launched successfully`);

  } catch (err) {
    console.error(`[bot:${sessionId}] Launch failed:`, err.message);
    sendToBrowser(browserWs, { type: "bot_status", status: "error", msg: `Launch failed: ${err.message}` });
    bots.delete(sessionId);
  }
}

async function stopBot(sessionId) {
  const bot = bots.get(sessionId);
  if (!bot) return;
  try { await bot.browser.close(); } catch {}
  bots.delete(sessionId);
  console.log(`[bot:${sessionId}] Stopped`);
}

const server = http.createServer(app);
const browserWss = new WebSocketServer({ server, path: "/browser-events" });

browserWss.on("connection", (ws) => {
  const sessionId = Math.random().toString(36).slice(2, 10);
  console.log(`[browser] Client connected: ${sessionId}`);
  sessions.set(sessionId, ws);

  const heartbeat = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "server_ping" }));
    } else {
      clearInterval(heartbeat);
    }
  }, 5_000);

  ws.on("message", async (rawMsg) => {
    try {
      const msg = JSON.parse(rawMsg.toString());
      switch (msg.type) {
        case "ping": break;
        case "launch_bot": {
          const { meetingNumber, password, userName, agentId } = msg;
          console.log(`[browser:${sessionId}] launch_bot — meeting: ${meetingNumber}`);
          await launchBot({ meetingNumber, password, userName, agentId, sessionId, browserWs: ws });
          break;
        }
        case "stop_bot": {
          await stopBot(sessionId);
          sendToBrowser(ws, { type: "bot_status", status: "stopped", msg: "Bot stopped." });
          break;
        }
        default:
          console.warn(`[browser:${sessionId}] Unknown:`, msg.type);
      }
    } catch (err) {
      console.error(`[browser] Message error:`, err.message);
    }
  });

  ws.on("close", async () => {
    clearInterval(heartbeat);
    sessions.delete(sessionId);
    await stopBot(sessionId);
  });

  ws.on("error", (err) => {
    clearInterval(heartbeat);
    sessions.delete(sessionId);
  });

  ws.send(JSON.stringify({ type: "session_init", sessionId }));
});

const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
