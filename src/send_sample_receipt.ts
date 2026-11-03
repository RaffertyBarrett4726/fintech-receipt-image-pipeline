import sharp from "sharp";

const imageBase64 = (await sharp({ create: { width: 960, height: 640, channels: 3, background: "#f4f7f5" } }).png().toBuffer()).toString("base64");
const response = await fetch("http://localhost:3000/payment-receipts", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    eventId: "pay_demo_1042",
    accountId: "acct_demo_7",
    amountMinor: 24_900,
    currency: "USD",
    imageBase64,
    contentType: "image/png",
    riskSignals: ["new_device"],
  }),
});
console.log(JSON.stringify(await response.json(), null, 2));
