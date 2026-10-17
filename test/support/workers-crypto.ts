// Workers' crypto.subtle has timingSafeEqual; Node's WebCrypto does not.
// Loaded by vitest before test files (vitest.config.ts) so the same auth code
// runs unchanged under Node. Pure JS: the repo carries no @types/node.
function toBytes(value: ArrayBuffer | ArrayBufferView): Uint8Array {
  return value instanceof ArrayBuffer
    ? new Uint8Array(value)
    : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

if (typeof crypto.subtle.timingSafeEqual !== "function") {
  crypto.subtle.timingSafeEqual = (a, b) => {
    const x = toBytes(a);
    const y = toBytes(b);
    if (x.byteLength !== y.byteLength) {
      throw new RangeError("inputs must have the same byte length");
    }
    let diff = 0;
    for (let i = 0; i < x.byteLength; i++) diff |= x[i] ^ y[i];
    return diff === 0;
  };
}
