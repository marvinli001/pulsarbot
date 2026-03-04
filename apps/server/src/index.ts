import { createApp } from "./app.js";

const app = await createApp();
const port = Number(process.env.PORT ?? 3000);

await app.listen({
  host: "0.0.0.0",
  port,
});
