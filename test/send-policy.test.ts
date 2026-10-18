import { describe, expect, it } from "vitest";
import { readSendConfig, SEND_HARD_MAXIMA } from "../src/send-policy";
import type { Env } from "../src/types";

function env(overrides: Partial<Env> = {}): Env {
  return { ICLOUD_USER: "owner@example.com", ...overrides } as Env;
}

function config(overrides: Partial<Env> = {}) {
  const result = readSendConfig(env(overrides));
  if (!result.ok) throw new Error(`unexpected config error: ${result.error}`);
  return result.config;
}

describe("readSendConfig", () => {
  it("falls back to the planned defaults", () => {
    const { caps, from, fromName, sentCopy } = config();
    expect(from).toBe("owner@example.com");
    expect(fromName).toBeNull();
    expect(sentCopy).toBe(false);
    expect(caps).toEqual({
      maxPerDay: 20,
      maxRcptsPerDay: 50,
      maxRcptsPerMessage: 5,
      maxBodyBytes: 65_536,
      draftTtlSeconds: 3_600,
      maxOpenDrafts: 20,
    });
  });

  it("reads explicit values and allows a one-second draft TTL for tests", () => {
    const { caps } = config({
      SEND_MAX_PER_DAY: "3",
      SEND_MAX_RCPTS_PER_DAY: "9",
      SEND_MAX_RCPTS_PER_MESSAGE: "2",
      SEND_MAX_BODY_BYTES: "1024",
      SEND_DRAFT_TTL_SECONDS: "1",
      SEND_MAX_OPEN_DRAFTS: "4",
    });
    expect(caps).toEqual({
      maxPerDay: 3,
      maxRcptsPerDay: 9,
      maxRcptsPerMessage: 2,
      maxBodyBytes: 1024,
      draftTtlSeconds: 1,
      maxOpenDrafts: 4,
    });
  });

  it("clamps to the hard maxima and falls back on junk", () => {
    const { caps } = config({
      SEND_MAX_PER_DAY: "9999",
      SEND_MAX_RCPTS_PER_DAY: "-2",
      SEND_MAX_RCPTS_PER_MESSAGE: "abc",
      SEND_MAX_BODY_BYTES: "999999999",
      SEND_DRAFT_TTL_SECONDS: "999999999",
      SEND_MAX_OPEN_DRAFTS: " ",
    });
    expect(caps.maxPerDay).toBe(SEND_HARD_MAXIMA.maxPerDay);
    expect(caps.maxRcptsPerDay).toBe(50);
    expect(caps.maxRcptsPerMessage).toBe(5);
    expect(caps.maxBodyBytes).toBe(SEND_HARD_MAXIMA.maxBodyBytes);
    expect(caps.draftTtlSeconds).toBe(SEND_HARD_MAXIMA.draftTtlSeconds);
    expect(caps.maxOpenDrafts).toBe(20);
  });

  it("treats a zero daily cap as the kill switch and refuses zero elsewhere", () => {
    const { caps } = config({ SEND_MAX_PER_DAY: "0", SEND_MAX_RCPTS_PER_DAY: "0", SEND_MAX_RCPTS_PER_MESSAGE: "0" });
    expect(caps.maxPerDay).toBe(0);
    expect(caps.maxRcptsPerDay).toBe(0);
    expect(caps.maxRcptsPerMessage).toBe(5);
  });

  it("accepts an explicit From and display name", () => {
    const { from, fromName } = config({ SEND_FROM: "alias@icloud.com", SEND_FROM_NAME: " Diego " });
    expect(from).toBe("alias@icloud.com");
    expect(fromName).toBe("Diego");
  });

  it("fails closed on unusable From values", () => {
    for (const overrides of [
      { SEND_FROM: "not an address" },
      { SEND_FROM: "a@b" },
      { SEND_FROM_NAME: "bad\r\nname" },
    ] as Array<Partial<Env>>) {
      const result = readSendConfig(env(overrides));
      expect(result.ok, JSON.stringify(overrides)).toBe(false);
    }
  });

  it("parses SEND_SENT_COPY truthiness", () => {
    expect(config({ SEND_SENT_COPY: "1" }).sentCopy).toBe(true);
    expect(config({ SEND_SENT_COPY: "TRUE" }).sentCopy).toBe(true);
    expect(config({ SEND_SENT_COPY: "yes" }).sentCopy).toBe(false);
  });
});
