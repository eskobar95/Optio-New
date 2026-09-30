import { randomBytes } from "node:crypto";

/**
 * UUIDv7 (RFC 9562): 48-bit unix ms, 12-bit counter in rand_a, 62 random bits.
 * Ids from one generator are strictly increasing, also inside one millisecond
 * and when the clock steps backwards, so they sort by time as text.
 */
export function createUuidv7Generator(clock: () => number = Date.now): () => string {
  let lastMs = -1;
  let counter = 0;

  return () => {
    const now = Math.floor(clock());
    if (now > lastMs) {
      lastMs = now;
      counter = randomBytes(2).readUInt16BE(0) & 0x7ff;
    } else if (counter < 0xfff) {
      counter += 1;
    } else {
      lastMs += 1;
      counter = 0;
    }

    const bytes = randomBytes(16);
    bytes.writeUIntBE(lastMs, 0, 6);
    bytes[6] = 0x70 | (counter >> 8);
    bytes[7] = counter & 0xff;
    bytes[8] = 0x80 | (bytes[8]! & 0x3f);

    const hex = bytes.toString("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };
}

/** The generator every event producer uses. */
export const uuidv7 = createUuidv7Generator();
