import { createFileRoute } from "@tanstack/react-router";

const TIKTOK_EVENTS_API = "https://business-api.tiktok.com/open_api/v1.3/event/track/";
const DEFAULT_PIXEL_ID = "D9K1G33C77U820ARO52G";

/**
 * Digistore24 vendor IPN -> TikTok Ads Events API.
 *
 * This is the VENDOR notification (Settings > IPN in the account that owns the
 * products): a signed POST carrying the full order payload. It replaces the earlier
 * affiliate S2S postback, which had no signature, no buyer email, and only the five
 * short sub-IDs to carry tracking.
 *
 * Utmify is NOT handled here — it has its own native Digistore24 postback that reads
 * the {utm_*} macros. This endpoint only covers what that cannot: the TikTok pixel.
 */

type IpnPayload = Record<string, string>;

type Tracking = {
  email: string;
  ttclid: string;
  ttp: string;
};

export const Route = createFileRoute("/api/public/digistore24-ipn")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const passphrase = process.env.DIGISTORE24_IPN_PASSPHRASE;
        if (!passphrase) {
          console.error("[DS24 IPN] DIGISTORE24_IPN_PASSPHRASE is not configured");
          return textResponse("ERROR: IPN passphrase is not configured", 500);
        }

        let payload: IpnPayload;
        try {
          payload = await parseIpnPayload(request);
        } catch (error) {
          console.error("[DS24 IPN] Invalid request body", error);
          return textResponse("ERROR: invalid request body", 400);
        }

        const receivedSignature = payload.sha_sign ?? payload.SHASIGN ?? "";
        const expectedSignature = await createDigistoreSignature(passphrase, payload);
        if (!secureEqual(receivedSignature.toUpperCase(), expectedSignature)) {
          console.error("[DS24 IPN] Invalid SHA-512 signature", {
            content_type: request.headers.get("content-type") ?? "",
            keys: Object.keys(payload).sort(compareAscii),
          });
          return textResponse("ERROR: invalid sha signature", 401);
        }

        const event = payload.event ?? "";
        if (event === "connection_test") {
          return textResponse("OK");
        }
        if (event !== "on_payment") {
          console.log("[DS24 IPN] Ignoring event", event);
          return textResponse("OK");
        }

        // Unpacked before the test-mode check on purpose: a test order is the only
        // way to confirm `custom` survived the checkout link, so the log has to
        // report what arrived even when no pixel event is sent.
        const tracking = unpackTracking(payload.custom);

        if ((payload.api_mode ?? "").toLowerCase() !== "live") {
          console.log("[DS24 IPN] Test payment acknowledged without pixel event", {
            has_ttclid: Boolean(tracking.ttclid),
            has_ttp: Boolean(tracking.ttp),
            has_packed_email: Boolean(tracking.email),
          });
          return textResponse("OK");
        }

        // Digistore24 retries a failed IPN at least 20 times over 10 days. TikTok
        // discards duplicates of the same event_source_id + event + event_id within
        // 48h, so replaying is safe.
        const delivered = await sendToTikTok(payload, tracking);
        if (!delivered) {
          // Non-2xx on purpose so Digistore24 re-sends instead of losing the sale.
          return textResponse("ERROR: TikTok event delivery failed", 502);
        }

        console.log("[DS24 IPN] Purchase delivered", {
          order_id: payload.order_id ?? "",
          event_id: buildEventId(payload),
          has_ttclid: Boolean(tracking.ttclid),
          has_ttp: Boolean(tracking.ttp),
          has_packed_email: Boolean(tracking.email),
        });
        return textResponse("OK");
      },
    },
  },
});

/* ---------------------------------------------------------------- tracking */

/**
 * `custom` carries the base64url payload written by ds24-tracking.js. Orders placed
 * before that script shipped put the buyer email there as plain text, so both shapes
 * are read. A payload that will not decode degrades to empty tracking rather than
 * failing the IPN — the purchase still reaches TikTok, just with weaker matching.
 */
function unpackTracking(raw: string | undefined): Tracking {
  const empty: Tracking = { email: "", ttclid: "", ttp: "" };

  const value = (raw ?? "").trim();
  if (!value) return empty;
  if (value.includes("@")) return { ...empty, email: value.toLowerCase() };

  try {
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
    // Positional payload written by ds24-tracking.js: email|ttclid|ttp.
    const [email = "", ttclid = "", ttp = ""] = new TextDecoder().decode(bytes).split("|");

    return {
      email: email.trim().toLowerCase(),
      ttclid: ttclid.trim(),
      ttp: ttp.trim(),
    };
  } catch {
    console.warn("[DS24 IPN] Could not decode custom payload", { length: value.length });
    return empty;
  }
}

/**
 * The checkout prefills Digistore24 with a deliberately altered email, so the address
 * the IPN reports is not the real one. The packed payload holds what the buyer
 * actually typed; fall back to the IPN field for orders that never went through our
 * form (back-redirect straight to checkout).
 */
function resolveEmail(payload: IpnPayload, tracking: Tracking) {
  const candidate = tracking.email || payload.email || payload.buyer_email || "";
  const email = candidate.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : "";
}

/* ------------------------------------------------------------------ tiktok */

