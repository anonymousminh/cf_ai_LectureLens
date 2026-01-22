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
import { hashPassword } from './auth';
import { validateSession } from './auth';

interface Env {
  AI: any;
  LECTURE_MEMORY: DurableObjectNamespace;
  lecturelens_db: D1Database;
}

export { LectureMemory };

// Helper function to add CORS headers to any response
function addCorsHeaders(response: Response): Response {
  const newHeaders = new Headers(response.headers);
  newHeaders.set('Access-Control-Allow-Origin', '*');
  newHeaders.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  newHeaders.set('Access-Control-Allow-Headers', 'Content-Type');
  
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
        return addCorsHeaders(new Response('Unauthorized', { status: 401 }));
      }

      // --- AUTHORIZATION (Ownership Check) ---
      const segments = path.split('/').filter(Boolean);
      const lectureId = segments[segments.length - 1];

      const ownership = await env.lecturelens_db.prepare('SELECT user_id FROM user_lectures WHERE user_id = ? AND lecture_id = ?').bind(userId, lectureId).first();
      if (!ownership){
        return addCorsHeaders(new Response('Forbidden: You do not have access to this lecture.', { status: 403 }));
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
        return addCorsHeaders(new Response('Unauthorized', { status: 401 }));
      }

      // --- AUTHORIZATION (Ownership Check) ---
      const segments = path.split('/').filter(Boolean);
      const lectureId = segments[segments.length - 1];

      const ownership = await env.lecturelens_db.prepare('SELECT user_id FROM user_lectures WHERE user_id = ? AND lecture_id = ?').bind(userId, lectureId).first();
      if (!ownership){
        return addCorsHeaders(new Response('Forbidden: You do not have access to this lecture.', { status: 403 }));
      }

      try {
        const { text } = await request.json() as { text?: string };

        if (!text) {
          return addCorsHeaders(new Response('Missing "text" in request body', { status: 400 }));
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
        return addCorsHeaders(new Response('Internal Server Error during summarization.', { status: 500 }));
      }
    }

    // UPLOAD FILE ENDPOINT
    if (path === '/api/upload' && request.method === 'POST') {
      const userId = request.headers.get("X-User-Id");

      if (!userId){
        return addCorsHeaders(new Response('Unauthorized', { status: 401 }));
      }

      try {
        // 1. Check the content type to ensure it's a file upload
        const contentType = request.headers.get('Content-Type');
        if (!contentType || ! contentType.includes('multipart/form-data')) {
          return addCorsHeaders(new Response('Invalid content type. Expected multipart/form-data.', { status: 400 }));
        }

        // 2. Parse the multipart form data
        const formData = await request.formData();
        
        // 3. Extract the file from the form data
        const file = formData.get('lectureFile');

        if (!file || typeof file === 'string') {
          return addCorsHeaders(new Response('No file uploaded or invalid file type.', { status: 400 }));
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
        return addCorsHeaders(new Response('Internal Server Error during file upload.', { status: 500 }));
      }
    }

    // EXTRACT CONCEPTS ENDPOINT
    // This endpoint will take the lectureId -> retrieve the raw lecture text -> extract the core concepts using Worker AI-> return the core concepts
    if (path === '/api/extract-concepts' && request.method === 'POST') {
      // --- VALIDATE SESSION ---
      const userId = await validateSession(request, env.lecturelens_db);
      if (!userId){
        return addCorsHeaders(new Response('Unauthorized', { status: 401 }));
      }

      // --- AUTHORIZATION (Ownership Check) ---
      const { lectureId } = await request.json() as { lectureId: string };
      if (!lectureId) {
        return addCorsHeaders(new Response('Missing lectureId in request body', { status: 400 }));
      }

      const ownership = await env.lecturelens_db.prepare('SELECT user_id FROM user_lectures WHERE user_id = ? AND lecture_id = ?').bind(userId, lectureId).first();
      if (!ownership){
        return addCorsHeaders(new Response('Forbidden: You do not have access to this lecture.', { status: 403 }));
      }

      // --- MAIN LOGIC ---
      try {
        // Get the Durable Object and stub for the lectureId
        const id = env.LECTURE_MEMORY.idFromName(lectureId);
        const stub = env.LECTURE_MEMORY.get(id);

        // Retrieve the raw lecture text from the DO
        const rawLectureResponse = await stub.fetch("https://do-placeholder/raw-lecture-text");
        
        if (!rawLectureResponse.ok) {
          return addCorsHeaders(new Response('Failed to retrieve lecture text from Durable Object', { status: 500 }));
        }

        const rawLectureData = await rawLectureResponse.json() as { rawText: string };
        const rawLectureText = rawLectureData.rawText;

        if (!rawLectureText) {
          return addCorsHeaders(new Response('No lecture text found', { status: 404 }));
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
      
        const { email, password } = await request.json() as { email: string, password: string };
        const { hash, salt } = await hashPassword(password);

        if (!email || !password){
          return addCorsHeaders(new Response('Missing email or password', { status: 400 }));
        }
        try {
        // Insert the user into the database
        await env.lecturelens_db.prepare('INSERT INTO users (id, email, password_hash, salt) VALUES (?, ?, ?, ?)').bind(crypto.randomUUID(), email, hash, salt).run();

        return addCorsHeaders(new Response(JSON.stringify({ message: 'User created successfully' }), {
          headers: { 'Content-Type': 'application/json' },
        }));
      } catch (error) {
        console.error('Signup error:', error);
        const errorMessage = error instanceof Error ? error.message : String(error);
        return addCorsHeaders(new Response(JSON.stringify({
          error: 'User already exists',
          details: errorMessage
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        }));
      }
    }

    // LOGIN ENDPOINT
    if (path === '/api/auth/login' && request.method === 'POST') {
      try {
        const { email, password } = await request.json() as { email: string, password: string };

        if (!email || !password){
          return addCorsHeaders(new Response('Missing email or password', { status: 400 }));
        }

        const user = await env.lecturelens_db.prepare('SELECT id, email, password_hash, salt FROM users WHERE email = ?').bind(email).first();

        if (!user) return addCorsHeaders(new Response('Invalid credentials', { status: 401 }));

        const {hash} = await hashPassword(password, user.salt as string);

        if (hash === user.password_hash){
          return addCorsHeaders(new Response(JSON.stringify({
             token: user.id, message: 'Login successful' 
            }), {status: 200, headers: { 'Content-Type': 'application/json' }}));
        } else {
          return addCorsHeaders(new Response('Invalid credentials', { status: 401 }));
        }
      } catch (error) {
        console.error('Login error:', error);
        return addCorsHeaders(new Response('Internal Server Error', { status: 500 }));
      }
    }

    // GET MY LECTURES ENDPOINT
    if (path === '/api/my-lectures' && request.method === 'GET') {
      // --- VALIDATE SESSION ---
      const userId = await validateSession(request, env.lecturelens_db);
      if (!userId){
        return addCorsHeaders(new Response('Unauthorized', { status: 401 }));
      }

      // --- MAIN LOGIC ---
      try {
        // Query the database for the lectures owned by this user
        const {results} = await env.lecturelens_db.prepare('SELECT lecture_id FROM user_lectures WHERE user_id = ?').bind(userId).all();

        // Return the lectures
        return addCorsHeaders(new Response(JSON.stringify({ lectures: results }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      } catch (error) {
        console.error('Get my lectures error:', error);
        return addCorsHeaders(new Response('Internal Server Error', { status: 500 }));
      }
    }

    // Handle OPTIONS request (preflight checks)
    if (request.method === 'OPTIONS'){
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
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
