// Use relative path - works with Pages Functions proxy in both dev and production
const API_BASE_PATH = '/api';
let currentLectureId = 'lecture-12345';
// Get the DOM elements

chatInput = document.getElementById("chat-input");
sendButton = document.getElementById("send-button");
chatWindow = document.getElementById("chat-window");


// Message Display Function
function displayMessage(text, role){
    // Create a new div element
    const messageElement = document.createElement('div');
    // Set its class to include message and the role
    messageElement.classList.add('message', role);
    // Set its text content
    messageElement.textContent = text;
    // Apend the new div to the chat-window
    chatWindow.appendChild(messageElement);
    // Implement auto-scrolling
    chatWindow.scrollTop = chatWindow.scrollHeight;

    return messageElement;
}

// Handle Send Message
async function sendMessage(){
    // Get the message and trim whitespace
    const messageText = chatInput.value.trim();

    // Check if message is empty
    if (messageText === ""){
        return;
    }

    // Display the user's message and clear the input
    displayMessage(messageText, 'user');
    chatInput.value = '';

    // ------ This is the loading state ------

    // Disable the input and send button immediately after user send messages
    chatInput.disable = true;
    sendButton.disable = true;

    // Display the loading assistant response
    const loadingMessage = displayMessage("Thinking...", 'assistant')

    try {
    // Await the result of callChatAPI
    const aiResponse = await callChatAPI(messageText);

    // Display the AI response
    loadingMessage.textContent = aiResponse;
    } catch (error){
        console.log("Chat Error:", error);
        loadingMessage.textContent = `Error: ${error.message}. Please try again.`;
    } finally {
        // ------ End loading state ------
        // Re-enable the UI
        chatInput.disable = false;
        sendButton.disable = false;
    }


}

// Handle Send Button Click
sendButton.addEventListener('click', sendMessage);

// Handle Enter Key Press
chatInput.addEventListener('keypress', function(event) {
    if (event.key === 'Enter'){
        event.preventDefault();
        sendMessage();
    }
})

// callChatAPI function
async function callChatAPI(message) {
    // Construct the full URL
    const url = `${API_BASE_PATH}/chat/${currentLectureId}`;

    try {
        // Use the global fetch to send the POST request
        const response = await fetch(url, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({message: message})
    });

    // Check the HTTP errors
    if (!response.ok){
        const errorBody = await response.json;
        throw new Error(`API Error (${response.status}): ${errorBody.error || errorBody.message || 'Unknown error'}`);
    }

    // Parsing the JSON body and return the AI response
    const data = await response.json();
    return data.response;

    } catch (error){
        console.log(`Fetch failed:`, error);
        throw new Error(`Chat failed: ${error.message}`);
    }
    
}