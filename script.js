const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const axios = require("axios");
const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode");

const app = express();

app.use(cors());
app.use(express.json());

const client = new Client({
  authStrategy: new LocalAuth({
    clientId: "jampopay"
  })
});

client.on("qr", async qr => {
  const qrImage = await qrcode.toDataURL(qr);

  console.log("SCAN THIS QR");

  console.log(qrImage);
});

client.on("ready", () => {
  console.log("WhatsApp Ready");
});

client.on("message", async msg => {

  try {

    await axios.post(
      process.env.WEBHOOK_URL,
      {
        phone: msg.from,
        message: msg.body
      },
      {
        headers: {
          "x-secret": process.env.WHATSAPP_SECRET
        }
      }
    );

  } catch (e) {
    console.error(e.message);
  }

});

app.post("/send", async (req, res) => {

  const signature = req.headers["x-signature"];

  const body = JSON.stringify(req.body);

  const expected = crypto
    .createHmac("sha256", process.env.WHATSAPP_SECRET)
    .update(body)
    .digest("hex");

  if (signature !== expected) {
    return res.status(401).json({
      error: "Invalid signature"
    });
  }

  const { phone, message } = req.body;

  try {

    const formatted = phone.includes("@c.us")
      ? phone
      : `${phone}@c.us`;

    await client.sendMessage(
      formatted,
      message
    );

    res.json({
      success: true
    });

  } catch (e) {

    res.status(500).json({
      error: e.message
    });

  }

});

client.initialize();

app.listen(process.env.PORT, () => {
  console.log("Server Running");
});
