import { startBoardServer } from "./server.ts";

const port = Number(process.env.PORT ?? 8787);
const redisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";

const server = await startBoardServer({ port, redisUrl, instanceId: process.env.INSTANCE_ID });
console.log(`live-board server ${server.instanceId} on :${server.port}`);

const stop = () => {
  void server.close().then(() => process.exit(0));
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
