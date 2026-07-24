import { registerAdsAdapters } from "./ads/index.js";
import { createOutboundIntegrationRegistry } from "./outbound/index.js";

export const createIntegrationRegistry = () =>
  registerAdsAdapters(createOutboundIntegrationRegistry());
