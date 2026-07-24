import { describe, expect, it } from "vitest";
import {
  CompositeSecretResolver,
  EnvironmentSecretResolver,
  assertSecretReference,
} from "../src/integrations/secrets.js";

describe("integration secret references", () => {
  it("resolves explicitly named environment values", async () => {
    const resolver = new EnvironmentSecretResolver({
      YOGI_TEST_KEY: "private-value",
    });
    await expect(resolver.resolve("env:YOGI_TEST_KEY")).resolves.toBe(
      "private-value",
    );
    await expect(resolver.resolve("env:MISSING")).rejects.toThrow("is not set");
  });

  it("rejects references that could contain a credential", () => {
    expect(assertSecretReference(" env:SMARTLEAD_API_KEY ")).toBe(
      "env:SMARTLEAD_API_KEY",
    );
    expect(() => assertSecretReference("actual-api-key")).toThrow(
      "must use env:VARIABLE_NAME",
    );
    expect(() => assertSecretReference("env:lowercase")).toThrow(
      "must use env:VARIABLE_NAME",
    );
  });

  it("supports future secret backends through composition", async () => {
    const resolver = new CompositeSecretResolver([
      { resolve: async () => Promise.reject(new Error("not mine")) },
      { resolve: async () => "resolved-by-second-backend" },
    ]);
    await expect(resolver.resolve("keychain:yogi/test")).resolves.toBe(
      "resolved-by-second-backend",
    );
  });
});
