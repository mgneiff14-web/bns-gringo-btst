/**
 * Builds the Digistore24 `custom` parameter that carries the TikTok match keys.
 *
 * The vendor IPN reports the buyer email Digistore24 has on file, which is the
 * deliberately altered one the checkout prefills (see tweakEmail in redeem-patch.js),
 * and it has no field at all for ttclid or ttp. `custom` is the only free-form value
 * Digistore24 hands back, so all three ride in there.
 *
 * UTMs are NOT packed here — Digistore24 stores them natively and returns them as
 * {utm_source} and friends, which is how Utmify reads them.
 *
 * The payload is "email|ttclid|ttp" -> base64url without padding. That alphabet
 * (A-Z a-z 0-9 - _) is a subset of what Digistore24 accepts for `custom`, and the
 * pipe-delimited form is used over JSON because its punctuation costs ~30 encoded
 * characters for no benefit.
 */
(function () {
  // Digistore24's current documentation gives `custom` 1023 characters; its older
  // PDF says 63. Cap under the larger figure and degrade if a field will not fit.
  var MAX_PACKED_LENGTH = 1000;
  var TRACKING_STORE_KEY = "tiktok_tracking_params";
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

  /** Positional payload: email, ttclid, ttp. The server reads these positions. */
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
      if (encoded.length <= MAX_PACKED_LENGTH) return encoded;
      // Weakest match key sits last, so it is the first dropped.
      fields.pop();
    }

    return "";
  }

  /** Returns { custom: "..." } to append to the checkout URL, or {} if empty. */
  function trackingParams(email) {
    var packed = pack(email);
    return packed ? { custom: packed } : {};
  }

  window.ds24TrackingParams = trackingParams;
})();
