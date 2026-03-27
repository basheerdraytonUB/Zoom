import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import pkg from "jsrsasign";
import path from "path";
import { fileURLToPath } from "url";
import http from "http";
import { WebSocketServer, WebSocket } from "ws";

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

// Health check — Render and UptimeRobot can ping this to keep the instance warm
app.get("/health", (req, res) => {
  res.json({ status: "ok", sessions: sessions.size, ts: Date.now() });
});

// ===== ElevenLabs config =====
// Agent ID can be overridden per-session; default pulled from env
const DEFAULT_AGENT_ID =
  process.env.ELEVENLABS_AGENT_ID || "agent_7401km5x2hhwemta4c2tm4azzap9";

// ===== Per-session state =====
// Each browser client gets its own ElevenLabs WS so multiple sessions work correctly.
// Key: browserWs  Value: { elevenWs, elevenConnected, elevenConnecting, audioBuffer[] }
const sessions = new Map();

// ===== Zoom token cache =====
let zoomTokenCache = { accessToken: null, expiresAt: 0 };

async function getZoomAccessToken() {
  const now = Date.now();
  if (zoomTokenCache.accessToken && now < zoomTokenCache.expiresAt - 60_000) {
    return zoomTokenCache.accessToken;
  }

  const { ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET } = process.env;
  if (!ZOOM_ACCOUNT_ID || !ZOOM_CLIENT_ID || !ZOOM_CLIENT_SECRET) {
    throw new Error("Missing ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID, or ZOOM_CLIENT_SECRET");
  }

  const basicAuth = Buffer.from(`${ZOOM_CLIENT_ID}:${ZOOM_CLIENT_SECRET}`).toString("base64");
  const response = await fetch(
    `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${encodeURIComponent(ZOOM_ACCOUNT_ID)}`,
    { method: "POST", headers: { Authorization: `Basic ${basicAuth}` } }
  );

  const text = await response.text();
  if (!response.ok) throw new Error(`Failed to get Zoom access token: ${text}`);

  const data = JSON.parse(text);
  zoomTokenCache.accessToken = data.access_token;
  zoomTokenCache.expiresAt = Date.now() + (data.expires_in || 3600) * 1000;
  console.log("Fetched new Zoom access token");
  return zoomTokenCache.accessToken;
}

