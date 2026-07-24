import { describe, expect, it } from "vitest";
import {
  GTM_PLAYBOOKS,
  campaignSlug,
  createCampaignPrompt,
  getStage,
} from "../src/index.js";

const campaign = {
  name: "Founder-Led Launch!",
  product: "Planning assistant",
  audience: "Bootstrapped SaaS founders",
  offer: "Build a launch plan in one afternoon",
  goal: "Book 10 qualified demos",
};

describe("GTM playbooks", () => {
  it("covers the three initial distribution channels", () => {
    expect(Object.keys(GTM_PLAYBOOKS)).toEqual([
      "outbound-email",
      "paid-ads",
      "content",
    ]);
  });

  it("requires approval for external execution stages", () => {
    expect(getStage("outbound-email", "launch").requiresApproval).toBe(true);
    expect(getStage("paid-ads", "launch").requiresApproval).toBe(true);
    expect(getStage("content", "publish").requiresApproval).toBe(true);
    expect(getStage("outbound-email", "sequence-draft").requiresApproval).toBe(
      false,
    );
  });

  it("creates a stable artifact slug", () => {
    expect(campaignSlug(campaign.name)).toBe("founder-led-launch");
  });

  it("builds a preparation prompt that forbids external action", () => {
    const prompt = createCampaignPrompt({
      campaign,
      channel: "outbound-email",
      stage: "sequence-draft",
    });

    expect(prompt).toContain("campaigns/founder-led-launch/");
    expect(prompt).toContain("`sequence.md`");
    expect(prompt).toContain("Do not send email");
    expect(prompt).toContain("Do not invent customer evidence");
  });

  it("builds an execution prompt with explicit scope rules", () => {
    const prompt = createCampaignPrompt({
      campaign,
      channel: "paid-ads",
      stage: "launch",
    });

    expect(prompt).toContain("approved scope, audience, budget");
    expect(prompt).toContain("record every external change");
  });
});
