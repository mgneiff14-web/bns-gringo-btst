import { createFileRoute } from "@tanstack/react-router";

const TIKTOK_EVENTS_API = "https://business-api.tiktok.com/open_api/v1.3/event/track/";
const DEFAULT_PIXEL_ID = "D9K1G33C77U820ARO52G";

/**
 * Digistore24 affiliate S2S postback -> TikTok Ads Events API.
 *
 * This is the AFFILIATE postback (Account > S2S Postback), not the vendor IPN
 * (Settings > IPN, which an affiliate account does not have). Consequences:
 *
 *   - it arrives as a GET, not a POST
 *   - there is no sha_sign to verify, so the URL carries a shared secret instead
 *   - only the macros we put in the URL arrive, and Digistore24 offers no macro
 *     for the buyer email, ttclid or ttp — those come from sid1..sid5, which
 *     ds24-tracking.js writes onto the checkout link
 *
 * Utmify is NOT handled here: it has its own native Digistore24 postback that
 * reads the {utm_*} macros. This endpoint only covers what that cannot.
 *
 * URL to register in Digistore24 (one line, replace HOST and TOKEN):
 *   https://HOST/api/public/digistore24-ipn?token=TOKEN
 *     &transactionType={transaction_type}&transactionId={transaction_id}
 *     &orderId={order_id}&productId={product_id}&productName={product_name}
 *     &amount={amount_brutto_abs}&currency={currency}&country={country}
 *     &isTest={is_test}&datetime={datetime_utc}
 *     &s1={sid1}&s2={sid2}&s3={sid3}&s4={sid4}&s5={sid5}&r={random}
 */

type Tracking = {
  email: string;
  ttclid: string;
  ttp: string;
};

export const Route = createFileRoute("/api/public/digistore24-ipn")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const expectedToken = process.env.DIGISTORE24_POSTBACK_TOKEN;
        if (!expectedToken) {
          console.error("[DS24 Postback] DIGISTORE24_POSTBACK_TOKEN is not configured");
          return textResponse("ERROR: postback token is not configured", 500);
        }

        const params = new URL(request.url).searchParams;

        if (!secureEqual(params.get("token") ?? "", expectedToken)) {
          console.error("[DS24 Postback] Invalid token");
          return textResponse("ERROR: invalid token", 401);
        }

        // {transaction_type} is payment | refund | chargeback. Only a payment maps
        // to CompletePayment; TikTok has no server event for the other two.
        const transactionType = (params.get("transactionType") ?? "").toLowerCase();
        if (transactionType !== "payment") {
          console.log("[DS24 Postback] Ignoring transaction type", transactionType || "(empty)");
          return textResponse("OK");
        }

        // {is_test} is "1" for a test payment and empty for a real one.
        if ((params.get("isTest") ?? "").trim() === "1") {
          console.log("[DS24 Postback] Test payment acknowledged without pixel event");
          return textResponse("OK");
        }

        const tracking = unpackTracking(params);

        const delivered = await sendToTikTok(params, tracking);
        if (!delivered) {
          // Non-2xx on purpose so Digistore24 re-sends instead of losing the sale.
          return textResponse("ERROR: TikTok event delivery failed", 502);
        }

        console.log("[DS24 Postback] Purchase delivered", {
          order_id: params.get("orderId") ?? "",
          event_id: buildEventId(params),
          has_ttclid: Boolean(tracking.ttclid),
          has_ttp: Boolean(tracking.ttp),
          has_email: Boolean(tracking.email),
        });
        return textResponse("OK");
      },
    },
  },
});

/* ---------------------------------------------------------------- tracking */

/**
 * Reassembles the base64url payload that ds24-tracking.js split across sid1..sid5.
 * A truncated or absent payload degrades to empty tracking rather than failing the
 * postback — the purchase still reaches TikTok, just with weaker matching.
 */
