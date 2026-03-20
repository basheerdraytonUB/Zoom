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

// ===== ElevenLabs config =====
const ELEVEN_AGENT_ID =
  process.env.ELEVENLABS_AGENT_ID || "agent_7401km5x2hhwemta4c2tm4azzap9";

let elevenWs = null;
let elevenConnected = false;
let elevenConnecting = false;

// ===== Browser clients =====
const browserClients = new Set();

function broadcastToBrowser(payload) {
  const msg = JSON.stringify(payload);
  for (const client of browserClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  }
}

// ===== Zoom token cache =====
let zoomTokenCache = {
  accessToken: null,
  expiresAt: 0
};

async function getZoomAccessToken() {
  const now = Date.now();

  if (
    zoomTokenCache.accessToken &&
    zoomTokenCache.expiresAt &&
    now < zoomTokenCache.expiresAt - 60_000
  ) {
    return zoomTokenCache.accessToken;
  }

  const accountId = process.env.ZOOM_ACCOUNT_ID;
  const clientId = process.env.ZOOM_CLIENT_ID;
  const clientSecret = process.env.ZOOM_CLIENT_SECRET;

  if (!accountId || !clientId || !clientSecret) {
    throw new Error("Missing ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID, or ZOOM_CLIENT_SECRET");
  }

  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const response = await fetch(
    `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${encodeURIComponent(accountId)}`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${basicAuth}`
      }
    }
  );

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Failed to get Zoom access token: ${text}`);
  }

  const data = JSON.parse(text);

  zoomTokenCache.accessToken = data.access_token;
  zoomTokenCache.expiresAt = Date.now() + (data.expires_in || 3600) * 1000;

  console.log("Fetched new Zoom access token");

  return zoomTokenCache.accessToken;
}