async function sendToTikTok(payload: IpnPayload, tracking: Tracking) {
  const accessToken = process.env.TIKTOK_ACCESS_TOKEN;
  if (!accessToken) {
    console.error("[DS24 IPN] TIKTOK_ACCESS_TOKEN is not configured");
    return false;
  }

  const pixelIds = (process.env.TIKTOK_PIXEL_IDS ?? DEFAULT_PIXEL_ID)
    .split(",")
    .map((pixelId) => pixelId.trim())
    .filter(Boolean);

  if (pixelIds.length === 0) {
    console.error("[DS24 IPN] No TikTok pixel is configured");
    return false;
  }

  const results = await Promise.all(
    pixelIds.map((pixelId) => sendCompletePayment(accessToken, pixelId, payload, tracking)),
  );
  return results.every(Boolean);
}

async function sendCompletePayment(
  accessToken: string,
  pixelId: string,
  payload: IpnPayload,
  tracking: Tracking,
) {
  const email = resolveEmail(payload, tracking);
  const phone = normalizePhone(payload.address_phone_no ?? "");
  const orderId = payload.order_id ?? "";
  const value = toNumber(payload.transaction_amount ?? payload.amount_brutto);
  const quantity = Math.max(1, Math.trunc(toNumber(payload.quantity)) || 1);

  // Identifiers are hashed; the TikTok click id and cookie id are sent raw.
  const user: Record<string, string> = {};
  if (email) user.email = await sha256(email);
  if (phone) user.phone = await sha256(phone);
  if (orderId) user.external_id = await sha256(orderId.toLowerCase());
  if (tracking.ttclid) user.ttclid = tracking.ttclid;
  if (tracking.ttp) user.ttp = tracking.ttp;

  const response = await fetch(TIKTOK_EVENTS_API, {
    method: "POST",
    headers: {
      "Access-Token": accessToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      event_source: "web",
      event_source_id: pixelId,
      data: [
        {
          event: "CompletePayment",
          event_time: parseEventTime(payload.transaction_processed_at),
          event_id: buildEventId(payload),
          user,
          properties: {
            currency: (payload.transaction_currency ?? payload.currency ?? "USD").toUpperCase(),
            value,
            order_id: orderId,
            contents: [
              {
                content_id: payload.product_id ?? "unknown",
                content_type: "product",
                content_name: payload.product_name ?? "",
                quantity,
                price: value / quantity,
              },
            ],
          },
          page: {
            url: payload.receipt_url ?? "https://northcrestdigital.life/thanks",
          },
        },
      ],
    }),
  }).catch((error: unknown) => {
    console.error("[DS24 IPN] TikTok request failed", error);
    return null;
  });

  if (!response) return false;

  const result = (await response.json().catch(() => ({}))) as { code?: number; message?: string };
  const sent = response.ok && (result.code == null || result.code === 0);
  if (!sent) {
    console.error("[DS24 IPN] TikTok rejected event", {
      code: result.code ?? response.status,
      message: result.message ?? "",
      pixel_id: pixelId,
    });
  }
  return sent;
}

function buildEventId(payload: IpnPayload) {
  const paymentId = payload.payment_id ?? payload.transaction_id ?? payload.order_id ?? "unknown";
  const productId = payload.product_id ?? "unknown";
  return `ds24_${paymentId}_${productId}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120);
}

function parseEventTime(raw: string | undefined) {
  if (raw) {
    const normalized = raw.includes("T") ? raw : raw.replace(" ", "T");
    const timestamp = Date.parse(normalized);
    if (Number.isFinite(timestamp)) return Math.floor(timestamp / 1000);
  }
  return Math.floor(Date.now() / 1000);
}

function normalizePhone(raw: string) {
  const digits = raw.replace(/\D/g, "");
  if (!digits) return "";
  if (raw.trim().startsWith("+")) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return `+${digits}`;
}

function toNumber(raw: string | undefined) {
  const value = Number(raw ?? 0);
  return Number.isFinite(value) ? value : 0;
}

/* ----------------------------------------------------------------- shared */

async function parseIpnPayload(request: Request): Promise<IpnPayload> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const json = (await request.json()) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(json).map(([key, value]) => [key, value == null ? "" : String(value)]),
    );
  }

  if (
    contentType.includes("application/x-www-form-urlencoded") ||
    contentType.includes("multipart/form-data")
  ) {
    const form = await request.formData();
    const payload: IpnPayload = {};
    form.forEach((value, key) => {
      if (typeof value === "string") payload[key] = value;
    });
    return payload;
  }

  const body = await request.text();
  return Object.fromEntries(new URLSearchParams(body));
}

/**
 * Digistore24 signs every IPN: sort the non-empty parameters by name, concatenate
 * "key=value" with the passphrase appended to each, and SHA-512 the result.
 */
async function createDigistoreSignature(passphrase: string, payload: IpnPayload) {
  const signatureInput = Object.keys(payload)
    .filter((key) => key !== "sha_sign" && key !== "SHASIGN" && payload[key] !== "")
    .sort(compareAscii)
    .map((key) => `${key}=${payload[key]}${passphrase}`)
    .join("");

  const digest = await crypto.subtle.digest("SHA-512", new TextEncoder().encode(signatureInput));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

function compareAscii(left: string, right: string) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function secureEqual(left: string, right: string) {
  if (left.length !== right.length || left.length === 0) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function textResponse(body: string, status = 200) {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
