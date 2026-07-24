import { IntegrationRegistry } from "../registry.js";
import { GoogleAdsAdapter } from "./google.js";
import { LinkedInAdsAdapter } from "./linkedin.js";
import { MetaAdsAdapter } from "./meta.js";
import { TikTokAdsAdapter } from "./tiktok.js";

export { GoogleAdsAdapter } from "./google.js";
export { LinkedInAdsAdapter } from "./linkedin.js";
export { MetaAdsAdapter } from "./meta.js";
export { TikTokAdsAdapter } from "./tiktok.js";

export const registerAdsAdapters = (
  registry: IntegrationRegistry,
): IntegrationRegistry =>
  registry
    .register(new GoogleAdsAdapter())
    .register(new LinkedInAdsAdapter())
    .register(new TikTokAdsAdapter())
    .register(new MetaAdsAdapter());