// ===== ElevenLabs helpers =====
async function getElevenSignedUrl() {
  const apiKey = process.env.ELEVENLABS_API_KEY;

  if (!apiKey) {
    throw new Error("Missing ELEVENLABS_API_KEY environment variable");
  }

  const response = await fetch(
    `https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${ELEVEN_AGENT_ID}`,
    {
      method: "GET",
      headers: {
        "xi-api-key": apiKey
      }
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to get ElevenLabs signed URL: ${text}`);
  }

  const body = await response.json();
  return body.signed_url;
}

async function connectElevenLabs() {
  if (elevenConnected || elevenConnecting) return;

  elevenConnecting = true;

  try {
    const signedUrl = await getElevenSignedUrl();
    console.log("Got ElevenLabs signed URL");

    elevenWs = new WebSocket(signedUrl);

    elevenWs.on("open", () => {
      elevenConnected = true;
      elevenConnecting = false;
      console.log("ElevenLabs WebSocket connected");

      elevenWs.send(
        JSON.stringify({
          type: "conversation_initiation_client_data",
          conversation_config_override: {}
        })
      );
    });

    elevenWs.on("message", (message) => {
      try {
        const text = message.toString();
        const data = JSON.parse(text);

        console.log("ElevenLabs event:", JSON.stringify(data, null, 2));

        if (data.type === "agent_response" && data.agent_response_event?.agent_response) {
          const reply = data.agent_response_event.agent_response;
          console.log("ElevenLabs agent text:", reply);

          broadcastToBrowser({
            type: "agent_text",
            text: reply
          });
        }

        if (data.type === "audio") {
          broadcastToBrowser({
            type: "agent_audio_event",
            data
          });
        }
      } catch (err) {
        console.error("ElevenLabs message parse error:", err.message);
      }
    });

    elevenWs.on("close", () => {
      console.log("ElevenLabs WebSocket closed");
      elevenConnected = false;
      elevenConnecting = false;
      elevenWs = null;
    });

    elevenWs.on("error", (err) => {
      console.error("ElevenLabs WebSocket error:", err.message);
      elevenConnected = false;
      elevenConnecting = false;
    });
  } catch (err) {
    elevenConnecting = false;
    console.error("Failed to connect ElevenLabs:", err.message);
  }
}

async function sendTranscriptToElevenLabs(transcript) {
  if (!transcript || !transcript.trim()) return;

  if (!elevenConnected || !elevenWs || elevenWs.readyState !== WebSocket.OPEN) {
    await connectElevenLabs();
  }

  if (!elevenWs || elevenWs.readyState !== WebSocket.OPEN) {
    console.error("ElevenLabs WebSocket is not open");
    return;
  }

  elevenWs.send(
    JSON.stringify({
      type: "user_message",
      text: transcript
    })
  );

  console.log("Sent transcript to ElevenLabs:", transcript);

  broadcastToBrowser({
    type: "transcript",
    text: transcript
  });
}

// ===== Zoom webhook =====
app.post("/zoom-webhook", async (req, res) => {
  const event = req.body.event;
  const payload = req.body.payload;

  console.log("Zoom webhook received:");
  console.log(JSON.stringify(req.body, null, 2));

  if (event === "meeting.started") {
    const meetingId = payload?.object?.id;
    const participantUserId = payload?.object?.host_id;
    const rtmsClientId = process.env.ZOOM_SDK_KEY;

    console.log("Meeting started:", meetingId);
    console.log("Host participant_user_id:", participantUserId);

    if (!meetingId) {
      console.error("Missing meeting ID in webhook payload");
      return res.status(200).send("OK");
    }

    if (!participantUserId) {
      console.error("Missing host_id / participant_user_id in webhook payload");
      return res.status(200).send("OK");
    }

    if (!rtmsClientId) {
      console.error("Missing ZOOM_SDK_KEY environment variable");
      return res.status(200).send("OK");
    }

    let accessToken;
    try {
      accessToken = await getZoomAccessToken();
    } catch (err) {
      console.error("Failed to get Zoom access token:", err.message);
      return res.status(200).send("OK");
    }

    await startRTMS(meetingId, participantUserId, rtmsClientId, accessToken);
    await connectElevenLabs();
  }

  res.status(200).send("OK");
});

// ===== Zoom Meeting SDK signature =====
app.post("/zoom-signature", (req, res) => {
  try {
    const { meetingNumber, role } = req.body;

    if (!meetingNumber) {
      return res.status(400).json({ error: "meetingNumber is required" });
    }

    const sdkKey = process.env.ZOOM_SDK_KEY;
    const sdkSecret = process.env.ZOOM_SDK_SECRET;

    if (!sdkKey || !sdkSecret) {
      return res.status(500).json({ error: "Missing Zoom SDK environment variables" });
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

const server = http.createServer(app);

// ===== RTMS WebSocket =====
const rtmsWss = new WebSocketServer({ server, path: "/rtms" });

rtmsWss.on("connection", (ws) => {
  console.log("RTMS WebSocket connected");

  ws.on("message", async (message) => {
    try {
      const text = message.toString();
      console.log("RTMS message raw:", text);

      try {
        const data = JSON.parse(text);
        console.log("RTMS message parsed:", JSON.stringify(data, null, 2));

        if (data?.text) {
          const transcript = data.text;
          console.log("Transcript text:", transcript);

          await sendTranscriptToElevenLabs(transcript);
        }
      } catch {
        // not JSON
      }
    } catch (err) {
      console.error("RTMS message error:", err.message);
    }
  });

  ws.on("close", () => {
    console.log("RTMS WebSocket closed");
  });

  ws.on("error", (err) => {
    console.error("RTMS WebSocket error:", err.message);
  });
});

// ===== Browser events WebSocket =====
const browserWss = new WebSocketServer({ server, path: "/browser-events" });

browserWss.on("connection", (ws) => {
  console.log("Browser events WebSocket connected");
  browserClients.add(ws);

  ws.on("close", () => {
    browserClients.delete(ws);
    console.log("Browser events WebSocket closed");
  });

  ws.on("error", () => {
    browserClients.delete(ws);
  });
});

// ===== Start RTMS =====
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
    console.log("RTMS raw response:", text);
  } catch (err) {
    console.error("RTMS start error:", err.message);
  }
}

const port = process.env.PORT || 3000;

server.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