// ===== ElevenLabs helpers =====
async function getElevenSignedUrl(agentId) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error("Missing ELEVENLABS_API_KEY environment variable");

  const response = await fetch(
    `https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${agentId}`,
    { method: "GET", headers: { "xi-api-key": apiKey } }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to get ElevenLabs signed URL: ${text}`);
  }

  const body = await response.json();
  return body.signed_url;
}

/**
 * Connect ElevenLabs WebSocket for a specific browser client session.
 * Audio from ElevenLabs (base64 PCM) is forwarded back to that browser client
 * so the browser can play it through the Zoom meeting's audio output.
 */
async function connectElevenLabsForSession(browserWs, agentId = DEFAULT_AGENT_ID) {
  const session = sessions.get(browserWs);
  if (!session) return;
  if (session.elevenConnected || session.elevenConnecting) return;

  session.elevenConnecting = true;

  try {
    const signedUrl = await getElevenSignedUrl(agentId);
    console.log(`[session] Got ElevenLabs signed URL for agent ${agentId}`);

    const elevenWs = new WebSocket(signedUrl);
    session.elevenWs = elevenWs;

    elevenWs.on("open", () => {
      session.elevenConnected = true;
      session.elevenConnecting = false;
      console.log("[session] ElevenLabs WebSocket connected");

      // Required handshake — must be sent immediately on open
      elevenWs.send(JSON.stringify({
        type: "conversation_initiation_client_data",
        conversation_config_override: {}
      }));
    });

    elevenWs.on("message", (message) => {
      try {
        const data = JSON.parse(message.toString());

        // --- Keep-alive: respond to pings ---
        if (data.type === "ping") {
          elevenWs.send(JSON.stringify({
            type: "pong",
            event_id: data.ping_event?.event_id
          }));
          return;
        }

        // --- Audio chunk from agent: forward base64 PCM to browser ---
        // The browser will decode this and inject into Zoom's audio output
        if (data.type === "audio" && data.audio_event?.audio_base_64) {
          sendToBrowser(browserWs, {
            type: "agent_audio",
            audio_base_64: data.audio_event.audio_base_64,
            event_id: data.audio_event.event_id
          });
          return;
        }

        // --- Interruption: tell browser to stop playing queued audio ---
        if (data.type === "interruption") {
          sendToBrowser(browserWs, { type: "interruption" });
          return;
        }

        // --- Agent text response (for UI display) ---
        if (data.type === "agent_response" && data.agent_response_event?.agent_response) {
          const reply = data.agent_response_event.agent_response;
          console.log("[ElevenLabs] Agent text:", reply);
          sendToBrowser(browserWs, { type: "agent_text", text: reply });
        }

        // --- User transcript (for UI display) ---
        if (data.type === "user_transcript" && data.user_transcription_event?.user_transcript) {
          const transcript = data.user_transcription_event.user_transcript;
          console.log("[ElevenLabs] User transcript:", transcript);
          sendToBrowser(browserWs, { type: "transcript", text: transcript });
        }

      } catch (err) {
        console.error("[ElevenLabs] Message parse error:", err.message);
      }
    });

    elevenWs.on("close", () => {
      console.log("[session] ElevenLabs WebSocket closed");
      if (sessions.has(browserWs)) {
        sessions.get(browserWs).elevenConnected = false;
        sessions.get(browserWs).elevenConnecting = false;
        sessions.get(browserWs).elevenWs = null;
      }
    });

    elevenWs.on("error", (err) => {
      console.error("[ElevenLabs] WebSocket error:", err.message);
      if (sessions.has(browserWs)) {
        sessions.get(browserWs).elevenConnected = false;
        sessions.get(browserWs).elevenConnecting = false;
      }
    });

  } catch (err) {
    session.elevenConnecting = false;
    console.error("[session] Failed to connect ElevenLabs:", err.message);
  }
}

/**
 * Send raw PCM audio (base64) from Zoom participant to ElevenLabs.
 * This is the correct message format per the ElevenLabs Conversational AI WS spec.
 */
function sendAudioToElevenLabs(browserWs, audioBase64) {
  const session = sessions.get(browserWs);
  if (!session) return;

  const { elevenWs, elevenConnected } = session;
  if (!elevenConnected || !elevenWs || elevenWs.readyState !== WebSocket.OPEN) {
    console.warn("[session] ElevenLabs not ready — dropping audio chunk");
    return;
  }

  // Correct format: { user_audio_chunk: "<base64 PCM 16kHz mono 16-bit>" }
  elevenWs.send(JSON.stringify({ user_audio_chunk: audioBase64 }));
}

function sendToBrowser(browserWs, payload) {
  if (browserWs.readyState === WebSocket.OPEN) {
    browserWs.send(JSON.stringify(payload));
  }
}

// ===== Zoom Meeting SDK signature endpoint =====
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

    const payload = {
      sdkKey,
      mn: String(meetingNumber),
      role: Number(role ?? 0),
      iat,
      exp,
      appKey: sdkKey,
      tokenExp: exp
    };

    const header = { alg: "HS256", typ: "JWT" };
    const signature = KJUR.jws.JWS.sign(
      "HS256",
      JSON.stringify(header),
      JSON.stringify(payload),
      sdkSecret
    );

    res.json({ signature, sdkKey });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== ElevenLabs signed URL proxy (keeps API key server-side) =====
app.post("/eleven-signed-url", async (req, res) => {
  try {
    const agentId = req.body.agentId || DEFAULT_AGENT_ID;
    const signedUrl = await getElevenSignedUrl(agentId);
    res.json({ signed_url: signedUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== Zoom webhook (RTMS trigger) =====
app.post("/zoom-webhook", async (req, res) => {
  const event = req.body.event;
  const payload = req.body.payload;

  console.log("Zoom webhook received:", event);

  if (event === "meeting.started") {
    const meetingId = payload?.object?.id;
    const participantUserId = payload?.object?.host_id;
    const rtmsClientId = process.env.ZOOM_SDK_KEY;

    if (!meetingId || !participantUserId || !rtmsClientId) {
      console.error("Zoom webhook missing required fields");
      return res.status(200).send("OK");
    }

    try {
      const accessToken = await getZoomAccessToken();
      await startRTMS(meetingId, participantUserId, rtmsClientId, accessToken);
    } catch (err) {
      console.error("RTMS start failed:", err.message);
    }
  }

  res.status(200).send("OK");
});

// ===== HTTP server =====
const server = http.createServer(app);

// ===== Browser WebSocket (main control channel) =====
// Browser connects here to:
//   1. Receive agent audio chunks to play back in Zoom
//   2. Send raw PCM audio from Zoom participants to the server
//   3. Send control messages (start session, switch agent, etc.)
const browserWss = new WebSocketServer({ server, path: "/browser-events" });

browserWss.on("connection", (ws) => {
  console.log("[browser] Client connected");

  // Create a session entry for this browser client
  sessions.set(ws, {
    elevenWs: null,
    elevenConnected: false,
    elevenConnecting: false
  });

  // Heartbeat — ping every 20s so Render doesn't kill the WS connection.
  // Render free tier drops idle connections; this keeps them alive.
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });

  const heartbeat = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) {
      clearInterval(heartbeat);
      return;
    }
    if (!ws.isAlive) {
      console.log("[browser] Client heartbeat timeout — terminating");
      clearInterval(heartbeat);
      ws.terminate();
      return;
    }
    ws.isAlive = false;
    ws.ping();
  }, 20_000);

  ws.on("message", async (rawMsg) => {
    try {
      const msg = JSON.parse(rawMsg.toString());

      switch (msg.type) {

        // Keep-alive ping from browser — just ignore silently
        case "ping":
          break;

        // Browser signals it's ready to start talking (after joining Zoom meeting)
        case "start_session": {
          const agentId = msg.agentId || DEFAULT_AGENT_ID;
          console.log(`[browser] start_session for agent ${agentId}`);
          await connectElevenLabsForSession(ws, agentId);
          sendToBrowser(ws, { type: "session_ready" });
          break;
        }

        // Raw PCM audio chunk captured from Zoom participant microphone (base64, 16kHz mono 16-bit)
        // The browser captures this via Zoom SDK's audio stream and sends it here
        case "user_audio_chunk": {
          if (msg.audio_base_64) {
            sendAudioToElevenLabs(ws, msg.audio_base_64);
          }
          break;
        }

        // Switch to a different agent mid-session
        case "switch_agent": {
          const session = sessions.get(ws);
          if (session?.elevenWs) {
            session.elevenWs.close();
          }
          const agentId = msg.agentId || DEFAULT_AGENT_ID;
          console.log(`[browser] Switching to agent ${agentId}`);
          await connectElevenLabsForSession(ws, agentId);
          sendToBrowser(ws, { type: "session_ready", agentId });
          break;
        }

        default:
          console.warn("[browser] Unknown message type:", msg.type);
      }
    } catch (err) {
      console.error("[browser] Message error:", err.message);
    }
  });

  ws.on("close", () => {
    console.log("[browser] Client disconnected");
    clearInterval(heartbeat);
    const session = sessions.get(ws);
    if (session?.elevenWs) {
      session.elevenWs.close();
    }
    sessions.delete(ws);
  });

  ws.on("error", (err) => {
    console.error("[browser] WebSocket error:", err.message);
    sessions.delete(ws);
  });
});

// ===== RTMS WebSocket (Zoom sends raw media here) =====
// NOTE: Zoom RTMS sends audio as raw PCM buffers, not JSON.
// We forward the audio bytes directly to ElevenLabs as base64.
// You'll need to configure your Zoom app's RTMS endpoint to point to /rtms on this server.
const rtmsWss = new WebSocketServer({ server, path: "/rtms" });

rtmsWss.on("connection", (ws) => {
  console.log("[RTMS] Zoom media stream connected");

  // RTMS connections are not tied to a specific browser session here.
  // If you need per-meeting routing, track meetingId from the webhook and map it.
  // For simplicity: broadcast audio to all active browser sessions.
  ws.on("message", (message) => {
    try {
      // Try JSON first (control/metadata frames)
      const text = message.toString();
      try {
        const data = JSON.parse(text);

        // RTMS sends a handshake on connect — respond to keep stream alive
        if (data.msg_type === "HANDSHAKE") {
          ws.send(JSON.stringify({ msg_type: "HANDSHAKE_RESPONSE", status_code: "STATUS_CODE_OK" }));
          console.log("[RTMS] Handshake acknowledged");
          return;
        }

        // Some RTMS implementations send transcript-style JSON
        if (data?.text) {
          console.log("[RTMS] Transcript:", data.text);
          // Broadcast text to all sessions (they can decide whether to use it)
          for (const [browserWs] of sessions) {
            sendToBrowser(browserWs, { type: "transcript", text: data.text });
          }
        }
        return;
      } catch {
        // Not JSON — treat as binary PCM audio
      }

      // Binary audio frame — convert to base64 and forward to ElevenLabs
      const audioBase64 = Buffer.isBuffer(message)
        ? message.toString("base64")
        : Buffer.from(message).toString("base64");

      for (const [browserWs] of sessions) {
        sendAudioToElevenLabs(browserWs, audioBase64);
      }

    } catch (err) {
      console.error("[RTMS] Message error:", err.message);
    }
  });

  ws.on("close", () => console.log("[RTMS] Zoom media stream closed"));
  ws.on("error", (err) => console.error("[RTMS] Error:", err.message));
});

// ===== Start RTMS via Zoom API =====
async function startRTMS(meetingId, participantUserId, rtmsClientId, accessToken) {
  try {
    const response = await fetch(
      `https://api-us.zoom.us/v2/live_meetings/${meetingId}/rtms_app/status`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`
        },
        body: JSON.stringify({
          action: "start",
          settings: {
            participant_user_id: participantUserId,
            client_id: rtmsClientId
          }
        })
      }
    );

    const text = await response.text();
    console.log("[RTMS] Start response:", text);

    // Surface the most common error clearly
    try {
      const json = JSON.parse(text);
      if (json.code === 13262) {
        console.error(
          "\n⚠️  RTMS AUTH ERROR — Your Zoom app is not authorized for RTMS.\n" +
          "To fix this:\n" +
          "  1. Go to marketplace.zoom.us → Manage → your app → Scopes\n" +
          "  2. Add all 'rtms' scopes\n" +
          "  3. Go to zoom.us/account/setting → search 'Allow apps to access meeting content' → enable it\n" +
          "  4. Redeploy this server\n"
        );
      }
    } catch {}
  } catch (err) {
    console.error("[RTMS] Start error:", err.message);
  }
}

// ===== Start server =====
const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
