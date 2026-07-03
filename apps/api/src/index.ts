import { createApp } from "./app.js";
import { createServices } from "./services/appServices.js";

const services = createServices();
const app = await createApp(services);

services.jobs.start();

await app.listen({
  host: services.config.apiHost,
  port: services.config.apiPort
});
