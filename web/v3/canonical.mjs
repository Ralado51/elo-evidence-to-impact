/**
 * Elo v3 — Browser-native RFC 8785 (JCS) JSON canonicalizer and SHA-256 helpers.
 *
 * Pure ES module with zero external dependencies and zero Node-only imports,
 * compatible with both Chromium (Web Crypto API) and Node.js 24+.
 */

function sortKeysCodeUnits(keys) {
  return [...keys].sort((a, b) => {
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i += 1) {
      const ca = a.charCodeAt(i);
      const cb = b.charCodeAt(i);
      if (ca !== cb) return ca - cb;
    }
    return a.length - b.length;
  });
}

function serializeNumber(value) {
  if (!Number.isFinite(value)) {
    throw new TypeError(`Non-finite number cannot be canonicalized: ${String(value)}`);
  }
  if (Object.is(value, -0) || value === 0) {
    return "0";
  }
  return JSON.stringify(value);
}

/**
 * Serialize any JSON-compatible value into its RFC 8785 (JCS) canonical string.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
  if (value === null) {
    return "null";
  }
  const type = typeof value;
  if (type === "boolean") {
    return value ? "true" : "false";
  }
  if (type === "number") {
    return serializeNumber(value);
  }
  if (type === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const items = value.map((item) => {
      if (item === undefined || typeof item === "function" || typeof item === "symbol") {
        throw new TypeError("Array contains unsupported non-JSON value.");
      }
      return canonicalJson(item);
    });
    return `[${items.join(",")}]`;
  }
  if (type === "object") {
    const record = /** @type {Record<string, unknown>} */ (value);
    const keys = sortKeysCodeUnits(Object.keys(record));
    const parts = [];
    for (const key of keys) {
      const prop = record[key];
      if (prop === undefined) {
        continue;
      }
      if (typeof prop === "function" || typeof prop === "symbol") {
        throw new TypeError(`Object property "${key}" is not JSON-serializable.`);
      }
      parts.push(`${JSON.stringify(key)}:${canonicalJson(prop)}`);
    }
    return `{${parts.join(",")}}`;
  }
  throw new TypeError(`Unsupported value type for canonical JSON: ${type}`);
}

/**
 * Compute lowercase 64-hex SHA-256 digest of a UTF-8 string using Web Crypto.
 *
 * @param {string} text
 * @returns {Promise<string>}
 */
export async function sha256Hex(text) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error("Web Crypto subtle.digest is not available in this runtime.");
  }
  const bytes = new TextEncoder().encode(text);
  const digestBuffer = await subtle.digest("SHA-256", bytes);
  const view = new Uint8Array(digestBuffer);
  let hex = "";
  for (let i = 0; i < view.length; i += 1) {
    hex += view[i].toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * Compute SHA-256 hex hash of the RFC 8785 canonical JSON of ``value``.
 * Matches CL06.3 ``hash_canonical`` (used for fact content_hash).
 *
 * @param {unknown} value
 * @returns {Promise<string>}
 */
export async function hashCanonical(value) {
  return sha256Hex(canonicalJson(value));
}
