import { createCopilotClient, createSession } from "./core.js";

const client = createCopilotClient();
const session = await createSession(client);
const response = await session.sendAndWait({ prompt: "What is 2+2?" });
console.log(response);
console.log(response?.data.content);

await client.stop();
process.exit(0);
