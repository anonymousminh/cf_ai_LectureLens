// Use relative path - works with Pages Functions proxy in both dev and production
const API_BASE_PATH = '/api';
let currentLectureId = null;

let isLoginMode = true; // Track if user is in login mode or signup mode
let authToken = null; // Store the authentication token

// Helper function to safely parse error responses (handles both JSON and plain text)
async function parseErrorResponse(response) {
    const contentType = response.headers.get('Content-Type');
    if (contentType && contentType.includes('application/json')) {
        try {
            const data = await response.json();
            return data.error || data.message || 'Unknown error';
        } catch (e) {
            // If JSON parsing fails, try text
            return await response.text();
        }
    } else {
        // Plain text response
        return await response.text();
    }
}

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
const scrollToBottomBtn = document.getElementById("scroll-to-bottom");

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

    // Check for 429 Rate Limit Exceeded
    if (response.status === 429){
        const errorBody = await response.json();
        const retryAfter = errorBody.retryAfter || 60;
        const minutes = Math.floor(retryAfter / 60);
        const seconds = retryAfter % 60;
        const timeMsg = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
        throw new Error(`Too many signup attempts! Please wait ${timeMsg} before trying again.`);
    }

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

    // Check for 429 Rate Limit Exceeded
    if (response.status === 429){
        const errorBody = await response.json();
        const retryAfter = errorBody.retryAfter || 60;
        const minutes = Math.floor(retryAfter / 60);
        const seconds = retryAfter % 60;
        const timeMsg = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
        throw new Error(`Too many login attempts! Please wait ${timeMsg} before trying again.`);
    }

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

    // Disable the form during submission with animated loading
    authEmail.disabled = true;
    authPassword.disabled = true;
    authButton.disabled = true;
    authButton.classList.add('loading');
    authButton.textContent = isLoginMode ? 'Logging in...' : 'Creating account...';

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
        authButton.classList.remove('loading');
        authButton.textContent = isLoginMode ? 'Login' : 'Sign Up';
    }
}

// Show Main App Function
function showMainApp(){
    authContainer.style.display = 'none';
    mainApp.style.display = 'flex';

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

    // Validate file type (PDF or text)
    const isValidType = file.type === 'application/pdf' || 
                        file.type === 'text/plain' || 
                        file.name.endsWith('.txt') || 
                        file.name.endsWith('.pdf');
    
    if (!isValidType){
        displayMessage("Please upload a PDF or TXT file only", 'error');
        return;
    }

    // File size check (50MB limit)
    const maxSizeMB = 50;
    const maxSizeBytes = maxSizeMB * 1024 * 1024;
    if (file.size > maxSizeBytes){
        displayMessage(`File size exceeds the maximum allowed size of ${maxSizeMB}MB`, 'error');
        return;
    }

    // Display the animated loading message with progress bar
    const uploadMessage = displayLoadingMessage(`Processing "${file.name}"`, 'upload');

    // Disable the upload input
    setUIState(false);
    lectureUploadInput.disabled = true;

    try {
        let fileContent;
        
        // Handle PDF files
        if (file.type === 'application/pdf' || file.name.endsWith('.pdf')) {
            updateLoadingMessage(uploadMessage, `Extracting text from PDF`);
            fileContent = await extractTextFromPDF(file);
            
            if (!fileContent || fileContent.trim().length === 0) {
                throw new Error('No text could be extracted from the PDF. The file may be empty, image-only, or corrupted.');
            }
            
            console.log(`Extracted ${fileContent.length} characters from PDF`);
        } 
        // Handle text files
        else {
            updateLoadingMessage(uploadMessage, `Reading file content`);
            fileContent = await readTextFile(file);
        }

        // Log for verification
        console.log(`Received file: ${file.name}. Content preview: ${fileContent.substring(0, 100)}...`);

        // Upload the lecture to the API
        updateLoadingMessage(uploadMessage, `Uploading to server`);
        await uploadLecture(file.name, String(fileContent));
        
        // Remove the upload progress message after successful upload
        uploadMessage.remove();
        
    } catch (error){
        console.error('File upload error:', error);
        // Remove the upload progress message on error too
        uploadMessage.remove();
        displayMessage(`Error: ${error.message}`, 'error');
    } finally {
        lectureUploadInput.disabled = false;
        setUIState(true);
    }
}

// Helper function to read text files
async function readTextFile(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (event) => resolve(event.target.result);
        reader.onerror = (error) => reject(error);
        reader.readAsText(file);
    });
}

