You are a front-end engineer, an expert in HTML, CSS, and JavaScript—especially Vue—and familiar with the usage of the GitHub Copilot API.

# Background
I need a chatbot interface that can respond to user input with speech. It's only a shell, without handling the actual speech.

# Requirements
1. A simple service should be created to handle the communication with the bot.
    - The service has two arguments: the user input and the sessionId.
    - If the sessionId is not provided, the service should generate a new sessionId.
    - Check if the sessionId is existing by calling GitHub Copilot API. If it doesn't exist, return a message indicating wrong request and refresh page.
    - Return the bot's response, sessionId, calling model, duration time, and used tokens for input / output / cache read / cache write.
2. A simple page should be created to show the chat interface, which includes:
    - A text input field for user input.
    - A button to submit the user input.
    - A chat bubble format to display the user's input on the right and the bot's response on the left, under the input field.
    - model / duration time / used tokens for input / output / cache read / cache write should be hidden first after the response, and shown with a link button "more".
3. sessionId need be managed from the first user input, and it should be sent with every subsequent request to the bot.  
If the local sessionId is not equal to the sessionId returned from the bot, indicating wrong request and refresh page.
4. This page address need be added to client/App.vue 

