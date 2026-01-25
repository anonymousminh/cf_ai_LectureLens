// Use relative path - works with Pages Functions proxy in both dev and production
const API_BASE_PATH = '/api';
let currentLectureId = null;

let isLoginMode = true; // Track if user is in login mode or signup mode
let authToken = null; // Store the authentication token

// Get the DOM elements for the auth form
const authContainer = document.getElementById("auth-container");
const authForm = document.getElementById("auth-form");
const authTitle = document.getElementById("auth-title");
const authButton = document.getElementById("auth-button");
const authEmail = document.getElementById("auth-email");
const authPassword = document.getElementById("auth-password");
const authToggleLink = document.getElementById("auth-toggle-link");
const mainApp = document.getElementById("main-app");
const logoutButton = document.getElementById("logout-button");
// Get the DOM elements
const chatInput = document.getElementById("chat-input");
const sendButton = document.getElementById("send-button");
const chatWindow = document.getElementById("chat-window");
const lectureUploadInput = document.getElementById("lecture-upload");
const summarizeButton = document.getElementById("summarize-button");
const extractButton = document.getElementById("extract-button");

// Handle Auth Toggle Mode
function toggleAuthMode(mode){
    if (event){
        event.preventDefault();
    }

    isLoginMode = !isLoginMode;

    if (isLoginMode){
        // Switch to login mode
        authTitle.textContent = "Login to LectureLens";
        authButton.textContent = "Login";
        authToggleLink.innerHTML = "Don't have an account? <a href='#'>Sign up</a>";
    } else {
        // Switch to signup mode
        authTitle.textContent = "Create an Account";
        authButton.textContent = "Sign Up";
        authToggleLink.innerHTML = "Already have an account? <a href='#'>Login</a>";
    }

    // Clear input fields
    authEmail.value = '';
    authPassword.value = '';
}

// Function for Signup
async function signupUser(email, password){
    const signupUrl = `${API_BASE_PATH}/auth/signup`;

    const response = await fetch(signupUrl, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({email: email, password: password})
    });

    if (!response.ok){
        const errorText = await response.text();
        throw new Error(errorText || 'Signup failed. Please try again.');
    }
    
    return await response.json();
}

// Function for Login
async function loginUser(email, password){
    const loginUrl = `${API_BASE_PATH}/auth/login`;
    
    const response = await fetch(loginUrl, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({email: email, password: password})
    });

    if (!response.ok){
        const errorText = await response.text();
        throw new Error(errorText || 'Login failed. Please try again.');
    }
    
    return await response.json();
}

