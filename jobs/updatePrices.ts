import crypto from "crypto";
import axios from "axios";
import dotenv from "dotenv";
import fs from "fs";

fs.existsSync(".env")
  ? dotenv.config({ path: ".env" })
  : dotenv.config({ path: ".env.local" });

const API_KEY = process.env.SERVER_API_KEY;
const API_SECRET = process.env.SERVER_SECRET;
const SERVER_URL = process.env.SERVER_URL;

async function main() {
  const timestamp = Math.floor(Date.now() / 1000);
  const body = {};
  const endpoint = "/updatePrice";
  const canonical = `POST|${endpoint}|${timestamp}|${JSON.stringify(body)}`;

  if (!API_KEY || !API_SECRET) {
    throw new Error(
      "API key or API secret is missing",
    );
  }

  const hmac = crypto.createHmac(
    "sha256",
    API_SECRET,
  );

  const signature = hmac
    .update(canonical)
    .digest("hex");

  return axios.post(
    `${SERVER_URL}${endpoint}`,
    body,
    {
      headers: {
        "X-API-Key": API_KEY,
        "X-Signature": signature,
        "X-Timestamp": timestamp,
      },
    },
  );
}
if (
  import.meta.url === `file://${process.argv[1]}`
) {
  main()
    .then((response) => {
      console.log("finished with code 0");
      console.log(response.data);
      process.exit(0);
    })
    .catch((e) => {
      console.error("Something went wrong!", e);
      process.exit(1);
    });
}
