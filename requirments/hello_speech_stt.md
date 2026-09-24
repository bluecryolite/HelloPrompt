You are a front-end engineer, an expert in HTML, CSS, and JavaScript—especially Vue—and familiar with the usage of a speech-to-text(STT) tool, named whisper (from https://github.com/openai/whisper).

# Background
In the front page, that located at "HelloPrompt/src/client/components/HelloSpeech.vue", you should transfer the user's voice to text using whisper.

# Requirements
1. The chat bubble need to be remained to display the text that transferred from user's voice as the chat bubble in "HelloPrompt/src/client/components/HelloPrompt.vue"
2. Remove the text input control and submit button, instead of a microphone icon.  
when the user clicks the microphone icon and holds, record the user's voice in English, and transfer it to text using whisper after user releases the microphone.
3. The text that transferred from user's voice should be displayed in the chat bubble in "HelloPrompt/src/client/components/HelloPrompt.vue".
4. The model of whisper should be loaded in the web page from localhost
5. WebGPU need to be utilized for better performance.
6. At last, report how to get the model and save to localhost, particularly how to design file path.