// Helper function to extract text from PDF using PDF.js
async function extractTextFromPDF(file) {
    try {
        // Set worker source for PDF.js
        pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
        
        // Read file as ArrayBuffer
        const arrayBuffer = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (event) => resolve(event.target.result);
            reader.onerror = (error) => reject(error);
            reader.readAsArrayBuffer(file);
        });

        // Load PDF document
        const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
        const numPages = pdf.numPages;
        console.log(`PDF has ${numPages} pages`);

        // Extract text from all pages
        let fullText = '';
        for (let pageNum = 1; pageNum <= numPages; pageNum++) {
            const page = await pdf.getPage(pageNum);
            const textContent = await page.getTextContent();
            const pageText = textContent.items.map(item => item.str).join(' ');
            fullText += pageText + '\n\n';
        }

        return fullText.trim();
    } catch (error) {
        console.error('PDF extraction error:', error);
        throw new Error(`Failed to extract text from PDF: ${error.message}`);
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

        // Check for 413 Content Too Large
        if (response.status === 413){
            const errorBody = await response.json();
            throw new Error(errorBody.message || 'File or content is too large');
        }

        // Check for 429 Rate Limit Exceeded
        if (response.status === 429){
            const errorBody = await response.json();
            const retryAfter = errorBody.retryAfter || 60;
            const minutes = Math.floor(retryAfter / 60);
            const seconds = retryAfter % 60;
            const timeMsg = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
            throw new Error(`Too many uploads! Please wait ${timeMsg} before uploading again. (${errorBody.limit} uploads per hour allowed)`);
        }

        // Check the HTTP errors
        if (!response.ok){
            const errorMessage = await parseErrorResponse(response);
            
            // Provide user-friendly messages for common errors
            if (response.status === 400) {
                // Bad request - likely validation error
                throw new Error(errorMessage);
            } else {
                throw new Error(`Upload failed (${response.status}): ${errorMessage}`);
            }
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

        // Create detailed success message with statistics
        let successMessage = `Lecture "${fileName}" uploaded successfully!`;
        
        if (data.wordCount) {
            successMessage += ` (${data.wordCount.toLocaleString()} words, ${data.textLength.toLocaleString()} characters)`;
        }
        
        successMessage += ' You can now ask questions about the lecture.';

        setUIState(true);
        displayMessage(successMessage, 'system');
        
        // Log upload details to console for debugging
        console.log('Upload successful:', {
            lectureId: newLectureId,
            fileName: data.fileName,
            fileType: data.fileType,
            wordCount: data.wordCount,
            textLength: data.textLength
        });
    } catch (error){
        console.error("Upload Lecture Error:", error);
        displayMessage(`Error: ${error.message}`, 'error');
    } finally {
        lectureUploadInput.disabled = false;
        setUIState(true);
    }
}


// Message Display Function
function displayMessage(text, role){
    // Check if user was at bottom before adding message
    const wasAtBottom = isAtBottom();
    
    // Create a new div element
    const messageElement = document.createElement('div');
    // Set its class to include message and the role
    messageElement.classList.add('message', role);

    if (role === 'assistant'){
        // Use marked.js to render the text as HTML
        messageElement.innerHTML = DOMPurify.sanitize(marked.parse(text));
    } else {
        // Set its text content
        messageElement.textContent = text;
    }
    // Append the new div to the chat-window
    chatWindow.appendChild(messageElement);
    
    // Only auto-scroll if user was at bottom (don't interrupt reading)
    if (wasAtBottom) {
        chatWindow.scrollTop = chatWindow.scrollHeight;
    }

    return messageElement;
}

// Display Loading Message with animated spinner
function displayLoadingMessage(text, type = 'default'){
    const wasAtBottom = isAtBottom();
    
    const messageElement = document.createElement('div');
    messageElement.classList.add('message', 'system', 'loading');
    
    // Create spinner
    const spinner = document.createElement('div');
    spinner.classList.add('loading-spinner');
    
    // Create text container with animated dots
    const textContainer = document.createElement('div');
    textContainer.classList.add('loading-content');
    
    const textSpan = document.createElement('span');
    textSpan.classList.add('loading-text');
    textSpan.textContent = text;
    
    const dotsContainer = document.createElement('span');
    dotsContainer.classList.add('loading-dots');
    dotsContainer.innerHTML = '<span></span><span></span><span></span>';
    
    textContainer.appendChild(textSpan);
    textContainer.appendChild(dotsContainer);
    
    messageElement.appendChild(spinner);
    messageElement.appendChild(textContainer);
    
    // For upload type, add progress bar
    if (type === 'upload') {
        const progressContainer = document.createElement('div');
        progressContainer.classList.add('upload-progress');
        
        const progressBarContainer = document.createElement('div');
        progressBarContainer.classList.add('progress-bar-container');
        
        const progressBar = document.createElement('div');
        progressBar.classList.add('progress-bar');
        
        progressBarContainer.appendChild(progressBar);
        progressContainer.appendChild(progressBarContainer);
        
        messageElement.appendChild(progressContainer);
        messageElement.style.flexDirection = 'column';
        messageElement.style.alignItems = 'flex-start';
    }
    
    chatWindow.appendChild(messageElement);
    
    if (wasAtBottom) {
        chatWindow.scrollTop = chatWindow.scrollHeight;
    }
    
    return messageElement;
}

