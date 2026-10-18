// Node-only stand-in for the Workers runtime module `cloudflare:sockets`,
// aliased in vitest.config.ts. The unit tests inject their own transports;
// this exists so modules that import the real thing (src/smtp-socket.ts,
// src/imap-socket.ts) can be loaded by vitest. Any attempt to actually
// connect fails loudly rather than silently succeeding.

export function connect(): never {
  throw new Error("cloudflare:sockets is not available under Node; inject a socket factory in the test");
}
