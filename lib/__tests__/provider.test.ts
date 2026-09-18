import { describe, it, expect } from "vitest";
import { isAnthropicKeyFormat, providerFor } from "../provider";
import { anthropic } from "@ai-sdk/anthropic";

describe("isAnthropicKeyFormat", () => {
  it("accepts a well-formed key", () => {
    expect(isAnthropicKeyFormat("sk-ant-api03-" + "a".repeat(40))).toBe(true);
  });
  it("trims surrounding whitespace", () => {
    expect(isAnthropicKeyFormat("  sk-ant-" + "b".repeat(30) + "  ")).toBe(true);
  });
  it("rejects junk, wrong prefix, and non-strings", () => {
    expect(isAnthropicKeyFormat("hello")).toBe(false);
    expect(isAnthropicKeyFormat("sk-ant-short")).toBe(false);
    expect(isAnthropicKeyFormat("sk-proj-" + "a".repeat(40))).toBe(false);
    expect(isAnthropicKeyFormat(12345)).toBe(false);
    expect(isAnthropicKeyFormat(undefined)).toBe(false);
  });
});

describe("providerFor", () => {
  it("returns the ambient provider when no key is given", () => {
    expect(providerFor()).toBe(anthropic);
  });
  it("returns a distinct provider instance for a user key", () => {
    const p = providerFor("sk-ant-" + "c".repeat(30));
    expect(p).not.toBe(anthropic);
    expect(typeof p).toBe("function");
  });
});
