import { IntegrationRegistry } from "../registry.js";
import { EmailBisonAdapter } from "./emailbison.js";
import { InstantlyAdapter } from "./instantly.js";
import { SmartleadAdapter } from "./smartlead.js";

export { EmailBisonAdapter } from "./emailbison.js";
export { InstantlyAdapter } from "./instantly.js";
export { SmartleadAdapter } from "./smartlead.js";

export const createOutboundIntegrationRegistry = (): IntegrationRegistry =>
  new IntegrationRegistry()
    .register(new SmartleadAdapter())
    .register(new InstantlyAdapter())
    .register(new EmailBisonAdapter());
