import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import pkg from "jsrsasign";
import path from "path";
import { fileURLToPath } from "url";
import http from "http";
import { WebSocketServer } from "ws";

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

// Zoom webhook: RTMS and other Zoom events
app.post("/zoom-webhook", (req, res) => {
  console.log("Zoom webhook received:");
  console.log(JSON.stringify(req.body, null, 2));
  res.status(200).send("OK");
});

// Create Meeting SDK signature
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

// WebSocket endpoint for RTMS transcript/media
const wss = new WebSocketServer({ server, path: "/rtms" });

wss.on("connection", (ws, req) => {
  console.log("RTMS WebSocket connected");

  ws.on("message", (message) => {
    try {
      const text = message.toString();
      console.log("RTMS message raw:", text);

      // Try to parse JSON if transcript/events come in JSON form
      try {
        const data = JSON.parse(text);
        console.log("RTMS message parsed:", JSON.stringify(data, null, 2));

        // If transcript text exists, log it clearly
        if (data?.text) {
          console.log("Transcript text:", data.text);
        }
      } catch {
        // Not JSON, just raw text/binary notice
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

const port = process.env.PORT || 3000;

async function startRTMS(meetingId, accessToken) {
  try {
    const response = await fetch(
      `https://api.zoom.us/v2/live_meetings/${meetingId}/rtms_app/status`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`
        },
        body: JSON.stringify({
          action: "start"
        })
      }
    );

    const data = await response.json();
    console.log("RTMS start response:", data);
  } catch (err) {
    console.error("RTMS start error:", err.message);
  }
}
server.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