// Update loading message text
function updateLoadingMessage(element, text) {
    const textSpan = element.querySelector('.loading-text');
    if (textSpan) {
        textSpan.textContent = text;
    }
}

// Convert loading message to regular message
function convertLoadingToMessage(element, text, role) {
    element.classList.remove('loading', 'system');
    element.classList.add(role);
    
    if (role === 'assistant') {
        element.innerHTML = DOMPurify.sanitize(marked.parse(text));
    } else if (role === 'error') {
        element.classList.add('error');
        element.textContent = text;
    } else {
        element.textContent = text;
    }
}

// Helper function to check if chat window is scrolled to bottom
function isAtBottom() {
    const threshold = 100; // pixels from bottom to consider "at bottom"
    return chatWindow.scrollHeight - chatWindow.scrollTop - chatWindow.clientHeight < threshold;
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

    // Display the animated loading message
    const loadingMessage = displayLoadingMessage("Thinking", 'default');

    try {
        // Await the result of callChatAPI
        const aiResponse = await callChatAPI(messageText);

        // Convert loading to assistant response
        convertLoadingToMessage(loadingMessage, aiResponse, 'assistant');
    } catch (error){
        console.error("Chat Error:", error);
        convertLoadingToMessage(loadingMessage, `Error: ${error.message}. Please try again.`, 'error');
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

    // Check for 429 Rate Limit Exceeded
    if (response.status === 429){
        const errorBody = await response.json();
        const retryAfter = errorBody.retryAfter || 60;
        const minutes = Math.floor(retryAfter / 60);
        const seconds = retryAfter % 60;
        const timeMsg = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
        throw new Error(`You're asking questions too quickly! Please wait ${timeMsg} before trying again. (${errorBody.limit} requests per minute allowed)`);
    }

    // Check the HTTP errors
    if (!response.ok){
        const errorMessage = await parseErrorResponse(response);
        throw new Error(`API Error (${response.status}): ${errorMessage}`);
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
    const loadingMessage = displayLoadingMessage("Generating summary", 'default');

    try {
        // 1. Retrieve the raw lecture text from DO
        updateLoadingMessage(loadingMessage, "Fetching lecture content");
        const rawTextUrl = `${API_BASE_PATH}/chat/${currentLectureId}/raw-lecture-text`;
        const rawTextResponse = await fetch(rawTextUrl, {
            headers: {'Authorization': `Bearer ${authToken}`},
        });

        // Check for 401 Unauthorized (expired session)
        if (rawTextResponse.status === 401){
            handleUnauthorized();
            loadingMessage.remove();
            return;
        }

        if (!rawTextResponse.ok){
            const errorMessage = await parseErrorResponse(rawTextResponse);
            throw new Error(`Failed to retrieve raw lecture text (${rawTextResponse.status}): ${errorMessage}`);
        }

        const rawTextData = await rawTextResponse.json();
        const lectureContent = rawTextData.rawText;

        if (!lectureContent){
            throw new Error('Raw lecture content not found in Durable Object.');
        }

        // 2. Send the raw lecture content to the summarize endpoint
        updateLoadingMessage(loadingMessage, "AI is generating summary");
        const summarizeUrl = `${API_BASE_PATH}/summarize`;
        const summarizeResponse = await fetch(summarizeUrl, {
            method: 'POST',
            headers: {'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}`},
            body: JSON.stringify({text: lectureContent, lectureId: currentLectureId})
        });

        // Check for 401 Unauthorized (expired session)
        if (summarizeResponse.status === 401){
            handleUnauthorized();
            loadingMessage.remove();
            return;
        }

        // Check for 429 Rate Limit Exceeded
        if (summarizeResponse.status === 429){
            const errorBody = await summarizeResponse.json();
            const retryAfter = errorBody.retryAfter || 60;
            const minutes = Math.floor(retryAfter / 60);
            const seconds = retryAfter % 60;
            const timeMsg = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
            throw new Error(`Too many summarizations! Please wait ${timeMsg} before trying again. (${errorBody.limit} per hour allowed)`);
        }

        if (!summarizeResponse.ok){
            const errorMessage = await parseErrorResponse(summarizeResponse);
            throw new Error(`Failed to summarize lecture content (${summarizeResponse.status}): ${errorMessage}`);
        }

        const summarizeData = await summarizeResponse.json();
        const summary = summarizeData.summary;

        convertLoadingToMessage(loadingMessage, `**Lecture Summary:**\n\n${summary}`, 'assistant');
        
        // Scroll to bottom to show the full summary
        chatWindow.scrollTop = chatWindow.scrollHeight;
    } catch (error){
        console.log("Summarize Error:", error);
        convertLoadingToMessage(loadingMessage, `Error generating summary: ${error.message}. Please try again.`, 'error');
    } finally {
        // Re-enable the UI
        setUIState(true);
    }
}

// callExtractAPI function
async function callExtractAPI(){
    if (!currentLectureId) return;
    setUIState(false);
    const loadingMessage = displayLoadingMessage("Extracting concepts", 'default');
    
    try {
        // 1. Retrieve the raw lecture text from DO
        updateLoadingMessage(loadingMessage, "Fetching lecture content");
        const rawTextUrl = `${API_BASE_PATH}/chat/${currentLectureId}/raw-lecture-text`;
        const rawTextResponse = await fetch(rawTextUrl, {
            headers: {'Authorization': `Bearer ${authToken}`},
        });

        // Check for 401 Unauthorized (expired session)
        if (rawTextResponse.status === 401){
            handleUnauthorized();
            loadingMessage.remove();
            return;
        }

        if (!rawTextResponse.ok){
            const errorMessage = await parseErrorResponse(rawTextResponse);
            throw new Error(`Failed to retrieve raw lecture text (${rawTextResponse.status}): ${errorMessage}`);
        }

        const rawTextData = await rawTextResponse.json();
        const lectureContent = rawTextData.rawText;

        if (!lectureContent){
            throw new Error('Raw lecture content not found in Durable Object.');
        }

        // 2. Send the lectureId to the extract endpoint  
        updateLoadingMessage(loadingMessage, "AI is extracting key concepts");
        const extractUrl = `${API_BASE_PATH}/extract-concepts`;
        const extractResponse = await fetch(extractUrl, {
            method: 'POST',
            headers: {'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}`},
            body: JSON.stringify({lectureId: currentLectureId})
        });

        // Check for 401 Unauthorized (expired session)
        if (extractResponse.status === 401){
            handleUnauthorized();
            loadingMessage.remove();
            return;
        }

        // Check for 429 Rate Limit Exceeded
        if (extractResponse.status === 429){
            const errorBody = await extractResponse.json();
            const retryAfter = errorBody.retryAfter || 60;
            const minutes = Math.floor(retryAfter / 60);
            const seconds = retryAfter % 60;
            const timeMsg = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
            throw new Error(`Too many concept extractions! Please wait ${timeMsg} before trying again. (${errorBody.limit} per hour allowed)`);
        }

        if (!extractResponse.ok){
            const errorMessage = await parseErrorResponse(extractResponse);
            throw new Error(`Failed to extract concepts (${extractResponse.status}): ${errorMessage}`);
        }

        const extractData = await extractResponse.json();
        const concepts = extractData.coreConcepts;

        convertLoadingToMessage(loadingMessage, `**Extracted Concepts:**\n\n${concepts}`, 'assistant');
        
        // Scroll to bottom to show the full content
        chatWindow.scrollTop = chatWindow.scrollHeight;
    } catch (error){
        console.log("Extract Error:", error);
        convertLoadingToMessage(loadingMessage, `Error extracting concepts: ${error.message}. Please try again.`, 'error');
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

// ----- Scroll to Bottom Functionality -----

// Function to scroll chat window to bottom smoothly
function scrollToBottom() {
    chatWindow.scrollTo({
        top: chatWindow.scrollHeight,
        behavior: 'smooth'
    });
}

// Show/hide scroll to bottom button based on scroll position
chatWindow.addEventListener('scroll', function() {
    if (isAtBottom()) {
        scrollToBottomBtn.classList.remove('show');
    } else {
        scrollToBottomBtn.classList.add('show');
    }
});

// Scroll to bottom when button is clicked
scrollToBottomBtn.addEventListener('click', scrollToBottom);


