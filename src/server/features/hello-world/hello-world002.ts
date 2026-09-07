import { createCopilotClient, createSession } from "./core.js";

const client = createCopilotClient();
const session = await createSession(client, { streaming: true });

session.on("assistant.message_delta", (event) => {
    process.stdout.write(event.data.deltaContent);
});

session.on("session.idle", () => {
    console.log(); // New line when done;
})

await session.sendAndWait({ prompt: "Tell me a short joke." });

await client.stop();
process.exit(0);
