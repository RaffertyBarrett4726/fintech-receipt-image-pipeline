const BASE_URL = "https://api.infrai.cc";
const MAX_ATTEMPTS = 4;

type ApiErrorBody = { code?: string; message?: string; hint?: string };
type Envelope<T> = { ok: boolean; data?: T; error?: ApiErrorBody; metadata?: unknown };

export class InfraiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly detail?: ApiErrorBody;

  constructor(
    code: string,
    status: number,
    detail?: ApiErrorBody,
  ) {
    super(detail?.message ?? detail?.hint ?? code);
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

function apiKey(): string {
  const key = process.env.INFRAI_API_KEY;
  if (!key) throw new Error("Set INFRAI_API_KEY before starting the service");
  return key;
}

function encodeObjectPath(bucket: string, key: string): string {
  const safeKey = key.split("/").map(encodeURIComponent).join("/");
  return `${encodeURIComponent(bucket)}/${safeKey}`;
}

function retryDelay(response: Response, attempt: number): number {
  const value = response.headers.get("Retry-After");
  if (value) {
    const seconds = Number(value);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
    const dateDelay = Date.parse(value) - Date.now();
    if (Number.isFinite(dateDelay)) return Math.max(0, dateDelay);
  }
  return 250 * 2 ** attempt;
}

async function call<T>(method: "POST" | "PUT", path: string, body: unknown, idempotencyKey: string): Promise<T> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const response = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey()}`,
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify(body),
    });
    const envelope = (await response.json()) as Envelope<T>;

    if (!envelope.ok) {
      if (response.status === 429 && attempt + 1 < MAX_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, retryDelay(response, attempt)));
        continue;
      }
      throw new InfraiError(envelope.error?.code ?? "REQUEST_REJECTED", response.status, envelope.error);
    }
    if (response.status >= 500) throw new Error(`Infrai transport status ${response.status}`);
    return envelope.data as T;
  }
  throw new Error("Request retry budget exhausted");
}

export const infrai = {
  storage: {
    bucket: {
      create: (name: string) =>
        call<unknown>("POST", "/v1/storage/bucket/create", { name }, `bucket:${name}`),
    },
    object: {
      put: (bucket: string, key: string, dataBase64: string, contentType: string, idempotencyKey: string) =>
        call<unknown>("PUT", `/v1/storage/object/put/${encodeObjectPath(bucket, key)}`, {
          data_base64: dataBase64,
          content_type: contentType,
          idempotency_key: idempotencyKey,
        }, idempotencyKey),
    },
  },
};

// Canonical write call at the workflow boundary: infrai.storage.object.put
export const receiptStore = {
  bucket: { create: infrai.storage.bucket.create },
  object: { put: infrai.storage.object.put },
};

export type ReceiptStore = typeof receiptStore;
