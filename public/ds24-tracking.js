/**
 * Builds the Digistore24 sub-ID parameters that carry the TikTok match keys.
 *
 * As an affiliate the postback only returns the macros Digistore24 offers, and that
 * list has no buyer email and no click identifiers. `sid1`-`sid5` are the only
 * free-form slots, so ttclid, ttp and the buyer's real email ride in there.
 *
 * The real email matters because the checkout deliberately prefills Digistore24
 * with an altered address (see tweakEmail in redeem-patch.js).
 *
 * UTMs are NOT packed here — Digistore24 stores them natively and returns them as
 * {utm_source} and friends, which is how Utmify reads them.
 *
 * The payload is "email|ttclid|ttp" -> base64url without padding (alphabet
 * A-Z a-z 0-9 - _, safe in a URL and in Digistore24's fields), then split across the
 * five sub-IDs because each one is length-limited. The pipe-delimited form is used
 * over JSON because its punctuation costs ~30 encoded characters we cannot spare.
 */
(function () {
  // Digistore24 does not document the sub-ID length; 45 stays under the limits it
  // documents for comparable fields (trackingkey 47, custom 63). Five slots give
  // 225 characters, enough for a long ttclid plus ttp plus an email.
  var CHUNK_SIZE = 45;
  var MAX_CHUNKS = 5;
  var TRACKING_STORE_KEY = "tiktok_tracking_params";

  // Positional payload: email, ttclid, ttp. Order matters twice — the server reads
  // these positions, and the weakest match key (ttp) sits last so it is the first
  // dropped when the payload will not fit.
  var SEPARATOR = "|";

  function readTrackingStore() {
    try {
      return JSON.parse(localStorage.getItem(TRACKING_STORE_KEY) || "{}") || {};
    } catch (error) {
      return {};
    }
  }

  function readCookie(name) {
    var escaped = name.replace(/([.$?*|{}()[\]\\/+^])/g, "\\$1");
    var match = document.cookie.match(new RegExp("(?:^|; )" + escaped + "=([^;]*)"));
    return match ? decodeURIComponent(match[1]) : "";
  }

  function pick(params, store, key) {
    return String(params.get(key) || store[key] || "").trim();
  }

  function base64url(text) {
    var bytes = new TextEncoder().encode(text);
    var binary = "";
    for (var index = 0; index < bytes.length; index++) {
      binary += String.fromCharCode(bytes[index]);
    }
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function collect(email) {
    var params = new URLSearchParams(window.location.search);
    var store = readTrackingStore();

    return [
      String(email || "").trim().toLowerCase(),
      pick(params, store, "ttclid") || readCookie("ttclid"),
      readCookie("_ttp") || pick(params, store, "ttp"),
    ];
  }

  function pack(email) {
    var fields = collect(email);

    while (fields.length) {
      // Trailing empties carry no information, so never spend characters on them.
      if (!fields[fields.length - 1]) {
        fields.pop();
        continue;
      }

      var encoded = base64url(fields.join(SEPARATOR));
      if (encoded.length <= CHUNK_SIZE * MAX_CHUNKS) return encoded;
      fields.pop();
    }

    return "";
  }

  /** Returns { sid1: "...", sid2: "..." } to append to the checkout URL. */
  function trackingParams(email) {
    var packed = pack(email);
    var params = {};

    for (var index = 0; index < MAX_CHUNKS; index++) {
      var chunk = packed.substr(index * CHUNK_SIZE, CHUNK_SIZE);
      if (!chunk) break;
      params["sid" + (index + 1)] = chunk;
    }

    return params;
  }

  window.ds24TrackingParams = trackingParams;
})();
