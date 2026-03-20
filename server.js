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

// ===== ElevenLabs agent config =====
const ELEVEN_AGENT_ID =
  process.env.ELEVENLABS_AGENT_ID || "agent_7401km5x2hhwemta4c2tm4azzap9";

let elevenWs = null;
let elevenConnected = false;
let elevenConnecting = false;

// Get signed URL for a private ElevenLabs agent
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

      // Optional initiation payload
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
          console.log("ElevenLabs agent text:", data.agent_response_event.agent_response);
        }

        if (data.type === "audio") {
          console.log("ElevenLabs audio event received");
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
    const accessToken = process.env.ZOOM_ACCESS_TOKEN;
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

    if (!accessToken) {
      console.error("Missing ZOOM_ACCESS_TOKEN environment variable");
      return res.status(200).send("OK");
    }

    if (!rtmsClientId) {
      console.error("Missing ZOOM_SDK_KEY environment variable");
      return res.status(200).send("OK");
    }

    await startRTMS(meetingId, participantUserId, rtmsClientId, accessToken);
    await connectElevenLabs();
  }

  res.status(200).send("OK");
});

// ===== Create Meeting SDK signature =====
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

// ===== RTMS WebSocket endpoint =====
const wss = new WebSocketServer({ server, path: "/rtms" });

wss.on("connection", (ws) => {
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
        // not JSON, ignore parse failure
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

app.get("/test-agent", async (req, res) => {
  const response = await callElevenAgent("Hello, introduce yourself");

  console.log(response);

  res.json(response);
});
