// Use relative path - works with Pages Functions proxy in both dev and production
const API_BASE_PATH = '/api';
let currentLectureId = null;

let isLoginMode = true; // Track if user is in login mode or signup mode
let authToken = null; // Store the authentication token

// Google Client ID — replace with your actual Google OAuth Client ID
const GOOGLE_CLIENT_ID = '908607822794-8ve2epafvpspdnkcbfoo891ooiv1ekqd.apps.googleusercontent.com';

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

// Get the DOM elements for the auth form and landing page
const landingPage = document.getElementById("landing-page");
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
 // Lecture list elements
const lectureList = document.getElementById("lecture-list");
const lectureListEmpty = document.getElementById("lecture-list-empty");
let lecturesData = []; // Store fetched lectures

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

// ===== GOOGLE AUTHENTICATION =====

// Initialize Google Sign-In
function initializeGoogleSignIn() {
    // Wait for the Google Identity Services library to load
    if (typeof google === 'undefined' || !google.accounts) {
        // Retry after a short delay if library hasn't loaded yet
        setTimeout(initializeGoogleSignIn, 200);
        return;
    }

    google.accounts.id.initialize({
        client_id: GOOGLE_CLIENT_ID,
        callback: handleGoogleCredentialResponse,
    });
}

// Handle the credential response from Google
async function handleGoogleCredentialResponse(response) {
    const googleBtn = document.getElementById('google-signin-btn');
    
    // Show loading state
    googleBtn.disabled = true;
    googleBtn.textContent = 'Signing in...';

    try {
        const result = await fetch(`${API_BASE_PATH}/auth/google`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ credential: response.credential })
        });

        // Check for 429 Rate Limit Exceeded
        if (result.status === 429) {
            const errorBody = await result.json();
            const retryAfter = errorBody.retryAfter || 60;
            const minutes = Math.floor(retryAfter / 60);
            const seconds = retryAfter % 60;
            const timeMsg = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
            throw new Error(`Too many attempts! Please wait ${timeMsg} before trying again.`);
        }

        if (!result.ok) {
            const errorData = await result.json();
            throw new Error(errorData.error || 'Google authentication failed');
        }

        const data = await result.json();

        // Store the token and show the main app
        authToken = data.token;
        localStorage.setItem('LectureLens-authToken', authToken);

        showMainApp();

        if (data.isNewUser) {
            displayMessage('Welcome to LectureLens! Your Google account has been connected.', 'system');
        } else {
            displayMessage('Welcome back! Signed in with Google.', 'system');
        }

        // Fetch the user's lectures
        fetchLectureList();

    } catch (error) {
        console.error('Google auth error:', error);
        alert(error.message || 'Google sign-in failed. Please try again.');
    } finally {
        // Reset button state
        googleBtn.disabled = false;
        googleBtn.innerHTML = `
            <svg class="google-icon" viewBox="0 0 24 24" width="20" height="20">
                <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/>
                <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
            </svg>
            Continue with Google`;
    }
}

// Trigger Google's One Tap / popup sign-in flow
function triggerGoogleSignIn() {
    if (typeof google === 'undefined' || !google.accounts) {
        alert('Google Sign-In is still loading. Please try again in a moment.');
        return;
    }

    google.accounts.id.prompt((notification) => {
        // If One Tap is dismissed or not displayed, fall back to the popup
        if (notification.isNotDisplayed() || notification.isSkippedMoment() || notification.isDismissedMoment()) {
            // Use the popup flow as fallback
            google.accounts.oauth2.initCodeClient({
                client_id: GOOGLE_CLIENT_ID,
                scope: 'email profile',
                callback: () => {},
            });
            // Use the button-style prompt instead
            google.accounts.id.renderButton(
                document.createElement('div'),
                { theme: 'outline', size: 'large' }
            );
            // Fallback: directly open the Google Sign-In popup
            window.google.accounts.id.prompt();
        }
    });
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
    if (landingPage) landingPage.style.display = 'none';
    authContainer.style.display = 'none';
    mainApp.style.display = 'flex';

    // Clear auth form
    authEmail.value = '';
    authPassword.value = '';
}

// Show Auth Container Function
function showAuthContainer(){
    if (landingPage) landingPage.style.display = 'none';
    authContainer.style.display = 'flex';
    mainApp.style.display = 'none';
}

// Transition from landing page to auth (Get Started click)
function showLandingToAuth(){
    if (landingPage) landingPage.style.display = 'none';
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
        
        // Refresh the lecture list to show the new upload
        await fetchLectureList();
        updateSelectedLecture();
        
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

// ===== LECTURE LIST FUNCTIONS =====

// Fetch lectures from the API
async function fetchLectureList() {
    try {
        const response = await fetch(`${API_BASE_PATH}/my-lectures`, {
            headers: { 'Authorization': `Bearer ${authToken}` }
        });

        if (response.status === 401) {
            handleUnauthorized();
            return;
        }

        if (!response.ok) {
            throw new Error('Failed to fetch lectures');
        }

        const data = await response.json();
        lecturesData = data.lectures || [];
        renderLectureList();
    } catch (error) {
        console.error('Error fetching lectures:', error);
        lecturesData = [];
        renderLectureList();
    }
}

// Render the lecture list in the sidebar
function renderLectureList() {
    // Clear existing list
    lectureList.innerHTML = '';

    if (lecturesData.length === 0) {
        lectureList.style.display = 'none';
        lectureListEmpty.style.display = 'flex';
        return;
    }

    lectureList.style.display = 'block';
    lectureListEmpty.style.display = 'none';

    lecturesData.forEach(lecture => {
        const lectureItem = createLectureItem(lecture);
        lectureList.appendChild(lectureItem);
    });

    // Highlight the currently selected lecture
    updateSelectedLecture();
}

// Create a single lecture list item element
function createLectureItem(lecture) {
    const item = document.createElement('div');
    item.classList.add('lecture-item');
    item.dataset.lectureId = lecture.lecture_id;

    // Lecture name (truncate if too long)
    const lectureName = lecture.lecture_name || 'Untitled Lecture';
    const displayName = lectureName.length > 25 ? lectureName.substring(0, 22) + '...' : lectureName;

    // Format date
    const createdAt = lecture.created_at ? formatDate(lecture.created_at) : 'Unknown date';

    item.innerHTML = `
        <div class="lecture-item-content">
            <div class="lecture-item-name" title="${lectureName}">${displayName}</div>
            <div class="lecture-item-meta">
                <span class="lecture-item-date">${createdAt}</span>
            </div>
        </div>
        <button class="lecture-item-delete" title="Delete lecture">&times;</button>
    `;

    // Click to select lecture
    item.addEventListener('click', (e) => {
        if (!e.target.classList.contains('lecture-item-delete')) {
            selectLecture(lecture.lecture_id, lectureName);
        }
    });

    // Delete button
    const deleteBtn = item.querySelector('.lecture-item-delete');
    deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteLecture(lecture.lecture_id, lectureName);
    });

    return item;
}

