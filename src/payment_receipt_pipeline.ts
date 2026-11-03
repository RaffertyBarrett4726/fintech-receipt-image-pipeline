import { createHash } from "node:crypto";
import sharp from "sharp";
import { z } from "zod";
import type { ReceiptStore } from "./infrai_storage.js";

export const paymentUploadSchema = z.object({
  eventId: z.string().min(1).max(100),
  accountId: z.string().min(1).max(100),
  amountMinor: z.number().int().positive(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  imageBase64: z.string().min(1),
  contentType: z.enum(["image/jpeg", "image/png", "image/webp"]),
  riskSignals: z.array(z.enum(["new_device", "velocity_spike", "country_mismatch"])).max(3),
});

export type PaymentUpload = z.infer<typeof paymentUploadSchema>;
export type RiskAction = "accept" | "manual_review" | "block";

export type AuditNotification = {
  event: "payment.receipt.processed";
  eventId: string;
  accountId: string;
  amountMinor: number;
  currency: string;
  action: RiskAction;
  reasons: string[];
  imageKeys: string[];
};

export function decideRisk(input: Pick<PaymentUpload, "amountMinor" | "riskSignals">): Pick<AuditNotification, "action" | "reasons"> {
  const distinctSignals = new Set(input.riskSignals);
  if (distinctSignals.size >= 2) return { action: "block", reasons: ["multiple_risk_signals"] };
  if (distinctSignals.size === 1 || input.amountMinor >= 100_000) {
    return { action: "manual_review", reasons: distinctSignals.size ? [...distinctSignals] : ["high_amount"] };
  }
  return { action: "accept", reasons: ["policy_clear"] };
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function processReceipt(
  raw: unknown,
  storage: ReceiptStore,
  bucket = process.env.INFRAI_RECEIPT_BUCKET ?? "fintech-receipts",
): Promise<AuditNotification> {
  const input = paymentUploadSchema.parse(raw);
  const decision = decideRisk(input);
  const prefix = `payments/${encodeURIComponent(input.accountId)}/${encodeURIComponent(input.eventId)}`;
  const imageKeys = decision.action === "block" ? [] : [`${prefix}/original`, `${prefix}/thumbnail.webp`];
  const notification: AuditNotification = {
    event: "payment.receipt.processed",
    eventId: input.eventId,
    accountId: input.accountId,
    amountMinor: input.amountMinor,
    currency: input.currency,
    ...decision,
    imageKeys,
  };

  await storage.bucket.create(bucket);
  if (decision.action !== "block") {
    const source = Buffer.from(input.imageBase64, "base64");
    const thumbnail = await sharp(source).rotate().resize({ width: 480, height: 480, fit: "inside", withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
    await storage.object.put(bucket, imageKeys[0], input.imageBase64, input.contentType, `${input.eventId}:original:${digest(input.imageBase64)}`);
    await storage.object.put(bucket, imageKeys[1], thumbnail.toString("base64"), "image/webp", `${input.eventId}:thumbnail:${digest(thumbnail.toString("base64"))}`);
  }

  const auditJson = JSON.stringify(notification);
  await storage.object.put(bucket, `${prefix}/audit.json`, Buffer.from(auditJson).toString("base64"), "application/json", `${input.eventId}:audit:${digest(auditJson)}`);
  return notification;
}
