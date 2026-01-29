/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Bind resources to your worker in `wrangler.jsonc`. After adding bindings, a type definition for the
 * `Env` object can be regenerated with `npm run cf-typegen`.
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */
import { LectureMemory } from './LectureMemory';
import { RateLimiter } from './RateLimiter';
import { hashPassword } from './auth';
import { validateSession } from './auth';

interface Env {
  AI: any;
  LECTURE_MEMORY: DurableObjectNamespace;
  RATE_LIMITER: DurableObjectNamespace;
  lecturelens_db: D1Database;
}

export { LectureMemory, RateLimiter };

// Rate limiting types and helper functions
interface RateLimitStatus {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
  retryAfter: number;
}

/**
 * Check rate limit for a user/identifier on a specific endpoint
 * @param identifier - userId for authenticated endpoints, IP for auth endpoints
 * @param endpoint - endpoint name (chat, summarize, extract, upload, signup, login)
 * @param env - Worker environment with bindings
 * @returns Rate limit status
 */
async function checkRateLimit(
  identifier: string,
  endpoint: string,
  env: Env
): Promise<RateLimitStatus> {
  try {
    // Get or create RateLimiter DO for this identifier
    const id = env.RATE_LIMITER.idFromName(identifier);
    const stub = env.RATE_LIMITER.get(id);

    // Call the DO to check and increment in one operation
    const response = await stub.fetch(
      `https://rate-limiter/check-and-increment?endpoint=${endpoint}`,
      { method: 'POST' }
    );

    if (!response.ok) {
      throw new Error('Rate limiter request failed');
    }

    const status = (await response.json()) as RateLimitStatus;
    return status;
  } catch (error) {
    console.error('Rate limit check failed:', error);
    // Fail open - allow request if rate limiter fails
    return {
      allowed: true,
      limit: 999999,
      remaining: 999999,
      resetAt: Date.now() + 3600000,
      retryAfter: 0,
    };
  }
}

/**
 * Create a 429 response with rate limit information
 */
function createRateLimitResponse(status: RateLimitStatus): Response {
  const response = new Response(
    JSON.stringify({
      error: 'Rate limit exceeded',
      message: `Too many requests. Please try again in ${status.retryAfter} seconds.`,
      retryAfter: status.retryAfter,
      limit: status.limit,
      resetAt: status.resetAt,
    }),
    {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'X-RateLimit-Limit': status.limit.toString(),
        'X-RateLimit-Remaining': status.remaining.toString(),
        'X-RateLimit-Reset': status.resetAt.toString(),
        'Retry-After': status.retryAfter.toString(),
      },
    }
  );

  return addCorsHeaders(response);
}