// Format date for display
function formatDate(dateString) {
    const date = new Date(dateString);
    const now = new Date();
    const diffTime = Math.abs(now - date);
    const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));

    if (diffDays === 0) {
        return 'Today';
    } else if (diffDays === 1) {
        return 'Yesterday';
    } else if (diffDays < 7) {
        return `${diffDays} days ago`;
    } else {
        return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    }
}

// Select a lecture
function selectLecture(lectureId, lectureName) {
    currentLectureId = lectureId;
    localStorage.setItem('LectureLens-currentLectureId', lectureId);
    
    // Update UI
    updateSelectedLecture();
    setUIState(true);
    
    // Clear chat and show selection message
    chatWindow.innerHTML = '<button id="scroll-to-bottom" title="Scroll to bottom">↓</button>';
    displayMessage(`Selected: "${lectureName}". You can now ask questions about this lecture.`, 'system');
    
    // Re-attach scroll button listener
    const newScrollBtn = document.getElementById('scroll-to-bottom');
    newScrollBtn.addEventListener('click', scrollToBottom);
}

// Update visual selection in the lecture list
function updateSelectedLecture() {
    // Remove active class from all items
    document.querySelectorAll('.lecture-item').forEach(item => {
        item.classList.remove('active');
    });

    // Add active class to selected item
    if (currentLectureId) {
        const selectedItem = document.querySelector(`.lecture-item[data-lecture-id="${currentLectureId}"]`);
        if (selectedItem) {
            selectedItem.classList.add('active');
        }
    }
}

// Delete a lecture
async function deleteLecture(lectureId, lectureName) {
    if (!confirm(`Are you sure you want to delete "${lectureName}"?`)) {
        return;
    }

    try {
        const response = await fetch(`${API_BASE_PATH}/lectures/${lectureId}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${authToken}` }
        });

        if (response.status === 401) {
            handleUnauthorized();
            return;
        }

        if (!response.ok) {
            throw new Error('Failed to delete lecture');
        }

        // Remove from local data
        lecturesData = lecturesData.filter(l => l.lecture_id !== lectureId);
        
        // If deleted lecture was the current one, clear selection
        if (currentLectureId === lectureId) {
            currentLectureId = null;
            localStorage.removeItem('LectureLens-currentLectureId');
            setUIState(false);
            chatWindow.innerHTML = '<button id="scroll-to-bottom" title="Scroll to bottom">↓</button>';
            displayMessage('Lecture deleted. Please select or upload another lecture.', 'system');
            
            // Re-attach scroll button listener
            const newScrollBtn = document.getElementById('scroll-to-bottom');
            newScrollBtn.addEventListener('click', scrollToBottom);
        }

        // Re-render the list
        renderLectureList();
        displayMessage(`"${lectureName}" has been deleted.`, 'system');

    } catch (error) {
        console.error('Error deleting lecture:', error);
        displayMessage(`Error deleting lecture: ${error.message}`, 'error');
    }
}

// Initialize the current lecture ID
function initializeApp(){
    // Check for the auth token first
    const storedToken = localStorage.getItem('LectureLens-authToken');

    if (!storedToken){
        // No token, show landing page (auth hidden by default); user clicks Get Started to show auth
        return;
    }

    // Token exists, set it and show main app
    authToken = storedToken;
    showMainApp();

    // Fetch the user's lectures
    fetchLectureList();

    // Try to get the lecture ID from localStorage
    const storedLectureId = localStorage.getItem('LectureLens-currentLectureId');

    if (storedLectureId){
        currentLectureId = storedLectureId;
        // Find lecture name from the list (will be validated after fetch)
        displayMessage(`Welcome back! Loading your lectures...`, 'system');
        setUIState(true);
    } else {
        displayMessage(`Welcome! Please upload or select a lecture to begin`, 'system');
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

// Google Sign-In button click listener
const googleSignInBtn = document.getElementById('google-signin-btn');
if (googleSignInBtn) {
    googleSignInBtn.addEventListener('click', triggerGoogleSignIn);
}

// Landing page Get Started buttons
['landing-get-started', 'hero-cta', 'how-cta'].forEach(id => {
    const btn = document.getElementById(id);
    if (btn) btn.addEventListener('click', showLandingToAuth);
});

// Initialize the app and Google Sign-In
document.addEventListener('DOMContentLoaded', () => {
    initializeApp();
    initializeGoogleSignIn();
});

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


