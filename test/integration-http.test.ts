import { describe, expect, it, vi } from "vitest";
import {
  normalizeProviderBaseUrl,
  requestProviderJson,
} from "../src/integrations/http.js";
import {
  ExternalOutcomeUnknownError,
  ProviderHttpError,
} from "../src/integrations/errors.js";
import type { ProviderContext } from "../src/integrations/types.js";

const context = (fetchMock: typeof fetch): ProviderContext => ({
  connection: {
    id: "connection-1",
    provider: "instantly",
    category: "outbound",
    name: "Instantly",
    secretRef: "env:INSTANTLY_API_KEY",
    status: "verified",
    metadata: {},
    createdAt: "2026-07-24T12:00:00.000Z",
    updatedAt: "2026-07-24T12:00:00.000Z",
  },
  secret: "secret",
  fetch: fetchMock,
});

describe("provider HTTP boundary", () => {
  it("rejects secret-bearing or insecure custom base URLs", () => {
    expect(normalizeProviderBaseUrl("https://mail.example.com/")).toBe(
      "https://mail.example.com",
    );
    expect(() => normalizeProviderBaseUrl("http://mail.example.com")).toThrow(
      "must use HTTPS",
    );
    expect(() =>
      normalizeProviderBaseUrl("https://token@mail.example.com"),
    ).toThrow("cannot contain credentials");
    expect(() =>
      normalizeProviderBaseUrl("https://mail.example.com?token=secret"),
    ).toThrow("cannot contain credentials");
  });

  it("treats unreadable mutation responses as unknown outcomes", async () => {
    const unreadable = {
      ok: true,
      status: 200,
      text: vi.fn(async () => {
        throw new Error("stream ended");
      }),
    } as unknown as Response;
    const fetchMock = vi.fn(async () => unreadable) as unknown as typeof fetch;

    await expect(
      requestProviderJson(context(fetchMock), {
        provider: "Instantly",
        baseUrl: "https://api.instantly.ai/api/v2",
        path: "/campaigns",
        method: "POST",
        body: { name: "Draft" },
      }),
    ).rejects.toBeInstanceOf(ExternalOutcomeUnknownError);

    await expect(
      requestProviderJson(context(fetchMock), {
        provider: "Instantly",
        baseUrl: "https://api.instantly.ai/api/v2",
        path: "/accounts",
      }),
    ).rejects.toBeInstanceOf(ProviderHttpError);
  });

  it("rejects unserializable bodies before invoking fetch", async () => {
    const fetchMock = vi.fn() as unknown as typeof fetch;
    const circular: { self?: unknown } = {};
    circular.self = circular;
    await expect(
      requestProviderJson(context(fetchMock), {
        provider: "Instantly",
        baseUrl: "https://api.instantly.ai/api/v2",
        path: "/campaigns",
        method: "POST",
        body: circular,
      }),
    ).rejects.toThrow("circular");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
