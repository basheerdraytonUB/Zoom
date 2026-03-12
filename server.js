import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import pkg from "jsrsasign";
import path from "path";
import { fileURLToPath } from "url";

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

// Create Meeting SDK signature
app.post("/zoom-signature", (req, res) => {
  try {
    const { meetingNumber, role } = req.body;

    if (!meetingNumber && meetingNumber !== 0) {
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
      role: Number(role || 0),
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

    res.json({
  signature,
  sdkKey
});
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const port = process.env.PORT || 3000;

app.post("/zoom-webhook", (req, res) => {
  console.log("Zoom RTMS Event:", req.body);
  res.status(200).send("OK");
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
