import { describe, it, expect } from "vitest";
import { computeWebhookHmac, verifyWebhookHmac } from "../../src/whatsapp/webhook";

// Authoritative test vector from the WAHA docs.
const VECTOR_BODY = '{"event":"message","session":"default","engine":"WEBJS"}';
const VECTOR_KEY = "my-secret-key";
const VECTOR_HMAC =
  "208f8a55dde9e05519e898b10b89bf0d0b3b0fdf11fdbf09b6b90476301b98d8097c462b2b17a6ce93b6b47a136cf2e78a33a63f6752c2c1631777076153fa89";

describe("computeWebhookHmac", () => {
  it("matches the WAHA reference vector (sha512, hex, raw body)", () => {
    expect(computeWebhookHmac(VECTOR_KEY, VECTOR_BODY)).toBe(VECTOR_HMAC);
  });
});

describe("verifyWebhookHmac", () => {
  it("accepts a correct signature", () => {
    expect(verifyWebhookHmac(VECTOR_KEY, Buffer.from(VECTOR_BODY), VECTOR_HMAC)).toBe(true);
  });
  it("rejects a wrong signature", () => {
    expect(verifyWebhookHmac(VECTOR_KEY, Buffer.from(VECTOR_BODY), "deadbeef")).toBe(false);
  });
  it("rejects a missing signature", () => {
    expect(verifyWebhookHmac(VECTOR_KEY, Buffer.from(VECTOR_BODY), undefined)).toBe(false);
  });
  it("rejects when the raw body is unavailable", () => {
    expect(verifyWebhookHmac(VECTOR_KEY, undefined, VECTOR_HMAC)).toBe(false);
  });
});
