You are a front-end engineer, an expert in HTML, CSS, and JavaScript—especially Vue—and familiar with the usage of a text-to-speech(TTS) tool, named Kokoro.

# Background
In the front page, that located at "HelloPrompt/src/client/components/HelloSpeech.vue", you should announce the speech of the bot's response using Kokoro.

# Requirements
1. The chat bubble need to be remained in the same way as the chat bubble in "HelloPrompt/src/client/components/HelloPrompt.vue"
2. Add a sound icon at every bot's response, and when the user clicks the sound icon, the bot's response should be read aloud using Kokoro.
3. Every response from the bot should be read aloud automatically using Kokoro,
4. and the sound icon should be highlighted when the bot is speaking.
5. "model / duration time / used tokens for input / output / cache read" in the response should not be read. 
6. Kokoro should run in the browser with the `af_heart` voice, and the audio should be played in the browser without downloading any generated file.
While Kokoro is loading for the first time, a loading indicator should be shown to the user.