// Function for Logout
async function logoutUser(){
    const logoutUrl = `${API_BASE_PATH}/auth/logout`;
    
    const response = await fetch(logoutUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${authToken}`
        },
    });

    if (!response.ok){
        console.error('Logout failed');
    }

    // Clear local storage and reset state
    localStorage.removeItem('LectureLens-authToken');
    localStorage.removeItem('LectureLens-currentLectureId');
    authToken = null;
    currentLectureId = null;

    // Show auth container and hide main app
    authContainer.style.display = 'flex';
    mainApp.style.display = 'none';

    // Clear chat window
    chatWindow.innerHTML = '';
}

// Function to handle authentication form submission
async function handleAuthFormSubmit(event){
    event.preventDefault(); // Prevent default form submission

    const email = authEmail.value.trim();
    const password = authPassword.value.trim();

    if (!email || !password){
        displayMessage('Please enter both email and password', 'error');
        return;
    }

    // Basic email format check
    if (!email.includes('@') || !email.includes('.')){
        displayMessage('Please enter a valid email address', 'error');
        return;
    }

    // Disable the form during submission
    authEmail.disabled = true;
    authPassword.disabled = true;
    authButton.disabled = true;
    authButton.textContent = 'Processing...';

    try {
        let response;

        if (isLoginMode){
            // Call login API
            response = await loginUser(email, password);

            // Store the authentication token
            authToken = response.token;
            localStorage.setItem('LectureLens-authToken', authToken);

            // Show success and transition to main app
            showMainApp();
            displayMessage('Login successful! Welcome back!', 'system');
        } else {
            // Call signup API
            response = await signupUser(email, password);

            // After successful signup, automatically login the user
            const loginResponse = await loginUser(email, password);
            authToken = loginResponse.token;
            localStorage.setItem('LectureLens-authToken', authToken);

            // Show success and transition to main app
            showMainApp();
            displayMessage('Signup successful! Welcome to LectureLens!', 'system');
        } 
    } catch (error){
        console.error('Auth error:', error);

        // Display user-friendly error messages
        let errorMessage = 'An error occurred. Please try again.';
        
        if (error.message.includes('Invalid email format')) {
            errorMessage = 'Please enter a valid email address.';
        } else if (error.message.includes('Invalid password length')) {
            errorMessage = 'Password must be between 8 and 100 characters.';
        } else if (error.message.includes('Invalid password complexity')) {
            errorMessage = 'Password must include uppercase, lowercase, numbers, and special characters.';
        } else if (error.message.includes('Email already in use')) {
            errorMessage = 'This email is already registered. Please login instead.';
        } else if (error.message.includes('Invalid credentials')) {
            errorMessage = 'Invalid email or password. Please try again.';
        }
        
        alert(errorMessage);

    } finally {
        // Re-enable the form
        authEmail.disabled = false;
        authPassword.disabled = false;
        authButton.disabled = false;
        authButton.textContent = isLoginMode ? 'Login' : 'Sign Up';
    }
}

// Show Main App Function
function showMainApp(){
    authContainer.style.display = 'none';
    mainApp.style.display = 'block';

    // Clear auth form
    authEmail.value = '';
    authPassword.value = '';
}

// Show Auth Container Function
function showAuthContainer(){
    authContainer.style.display = 'flex';
    mainApp.style.display = 'none';
}

// Handle 401 Unauthorized responses (expired or invalid token)
function handleUnauthorized(){
    alert('Your session has expired. Please login again.');
    
    // Clear local storage and reset state
    localStorage.removeItem('LectureLens-authToken');
    localStorage.removeItem('LectureLens-currentLectureId');
    authToken = null;
    currentLectureId = null;
    
    // Show auth container and hide main app
    showAuthContainer();
    
    // Clear chat window
    chatWindow.innerHTML = '';
}

// Handle File Upload Function
async function handleFileUpload(){
    // Check if the file has been uploaded
    if (lectureUploadInput.files.length === 0){
        displayMessage("Please upload a lecture file to begin", 'system');
        return;
    }

    // Get the file
    const file = lectureUploadInput.files[0];

    // Display the loading message
    const uploadMessage = displayMessage(`Uploading and processing "${file.name}"...`, 'system');

    // Disable the upload input
    setUIState(false);
    lectureUploadInput.disabled = true;

    try {
        // Use FileReader to read the file content as text
        const reader = new FileReader();

        // This promise will resolve when the file is read
        const fileContent = await new Promise((resolve, reject) => {
            reader.onload = (event) => {
                resolve(event.target.result); // File content
            };
            reader.onerror = (error) => {
                reject(error); // File reading error
            };
            reader.readAsText(file); // Read the file
        });

        // Log for verification
        console.log(`Received file: ${file.name}. Content preview: ${fileContent.substring(0, 100)}...`);

        // Upload the lecture to the API
        await uploadLecture(file.name, String(fileContent));
        
        // // Update the message (uploadLecture function will display its own message)
        // uploadMessage.remove();
    } catch (error){
        displayMessage(`Error reading file: ${error.message}`, 'system');
        lectureUploadInput.disabled = false;
    }
}

// uploadLecture function to upload the lecture to the API
async function uploadLecture(fileName, fileContent){
    // Construct the full URL
    const uploadUrl = `${API_BASE_PATH}/upload`;

    // Create a new FormData object
    const formData = new FormData();
    // Append the file name and content to the form data
    formData.append('lectureFile', new Blob([fileContent], {type: 'text/plain'}), fileName);

    try {
        const response = await fetch(uploadUrl, {
            method: 'POST',
            headers: {'Authorization': `Bearer ${authToken}`},
            body: formData
        });

        // Check for 401 Unauthorized (expired session)
        if (response.status === 401){
            handleUnauthorized();
            return;
        }

        // Check the HTTP errors
        if (!response.ok){
            const errorBody = await response.json();
            throw new Error(`API Error (${response.status}): ${errorBody.error || errorBody.message || 'Unknown error'}`);
        }

        // Parsing the JSON body and return the lecture ID
        const data = await response.json();
        const newLectureId = data.lectureId;

        if (!newLectureId){
            throw new Error('Upload failed: No lecture ID returned');
        }
        // Store the new lecture ID globally and locally
        currentLectureId = newLectureId;
        localStorage.setItem('LectureLens-currentLectureId', newLectureId);

        setUIState(true);
        displayMessage(`Lecture "${fileName}" uploaded successfully! You can now ask questions about the lecture.`, 'system');
    } catch (error){
        console.log("Upload Lecture Error:", error);
        displayMessage(`Error: ${error.message}. Please try again.`, 'system');
    } finally {
        lectureUploadInput.disabled = false;
        setUIState(true);
    }
}


// Message Display Function
function displayMessage(text, role){
    // Create a new div element
    const messageElement = document.createElement('div');
    // Set its class to include message and the role
    messageElement.classList.add('message', role);

    if (role === 'assistant'){
        // Use marked.js to render the text as HTML
        messageElement.innerHTML = marked.parse(text);
    } else {
        // Set its text content
        messageElement.textContent = text;
    }
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
    setUIState(false);

    // Display the loading assistant response
    const loadingMessage = displayMessage("Thinking...", 'assistant')

    try {
    // Await the result of callChatAPI
    const aiResponse = await callChatAPI(messageText);

    // Display the AI response
    loadingMessage.textContent = aiResponse;
    } catch (error){
        console.error("Chat Error:", error);
        loadingMessage.textContent = `Error: ${error.message}. Please try again.`;
        loadingMessage.classList.add('error');
    } finally {
        // ------ End loading state ------
        // Re-enable the UI
        setUIState(true);
        chatInput.focus();
    }


}

// callChatAPI function
async function callChatAPI(message) {
    // Construct the full URL
    const url = `${API_BASE_PATH}/chat/${currentLectureId}`;

    try {
        // Use the global fetch to send the POST request
        const response = await fetch(url, {
        method: 'POST',
        headers: {'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}`},
        body: JSON.stringify({message: message})
    });

    // Check for 401 Unauthorized (expired session)
    if (response.status === 401){
        handleUnauthorized();
        throw new Error('Session expired');
    }

    // Check the HTTP errors
    if (!response.ok){
        const errorBody = await response.json();
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

// callSummarizeAPI function
async function callSummerizeAPI(){
    setUIState(false);
    const loadingMessage = displayMessage("Generating summary...", 'system');

    try {
        // 1. Retrieve the raw lecture text from DO
        const rawTextUrl = `${API_BASE_PATH}/chat/${currentLectureId}/raw-lecture-text`;
        const rawTextResponse = await fetch(rawTextUrl, {
            headers: {'Authorization': `Bearer ${authToken}`},
        });

        // Check for 401 Unauthorized (expired session)
        if (rawTextResponse.status === 401){
            handleUnauthorized();
            return;
        }

        if (!rawTextResponse.ok){
            const errorBody = await rawTextResponse.json();
            throw new Error(`Failed to retrieve raw lecture text (${rawTextResponse.status}): ${errorBody.error || errorBody.message || 'Unknown error'}`);
        }

        const rawTextData = await rawTextResponse.json();
        const lectureContent = rawTextData.rawText;

        if (!lectureContent){
            throw new Error('Raw lecture content not found in Durable Object.');
        }

        // 2. Send the raw lecture content to the summarize endpoint
        const summarizeUrl = `${API_BASE_PATH}/summarize`;
        const summarizeResponse = await fetch(summarizeUrl, {
            method: 'POST',
            headers: {'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}`},
            body: JSON.stringify({text: lectureContent, lectureId: currentLectureId})
        });

        // Check for 401 Unauthorized (expired session)
        if (summarizeResponse.status === 401){
            handleUnauthorized();
            return;
        }

        if (!summarizeResponse.ok){
            const errorBody = await summarizeResponse.json();
            throw new Error(`Failed to summarize lecture content (${summarizeResponse.status}): ${errorBody.error || errorBody.message || 'Unknown error'}`);
        }

        const summarizeData = await summarizeResponse.json();
        const summary = summarizeData.summary;

        loadingMessage.innerHTML = marked.parse(`Lecture Summary:\n\n ${summary}`);
        loadingMessage.classList.remove('system');
        loadingMessage.classList.add('assistant');
    } catch (error){
        console.log("Summarize Error:", error);
        loadingMessage.textContent = `Error generating summary: ${error.message}. Please try again.`;
        loadingMessage.classList.add('error');
    } finally {
        // Re-enable the UI
        setUIState(true);
    }
}

// callExtractAPI function
async function callExtractAPI(){
    if (!currentLectureId) return;
    setUIState(false);
    const loadingMessage = displayMessage("Extracting concepts...", 'system');
    
    try {
        // 1. Retrieve the raw lecture text from DO
        const rawTextUrl = `${API_BASE_PATH}/chat/${currentLectureId}/raw-lecture-text`;
        const rawTextResponse = await fetch(rawTextUrl, {
            headers: {'Authorization': `Bearer ${authToken}`},
        });

        // Check for 401 Unauthorized (expired session)
        if (rawTextResponse.status === 401){
            handleUnauthorized();
            return;
        }

        if (!rawTextResponse.ok){
            const errorBody = await rawTextResponse.json();
            throw new Error(`Failed to retrieve raw lecture text (${rawTextResponse.status}): ${errorBody.error || errorBody.message || 'Unknown error'}`);
        }

        const rawTextData = await rawTextResponse.json();
        const lectureContent = rawTextData.rawText;

        if (!lectureContent){
            throw new Error('Raw lecture content not found in Durable Object.');
        }

        // 2. Send the lectureId to the extract endpoint  
        const extractUrl = `${API_BASE_PATH}/extract-concepts`;
        const extractResponse = await fetch(extractUrl, {
            method: 'POST',
            headers: {'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}`},
            body: JSON.stringify({lectureId: currentLectureId})
        });

        // Check for 401 Unauthorized (expired session)
        if (extractResponse.status === 401){
            handleUnauthorized();
            return;
        }

        if (!extractResponse.ok){
            const errorBody = await extractResponse.json();
            throw new Error(`Failed to extract concepts (${extractResponse.status}): ${errorBody.error || errorBody.message || 'Unknown error'}`);
        }

        const extractData = await extractResponse.json();
        const concepts = extractData.coreConcepts;

        loadingMessage.innerHTML = marked.parse(`Extracted Concepts:\n\n ${concepts}`);
        loadingMessage.classList.remove('system');
        loadingMessage.classList.add('assistant');
    } catch (error){
        console.log("Extract Error:", error);
        loadingMessage.textContent = `Error extracting concepts: ${error.message}. Please try again.`;
        loadingMessage.classList.add('error');
    } finally {
        // Re-enable the UI
        setUIState(true);
    }
}

// setUIState helper function
function setUIState(enabled){
    chatInput.disabled = !enabled;
    sendButton.disabled = !enabled;
    summarizeButton.disabled = !enabled || !currentLectureId;
    extractButton.disabled = !enabled || !currentLectureId;
}

// Initialize the current lecture ID
function initializeApp(){
    // Check for the auth token first
    const storedToken = localStorage.getItem('LectureLens-authToken');

    if (!storedToken){
        // No token, show auth screen
        showAuthContainer();
        return;
    }

    // Token exists, set it and show main app
    authToken = storedToken;
    showMainApp();


    // Try to get the lecture ID from localStorage
    const storedLectureId = localStorage.getItem('LectureLens-currentLectureId');

    if (storedLectureId){
        currentLectureId = storedLectureId;
        displayMessage(`Welcome back! Continuing chat for your last lecture.`, 'system');
        setUIState(true);
    } else {
        displayMessage(`Welcome! Please upload your materials to begin`, 'system');
        setUIState(false);
    }
    // File upload input is always enabled initially
    lectureUploadInput.disabled = false;
}

// ----- Event Listeners -----
sendButton.addEventListener('click', sendMessage);
chatInput.addEventListener('keypress', function(event) {
    if (event.key === 'Enter'){
        event.preventDefault();
        sendMessage();
    }
});

// Handle File Upload Button Click
lectureUploadInput.addEventListener('change', handleFileUpload);

// Handle Summarize Button Click
summarizeButton.addEventListener('click', callSummerizeAPI);

// Handle Extract Button Click
extractButton.addEventListener('click', callExtractAPI);

// Auth form submit listener
authForm.addEventListener('submit', handleAuthFormSubmit);

// Auth toggle link click listener
authToggleLink.addEventListener('click', function(event) {
    if (event.target.tagName === 'A'){
        toggleAuthMode();
    }
});

// Initialize the app
document.addEventListener('DOMContentLoaded', initializeApp);

// Handle Clear Button Click
const clearButton = document.getElementById('clear-button');
if (clearButton){
    clearButton.addEventListener('click', () => {
        localStorage.removeItem('LectureLens-currentLectureId');
        window.location.reload();
    });
}

// Handle Logout Button Click
logoutButton.addEventListener('click', logoutUser);


