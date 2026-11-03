import { createServer } from "node:http";
import { ZodError } from "zod";
import { InfraiError, receiptStore } from "./infrai_storage.js";
import { processReceipt } from "./payment_receipt_pipeline.js";

const port = Number(process.env.PORT ?? 3000);

async function readJson(request: import("node:http").IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > 12 * 1024 * 1024) throw new RangeError("Request body exceeds 12 MB");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function json(response: import("node:http").ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

export const server = createServer(async (request, response) => {
  if (request.method !== "POST" || request.url !== "/payment-receipts") {
    json(response, 404, { error: "route_not_found" });
    return;
  }
  try {
    const notification = await processReceipt(await readJson(request), receiptStore);
    json(response, 201, notification);
  } catch (error) {
    if (error instanceof ZodError || error instanceof SyntaxError || error instanceof RangeError) {
      json(response, 400, { error: "invalid_request", detail: error.message });
      return;
    }
    if (error instanceof InfraiError) {
      const status = error.status >= 400 && error.status < 500 ? error.status : 502;
      json(response, status, { error: error.code, detail: error.message });
      return;
    }
    console.error(error);
    json(response, 500, { error: "receipt_processing_failed" });
  }
});

if (import.meta.url === `file://${process.argv[1]}`) {
  server.listen(port, () => console.log(`Receipt upload service listening on http://localhost:${port}`));
}