function unpackTracking(params: URLSearchParams): Tracking {
  const empty: Tracking = { email: "", ttclid: "", ttp: "" };

  const packed = ["s1", "s2", "s3", "s4", "s5"]
    .map((key) => (params.get(key) ?? "").trim())
    .join("");

  if (!packed) return empty;

  try {
    const base64 = packed.replace(/-/g, "+").replace(/_/g, "/");
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
    // Most likely cause: a sub-ID is shorter than the chunk size and truncated it.
    console.warn("[DS24 Postback] Could not decode sub-ID payload", {
      length: packed.length,
    });
    return empty;
  }
}

/* ------------------------------------------------------------------ tiktok */

async function sendToTikTok(params: URLSearchParams, tracking: Tracking) {
  const accessToken = process.env.TIKTOK_ACCESS_TOKEN;
  if (!accessToken) {
    console.error("[DS24 Postback] TIKTOK_ACCESS_TOKEN is not configured");
    return false;
  }

  const pixelIds = (process.env.TIKTOK_PIXEL_IDS ?? DEFAULT_PIXEL_ID)
    .split(",")
    .map((pixelId) => pixelId.trim())
    .filter(Boolean);

  if (pixelIds.length === 0) {
    console.error("[DS24 Postback] No TikTok pixel is configured");
    return false;
  }

  const results = await Promise.all(
    pixelIds.map((pixelId) => sendCompletePayment(accessToken, pixelId, params, tracking)),
  );
  return results.every(Boolean);
}

async function sendCompletePayment(
  accessToken: string,
  pixelId: string,
  params: URLSearchParams,
  tracking: Tracking,
) {
  const orderId = params.get("orderId") ?? "";
  const value = toNumber(params.get("amount"));

  // Identifiers are hashed; the TikTok click id and cookie id are sent raw.
  const user: Record<string, string> = {};
  if (isEmail(tracking.email)) user.email = await sha256(tracking.email);
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
          event_time: parseEventTime(params.get("datetime")),
          event_id: buildEventId(params),
          user,
          properties: {
            currency: (params.get("currency") || "USD").toUpperCase(),
            value,
            order_id: orderId,
            contents: [
              {
                content_id: params.get("productId") ?? "unknown",
                content_type: "product",
                content_name: params.get("productName") ?? "",
                quantity: 1,
                price: value,
              },
            ],
          },
        },
      ],
    }),
  }).catch((error: unknown) => {
    console.error("[DS24 Postback] TikTok request failed", error);
    return null;
  });

  if (!response) return false;

  const result = (await response.json().catch(() => ({}))) as { code?: number; message?: string };
  const sent = response.ok && (result.code == null || result.code === 0);
  if (!sent) {
    console.error("[DS24 Postback] TikTok rejected event", {
      code: result.code ?? response.status,
      message: result.message ?? "",
      pixel_id: pixelId,
    });
  }
  return sent;
}

/**
 * TikTok discards duplicates of the same event_source_id + event + event_id within
 * 48h, which is what makes Digistore24's postback retries safe.
 */
function buildEventId(params: URLSearchParams) {
  const transactionId = params.get("transactionId") || params.get("orderId") || "unknown";
  const productId = params.get("productId") || "unknown";
  return `ds24_${transactionId}_${productId}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120);
}

/** {datetime_utc} is "YYYY-MM-DDTHH:MM:SS" in UTC, without an offset suffix. */
function parseEventTime(raw: string | null) {
  const value = (raw ?? "").trim();
  if (value) {
    const normalized = /(Z|[+-]\d{2}:?\d{2})$/.test(value) ? value : `${value}Z`;
    const timestamp = Date.parse(normalized);
    if (Number.isFinite(timestamp)) return Math.floor(timestamp / 1000);
  }
  return Math.floor(Date.now() / 1000);
}

function isEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function toNumber(raw: string | null) {
  const value = Number(raw ?? 0);
  return Number.isFinite(value) ? value : 0;
}

/* ----------------------------------------------------------------- shared */

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