// Helper function to add CORS headers to any response
function addCorsHeaders(response: Response): Response {
  const newHeaders = new Headers(response.headers);
  newHeaders.set('Access-Control-Allow-Origin', '*');
  newHeaders.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  newHeaders.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // CONTEXTUAL CHAT ENDPOINT
    // Handles requests like /api/chat/lecture-uuid-123
    if (path.startsWith('/api/chat/')) {
      // --- VALIDATE SESSION ---
      const userId = await validateSession(request, env.lecturelens_db);
      if (!userId){
        return addCorsHeaders(new Response(JSON.stringify({ error: 'Unauthorized' }), { 
          status: 401,
          headers: { 'Content-Type': 'application/json' }
        }));
      }

      // --- RATE LIMITING ---
      const rateLimitStatus = await checkRateLimit(userId, 'chat', env);
      if (!rateLimitStatus.allowed) {
        console.log('Rate limit exceeded for chat', { userId, remaining: rateLimitStatus.remaining });
        return createRateLimitResponse(rateLimitStatus);
      }

      // --- AUTHORIZATION (Ownership Check) ---
      const segments = path.split('/').filter(Boolean);
      // Paths we handle here:
      // - /api/chat/:lectureId
      // - /api/chat/:lectureId/raw-lecture-text
      // - /api/chat/:lectureId/<other-do-routes>
      // So the lectureId is the segment immediately after "chat", not the last segment.
      const chatIndex = segments.indexOf('chat');
      const lectureId = chatIndex >= 0 ? segments[chatIndex + 1] : undefined;
      if (!lectureId) {
        return addCorsHeaders(
          new Response(JSON.stringify({ error: 'Bad Request: missing lecture id' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          })
        );
      }

      const ownership = await env.lecturelens_db.prepare('SELECT user_id FROM user_lectures WHERE user_id = ? AND lecture_id = ?').bind(userId, lectureId).first();
      if (!ownership){
        return addCorsHeaders(new Response(JSON.stringify({ error: 'Forbidden: You do not have access to this lecture.' }), { 
          status: 403,
          headers: { 'Content-Type': 'application/json' }
        }));
      }

      // Get the Durable Object ID and stub using the lectureId
      const id = env.LECTURE_MEMORY.idFromName(lectureId);
      const stub = env.LECTURE_MEMORY.get(id);

      // Construct a new URL to pass to the DO, stripping the /api/chat/ prefix
      const newUrl = new URL(request.url);
      const remainingPath = newUrl.pathname.substring(`/api/chat/${lectureId}`.length);
      
      // If the path is now empty or just '/', set it to a default action like /chat
      if (remainingPath === '' || remainingPath === '/') {
        newUrl.pathname = '/chat';
      } else {
        newUrl.pathname = remainingPath;
      }

      // Create a new Request object with the modified URL
      // Clone the request to ensure the body stream can be read
      const newRequest = new Request(newUrl.toString(), request.clone());

      // Forward the request to the unique Durable Object instance
      try {
        // Add a timeout to prevent infinite hangs (30 seconds)
        const timeoutPromise = new Promise<Response>((_, reject) => {
          setTimeout(() => reject(new Error('DO request timeout after 30s')), 30000);
        });
        
        const doResponse = await Promise.race([
          stub.fetch(newRequest),
          timeoutPromise
        ]);
        
        return addCorsHeaders(doResponse);
      } catch (error) {
        console.error('Error calling Durable Object:', error);
        const errorMessage = error instanceof Error ? error.message : String(error);
        return addCorsHeaders(new Response(JSON.stringify({
          error: 'Failed to reach Durable Object',
          details: errorMessage
        }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        }));
      }
    }

    // SUMMARIZATION ENDPOINT
    if (path === '/api/summarize' && request.method === 'POST') {
      // --- VALIDATE SESSION ---
      const userId = await validateSession(request, env.lecturelens_db);
      if (!userId){
        return addCorsHeaders(new Response(JSON.stringify({ error: 'Unauthorized' }), { 
          status: 401,
          headers: { 'Content-Type': 'application/json' }
        }));
      }

      // --- RATE LIMITING ---
      const rateLimitStatus = await checkRateLimit(userId, 'summarize', env);
      if (!rateLimitStatus.allowed) {
        console.log('Rate limit exceeded for summarize', { userId, remaining: rateLimitStatus.remaining });
        return createRateLimitResponse(rateLimitStatus);
      }

      try {
        // Parse request body to get text and lectureId
        const { text, lectureId } = await request.json() as { text?: string, lectureId?: string };

        if (!text) {
          return addCorsHeaders(new Response(JSON.stringify({ error: 'Missing "text" in request body' }), { 
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          }));
        }

        if (!lectureId) {
          return addCorsHeaders(new Response(JSON.stringify({ error: 'Missing "lectureId" in request body' }), { 
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          }));
        }

        // --- AUTHORIZATION (Ownership Check) ---
        const ownership = await env.lecturelens_db.prepare('SELECT user_id FROM user_lectures WHERE user_id = ? AND lecture_id = ?').bind(userId, lectureId).first();
        if (!ownership){
          return addCorsHeaders(new Response(JSON.stringify({ error: 'Forbidden: You do not have access to this lecture.' }), { 
            status: 403,
            headers: { 'Content-Type': 'application/json' }
          }));
        }

        const systemPrompt = "You are a helpful study assistant. Summarize the following lecture transcript into clear, structured key points. Use Markdown formatting for readability.";
        const userPrompt = `Lecture Transcript:\n\n${text}`;

        const model = '@cf/meta/llama-3.1-8b-instruct';
        const response = await env.AI.run(model, {
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ]
        });

        const summary = response.response;

        return addCorsHeaders(new Response(JSON.stringify({ summary }), {
          headers: { 'Content-Type': 'application/json' },
        }));

      } catch (error) {
        console.error('Summarization Error:', error);
        return addCorsHeaders(new Response(JSON.stringify({ error: 'Internal Server Error during summarization.' }), { 
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        }));
      }
    }

    // UPLOAD FILE ENDPOINT
    if (path === '/api/upload' && request.method === 'POST') {
      const userId = await validateSession(request, env.lecturelens_db);
      if (!userId){
        return addCorsHeaders(new Response(JSON.stringify({ error: 'Unauthorized' }), { 
          status: 401,
          headers: { 'Content-Type': 'application/json' }
        }));
      }

      // --- RATE LIMITING ---
      const rateLimitStatus = await checkRateLimit(userId, 'upload', env);
      if (!rateLimitStatus.allowed) {
        console.log('Rate limit exceeded for upload', { userId, remaining: rateLimitStatus.remaining });
        return createRateLimitResponse(rateLimitStatus);
      }

      try {
        // 1. Check the content type to ensure it's a file upload
        const contentType = request.headers.get('Content-Type');
        if (!contentType || ! contentType.includes('multipart/form-data')) {
          return addCorsHeaders(new Response(JSON.stringify({ error: 'Invalid content type. Expected multipart/form-data.' }), { 
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          }));
        }

        // 2. Parse the multipart form data
        const formData = await request.formData();
        
        // 3. Extract the file from the form data
        const file = formData.get('lectureFile');

        if (!file || typeof file === 'string') {
          return addCorsHeaders(new Response(JSON.stringify({ error: 'No file uploaded or invalid file type.' }), { 
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          }));
        }

        // 4. Read the file content as text
        const lectureText = await file.text();

        // After read the file content as text, we will generate a unique ID for it
        const lectureId = crypto.randomUUID();

        // Get the Durable Object and stub for the lectureId
        const id = env.LECTURE_MEMORY.idFromName(lectureId);
        const stub = env.LECTURE_MEMORY.get(id);
        
        // Prepare the Request Body for the DO
        const doBody = JSON.stringify({lectureText: lectureText});

        // Construct and Send the Request Body to the DO's /lecture endpoint
        const doResponse = await stub.fetch("https://do-placeholder/lecture", {
          method: "POST",
          headers: {'Content-Type': 'application/json'},
          body: doBody
        })

        // Check the DO's response status
        if (!doResponse.ok){
          const errorText = await doResponse.text();
          console.log('DO Storage Failed: ', errorText);
          return addCorsHeaders(new Response(`Failed to store lecture in memory: ${errorText}`, { status: 500 }));
        }

        // link the lecture to the user
        await env.lecturelens_db.prepare('INSERT INTO user_lectures (user_id, lecture_id) VALUES (?, ?)').bind(userId, lectureId).run();

        return addCorsHeaders(new Response(JSON.stringify({
          message: 'File received and stored successfully',
          lectureId: lectureId,
          fileName: file.name,
        }), {
          headers: { 'Content-Type': 'application/json' },
        }));
      } catch (error) {
        console.error('File Upload Error:', error);
        return addCorsHeaders(new Response(JSON.stringify({ error: 'Internal Server Error during file upload.' }), { 
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        }));
      }
    }

    // EXTRACT CONCEPTS ENDPOINT
    // This endpoint will take the lectureId -> retrieve the raw lecture text -> extract the core concepts using Worker AI-> return the core concepts
    if (path === '/api/extract-concepts' && request.method === 'POST') {
      // --- VALIDATE SESSION ---
      const userId = await validateSession(request, env.lecturelens_db);
      if (!userId){
        return addCorsHeaders(new Response(JSON.stringify({ error: 'Unauthorized' }), { 
          status: 401,
          headers: { 'Content-Type': 'application/json' }
        }));
      }

      // --- RATE LIMITING ---
      const rateLimitStatus = await checkRateLimit(userId, 'extract', env);
      if (!rateLimitStatus.allowed) {
        console.log('Rate limit exceeded for extract', { userId, remaining: rateLimitStatus.remaining });
        return createRateLimitResponse(rateLimitStatus);
      }

      // --- AUTHORIZATION (Ownership Check) ---
      const { lectureId } = await request.json() as { lectureId: string };
      if (!lectureId) {
        return addCorsHeaders(new Response(JSON.stringify({ error: 'Missing lectureId in request body' }), { 
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        }));
      }

      const ownership = await env.lecturelens_db.prepare('SELECT user_id FROM user_lectures WHERE user_id = ? AND lecture_id = ?').bind(userId, lectureId).first();
      if (!ownership){
        return addCorsHeaders(new Response(JSON.stringify({ error: 'Forbidden: You do not have access to this lecture.' }), { 
          status: 403,
          headers: { 'Content-Type': 'application/json' }
        }));
      }

      // --- MAIN LOGIC ---
      try {
        // Get the Durable Object and stub for the lectureId
        const id = env.LECTURE_MEMORY.idFromName(lectureId);
        const stub = env.LECTURE_MEMORY.get(id);

        // Retrieve the raw lecture text from the DO
        const rawLectureResponse = await stub.fetch("https://do-placeholder/raw-lecture-text");
        
        if (!rawLectureResponse.ok) {
          return addCorsHeaders(new Response(JSON.stringify({ error: 'Failed to retrieve lecture text from Durable Object' }), { 
            status: 500,
            headers: { 'Content-Type': 'application/json' }
          }));
        }

        const rawLectureData = await rawLectureResponse.json() as { rawText: string };
        const rawLectureText = rawLectureData.rawText;

        if (!rawLectureText) {
          return addCorsHeaders(new Response(JSON.stringify({ error: 'No lecture text found' }), { 
            status: 404,
            headers: { 'Content-Type': 'application/json' }
          }));
        }

        // Construct the system prompt for the Worker AI
        const systemPrompt = "You are a specilized academic assistant. Analyze the following lecture text and extract all key definitions, mathematical formulas, and core theoretical concepts. Format the output clearly using Markdown with bold terms and bullet points";
        const userPrompt = `Lecture Text:\n\n${rawLectureText}`;

        // Call the Worker AI
        const model = '@cf/meta/llama-3.1-8b-instruct';
        const coreConcepts = await env.AI.run(model, {
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ]
        });
        
        const coreConceptsResponse = coreConcepts.response;
        
        // Return the core concepts
        return addCorsHeaders(new Response(JSON.stringify({ coreConcepts: coreConceptsResponse }), {
          headers: { 'Content-Type': 'application/json' },
        }));
      } catch (error) {
        console.error('Extract concepts error:', error);
        const errorMessage = error instanceof Error ? error.message : String(error);
        return addCorsHeaders(new Response(JSON.stringify({
          error: 'Failed to extract concepts',
          details: errorMessage
        }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        }));
      }
    }

    // SIGNUP ENDPOINT
    if (path === '/api/auth/signup' && request.method === 'POST') {
      // --- IP-BASED RATE LIMITING ---
      const ipAddress = request.headers.get('CF-Connecting-IP') || 'unknown';
      const rateLimitStatus = await checkRateLimit(ipAddress, 'signup', env);
      if (!rateLimitStatus.allowed) {
        console.log('Rate limit exceeded for signup', { ip: ipAddress, remaining: rateLimitStatus.remaining });
        return createRateLimitResponse(rateLimitStatus);
      }
      
        const { email, password } = await request.json() as { email: string, password: string };

        // Validate the email format
        if (!email.includes('@') || !email.includes('.')){
          return addCorsHeaders(new Response(JSON.stringify({ error: 'Invalid email format' }), { 
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          }));
        }

        // Check email length limits
        if (email.length < 3 || email.length > 254){
          return addCorsHeaders(new Response(JSON.stringify({ error: 'Invalid email length' }), { 
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          }));
        }

        // Check password length limits
        if (password.length < 8 || password.length > 100){
          return addCorsHeaders(new Response(JSON.stringify({ error: 'Invalid password length' }), { 
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          }));
        }

        // Check password complexity
        if (!password.match(/[A-Z]/g) || !password.match(/[a-z]/g) || !password.match(/[0-9]/g) || !password.match(/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/g)){
          return addCorsHeaders(new Response(JSON.stringify({ error: 'Invalid password complexity' }), { 
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          }));
        }

        // Check if the email is already in use
        const existingUser = await env.lecturelens_db.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
        if (existingUser){
          return addCorsHeaders(new Response(JSON.stringify({ error: 'Email already in use' }), { 
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          }));
        }

        const { hash, salt } = await hashPassword(password);

        try {
        // Insert the user into the database
        await env.lecturelens_db.prepare('INSERT INTO users (id, email, password_hash, salt) VALUES (?, ?, ?, ?)').bind(crypto.randomUUID(), email, hash, salt).run();

        return addCorsHeaders(new Response(JSON.stringify({ message: 'User created successfully' }), {
          headers: { 'Content-Type': 'application/json' },
        }));
      } catch (error) {
        console.error('Signup error:', error);
        return addCorsHeaders(new Response(JSON.stringify({
          error: 'An error occurred during signup'
        }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        }));
      }
    }

    // LOGIN ENDPOINT
    if (path === '/api/auth/login' && request.method === 'POST') {
      // --- IP-BASED RATE LIMITING ---
      const ipAddress = request.headers.get('CF-Connecting-IP') || 'unknown';
      const rateLimitStatus = await checkRateLimit(ipAddress, 'login', env);
      if (!rateLimitStatus.allowed) {
        console.log('Rate limit exceeded for login', { ip: ipAddress, remaining: rateLimitStatus.remaining });
        return createRateLimitResponse(rateLimitStatus);
      }
      
      try {
        const { email, password } = await request.json() as { email: string, password: string };

        if (!email || !password){
          return addCorsHeaders(new Response(JSON.stringify({ error: 'Missing email or password' }), { 
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          }));
        }

        // Validate the email format
        if (!email.includes('@') || !email.includes('.')){
          return addCorsHeaders(new Response(JSON.stringify({ error: 'Invalid email format' }), { 
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          }));
        }

        // Check email length limits
        if (email.length < 3 || email.length > 254){
          return addCorsHeaders(new Response(JSON.stringify({ error: 'Invalid email length' }), { 
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          }));
        }

        // Basic password  length validation
        if (password.length < 8 || password.length > 100){
          return addCorsHeaders(new Response(JSON.stringify({ error: 'Invalid password length' }), { 
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          }));
        }

        // Query for user
        const user = await env.lecturelens_db.prepare('SELECT id, email, password_hash, salt FROM users WHERE email = ?').bind(email).first();
        
        // Always hash the password to prevent timing attacks, even if user doesn't exist
        // Use a dummy salt if user not found
        const dummySalt = '0000000000000000000000000000000000000000000000000000000000000000';
        const saltToUse = user ? (user.salt as string) : dummySalt;
        const {hash} = await hashPassword(password, saltToUse);

        // Check if user exists and password matches
        if (!user || hash !== user.password_hash){
          return addCorsHeaders(new Response(JSON.stringify({ error: 'Invalid credentials' }), { 
            status: 401,
            headers: { 'Content-Type': 'application/json' }
          }));
        }

        // Generate a new token and store it in the database
        const token = crypto.randomUUID();

        // Calculate the expiration date (1 day from now)
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

        await env.lecturelens_db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').bind(token, user.id, new Date().toISOString(), expiresAt.toISOString()).run();

        // Return the token to the client
        return addCorsHeaders(new Response(JSON.stringify({
          token: token,
          message: 'Login successful',
          expiresAt: expiresAt.toISOString()
        }), {status: 200, headers: { 'Content-Type': 'application/json' }}));
      } catch (error) {
        console.error('Login error:', error);
        return addCorsHeaders(new Response(JSON.stringify({ error: 'Internal Server Error' }), { 
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        }));
      }
    }

    // GET MY LECTURES ENDPOINT
    if (path === '/api/my-lectures' && request.method === 'GET') {
      // --- VALIDATE SESSION ---
      const userId = await validateSession(request, env.lecturelens_db);
      if (!userId){
        return addCorsHeaders(new Response(JSON.stringify({ error: 'Unauthorized' }), { 
          status: 401,
          headers: { 'Content-Type': 'application/json' }
        }));
      }

      // --- MAIN LOGIC ---
      try {
        // Query the database for the lectures owned by this user
        const {results} = await env.lecturelens_db.prepare('SELECT lecture_id FROM user_lectures WHERE user_id = ?').bind(userId).all();

        // Return the lectures
        return addCorsHeaders(new Response(JSON.stringify({ lectures: results }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      } catch (error) {
        console.error('Get my lectures error:', error);
        return addCorsHeaders(new Response(JSON.stringify({ error: 'Internal Server Error' }), { 
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        }));
      }
    }

    // LOGOUT ENDPOINT
    if (path === '/api/auth/logout' && request.method === 'POST') {
      // --- VALIDATE SESSION ---
      const userId = await validateSession(request, env.lecturelens_db);
      if (!userId){
        return addCorsHeaders(new Response(JSON.stringify({ error: 'Unauthorized' }), { 
          status: 401,
          headers: { 'Content-Type': 'application/json' }
        }));
      }

      try {
      // Delete the session from the database
      await env.lecturelens_db.prepare('DELETE FROM sessions WHERE token = ?').bind(request.headers.get('Authorization')?.split(' ')[1]).run();

      // Return a success response
      return addCorsHeaders(new Response(JSON.stringify({ message: 'Logout successful' }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      } catch (error) {
        console.error('Logout error:', error);
        return addCorsHeaders(new Response(JSON.stringify({ error: 'Internal Server Error' }), { 
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        }));
      }
    }

    // Handle OPTIONS request (preflight checks)
    if (request.method === 'OPTIONS'){
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        },
      });
    }


    // Root Endpoint
    if (path === '/' && request.method === 'GET') {
      return addCorsHeaders(new Response('LectureLens API is running!', { status: 200 }));
    }

    // 404 Fallback
    return addCorsHeaders(new Response('Not Found.', { status: 404 }));
  },
};
