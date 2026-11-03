import assert from "node:assert/strict";
import test from "node:test";
import { decideRisk, processReceipt } from "../src/payment_receipt_pipeline.js";

test("two independent signals block image retention but preserve an audit notification", async () => {
  const writes: Array<{ key: string; contentType: string }> = [];
  const storage = {
    bucket: { create: async (_name: string) => ({}) },
    object: {
      put: async (_bucket: string, key: string, _data: string, contentType: string, _idempotencyKey: string) => {
        writes.push({ key, contentType });
        return {};
      },
    },
  };
  const notification = await processReceipt({
    eventId: "pay_1042",
    accountId: "acct_7",
    amountMinor: 49_900,
    currency: "USD",
    imageBase64: "aW1hZ2U=",
    contentType: "image/png",
    riskSignals: ["new_device", "country_mismatch"],
  }, storage);

  assert.deepEqual(decideRisk({ amountMinor: 49_900, riskSignals: ["new_device", "country_mismatch"] }), {
    action: "block",
    reasons: ["multiple_risk_signals"],
  });
  assert.equal(notification.action, "block");
  assert.deepEqual(notification.imageKeys, []);
  assert.deepEqual(writes, [{ key: "payments/acct_7/pay_1042/audit.json", contentType: "application/json" }]);
});
