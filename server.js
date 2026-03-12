import express from "express";

const app = express();
app.use(express.json());

app.post("/talk", async (req, res) => {
  try {
    const response = await fetch("https://api.bland.ai/v1/agents/fedce9a8-a1d3-43b3-98ab-01e120ae4f80", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "authorization": "https://privnote.com/Bxhbla8Q#7voKqCGub"
      },
      body: JSON.stringify({
        prompt: req.body.text
      })
    });

    const data = await response.json();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/", (req, res) => {
  res.send("Bland server running");
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
