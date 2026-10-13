import { createApp } from "./app.js";
import { controlTokenStartupMessage, loadHttpSecurityConfig } from "./httpSecurity.js";
import { createServices } from "./services/appServices.js";

const services = createServices();
const securityConfig = loadHttpSecurityConfig(process.env, services.config.controlTokenPath);
const app = await createApp(services, securityConfig);

services.jobs.start();

await app.listen({
  host: services.config.apiHost,
  port: services.config.apiPort
});

const startupMessage = controlTokenStartupMessage(securityConfig, services.config.frontendOrigin, services.config.controlTokenPath);
if (startupMessage) {
  console.log(startupMessage);
}
