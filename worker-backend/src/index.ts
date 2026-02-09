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
  GOOGLE_CLIENT_ID: string;
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
  newHeaders.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
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

        const model = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

        // For long documents, split into chunks and summarize each, then combine
        const MAX_CHARS_PER_CHUNK = 12000; // ~3000 tokens per chunk (safe for context window)
        let summary: string;

        if (text.length <= MAX_CHARS_PER_CHUNK) {
          // Short document: summarize directly
          const systemPrompt = "You are a helpful study assistant. Summarize the following lecture transcript into clear, structured key points. Use Markdown formatting for readability. Be thorough and cover ALL major topics discussed in the lecture.";
          const userPrompt = `Lecture Transcript:\n\n${text}`;

          const response = await env.AI.run(model, {
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt }
            ],
            max_tokens: 4096
          });

          summary = response.response;
        } else {
          // Long document: chunk → summarize each → combine summaries
          const chunks: string[] = [];
          const words = text.split(/\s+/);
          let currentChunk = '';

          for (const word of words) {
            if ((currentChunk + ' ' + word).length > MAX_CHARS_PER_CHUNK) {
              chunks.push(currentChunk.trim());
              currentChunk = word;
            } else {
              currentChunk += ' ' + word;
            }
          }
          if (currentChunk.trim()) {
            chunks.push(currentChunk.trim());
          }

          console.log(`Summarizing long document: ${text.length} chars, ${chunks.length} chunks`);

          // Summarize each chunk
          const chunkSummaries: string[] = [];
          for (let i = 0; i < chunks.length; i++) {
            const chunkSystemPrompt = `You are a helpful study assistant. Summarize the following section (part ${i + 1} of ${chunks.length}) of a lecture transcript into clear, structured key points. Use Markdown formatting. Be thorough and cover all topics in this section.`;
            const chunkUserPrompt = `Lecture Section:\n\n${chunks[i]}`;

            const chunkResponse = await env.AI.run(model, {
              messages: [
                { role: 'system', content: chunkSystemPrompt },
                { role: 'user', content: chunkUserPrompt }
              ],
              max_tokens: 2048
            });

            chunkSummaries.push(chunkResponse.response);
          }

          // If we had multiple chunks, combine the summaries into a final cohesive summary
          if (chunkSummaries.length > 1) {
            const combineSystemPrompt = "You are a helpful study assistant. You are given summaries of different sections of a lecture. Combine them into one cohesive, well-organized summary with clear key points. Use Markdown formatting with headings and bullet points. Remove any redundancy but keep all unique information.";
            const combineUserPrompt = `Section Summaries:\n\n${chunkSummaries.map((s, i) => `--- Section ${i + 1} ---\n${s}`).join('\n\n')}`;

            const combineResponse = await env.AI.run(model, {
              messages: [
                { role: 'system', content: combineSystemPrompt },
                { role: 'user', content: combineUserPrompt }
              ],
              max_tokens: 4096
            });

            summary = combineResponse.response;
          } else {
            summary = chunkSummaries[0];
          }
        }

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

        // 4. Validate file size (50MB limit for uploaded content)
        const maxFileSize = 50 * 1024 * 1024; // 50MB
        if (file.size > maxFileSize) {
          return addCorsHeaders(new Response(JSON.stringify({ 
            error: 'File too large',
            message: 'Uploaded file exceeds the maximum size of 50MB.',
            maxSize: '50MB'
          }), { 
            status: 413,
            headers: { 'Content-Type': 'application/json' }
          }));
        }

        // 5. Validate file name and detect file type
        const fileName = file.name || 'unknown';
        const fileExtension = fileName.split('.').pop()?.toLowerCase() || '';
        const isValidExtension = ['txt', 'pdf'].includes(fileExtension);
        
        if (!isValidExtension) {
          return addCorsHeaders(new Response(JSON.stringify({ 
            error: 'Invalid file type',
            message: 'Only PDF and TXT files are supported.',
            receivedExtension: fileExtension
          }), { 
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          }));
        }

        // 6. Read the file content as text
        const lectureText = await file.text();

        // 7. Validate the extracted text content
        if (!lectureText || lectureText.trim().length === 0) {
          return addCorsHeaders(new Response(JSON.stringify({ 
            error: 'Empty file',
            message: 'The uploaded file contains no text content. If this is a PDF, it may be image-only or corrupted.'
          }), { 
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          }));
        }

        // 8. Validate text length (max 10 million characters ~ 2-3 million words)
        const maxTextLength = 10_000_000;
        if (lectureText.length > maxTextLength) {
          return addCorsHeaders(new Response(JSON.stringify({ 
            error: 'Content too large',
            message: `Extracted text is too large (${lectureText.length} characters). Maximum is ${maxTextLength} characters.`,
            extractedLength: lectureText.length,
            maxLength: maxTextLength
          }), { 
            status: 413,
            headers: { 'Content-Type': 'application/json' }
          }));
        }

        // 9. Basic content validation - ensure it's reasonable text
        const minTextLength = 10; // At least 10 characters
        if (lectureText.trim().length < minTextLength) {
          return addCorsHeaders(new Response(JSON.stringify({ 
            error: 'Content too short',
            message: `The file content is too short (${lectureText.trim().length} characters). Please upload a file with meaningful content.`
          }), { 
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          }));
        }

        // Log file statistics for monitoring
        console.log('File upload:', {
          fileName,
          fileType: fileExtension,
          originalSize: file.size,
          textLength: lectureText.length,
          userId
        });

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

        // link the lecture to the user with metadata
        await env.lecturelens_db.prepare(
          'INSERT INTO user_lectures (user_id, lecture_id, lecture_name, created_at) VALUES (?, ?, ?, ?)'
        ).bind(userId, lectureId, fileName, new Date().toISOString()).run();

        // Return success with detailed metadata
        return addCorsHeaders(new Response(JSON.stringify({
          message: 'File received and stored successfully',
          lectureId: lectureId,
          fileName: file.name,
          fileType: fileExtension,
          textLength: lectureText.length,
          wordCount: lectureText.trim().split(/\s+/).length,
          uploadedAt: new Date().toISOString()
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
      } catch (error) {
        console.error('File Upload Error:', error);
        
        // Provide more detailed error information
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        const errorDetails: any = {
          error: 'File upload failed',
          message: 'An error occurred while processing your file.'
        };

        // Add specific error details if available
        if (errorMessage.includes('size')) {
          errorDetails.message = 'File size validation failed.';
        } else if (errorMessage.includes('parse') || errorMessage.includes('form')) {
          errorDetails.message = 'Failed to parse the uploaded file.';
        } else if (errorMessage.includes('Durable Object')) {
          errorDetails.message = 'Failed to store the lecture content.';
        }

        // Include error details in development/debugging
        if (errorMessage) {
          errorDetails.details = errorMessage;
        }

        return addCorsHeaders(new Response(JSON.stringify(errorDetails), { 
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

        // Call the Worker AI with chunking for long documents
        const model = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
        const MAX_CHARS_PER_CHUNK = 12000;
        let coreConceptsResponse: string;

        if (rawLectureText.length <= MAX_CHARS_PER_CHUNK) {
          // Short document: extract directly
          const systemPrompt = "You are a specialized academic assistant. Analyze the following lecture text and extract all key definitions, mathematical formulas, and core theoretical concepts. Format the output clearly using Markdown with bold terms and bullet points. Be thorough and cover ALL concepts in the text.";
          const userPrompt = `Lecture Text:\n\n${rawLectureText}`;

          const coreConcepts = await env.AI.run(model, {
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt }
            ],
            max_tokens: 4096
          });

          coreConceptsResponse = coreConcepts.response;
        } else {
          // Long document: chunk → extract from each → combine
          const chunks: string[] = [];
          const words = rawLectureText.split(/\s+/);
          let currentChunk = '';

          for (const word of words) {
            if ((currentChunk + ' ' + word).length > MAX_CHARS_PER_CHUNK) {
              chunks.push(currentChunk.trim());
              currentChunk = word;
            } else {
              currentChunk += ' ' + word;
            }
          }
          if (currentChunk.trim()) {
            chunks.push(currentChunk.trim());
          }

          console.log(`Extracting concepts from long document: ${rawLectureText.length} chars, ${chunks.length} chunks`);

          const chunkExtracts: string[] = [];
          for (let i = 0; i < chunks.length; i++) {
            const chunkSystemPrompt = `You are a specialized academic assistant. Analyze the following section (part ${i + 1} of ${chunks.length}) of a lecture and extract all key definitions, mathematical formulas, and core theoretical concepts. Format the output clearly using Markdown with bold terms and bullet points.`;
            const chunkUserPrompt = `Lecture Section:\n\n${chunks[i]}`;

            const chunkResponse = await env.AI.run(model, {
              messages: [
                { role: 'system', content: chunkSystemPrompt },
                { role: 'user', content: chunkUserPrompt }
              ],
              max_tokens: 2048
            });

            chunkExtracts.push(chunkResponse.response);
          }

          if (chunkExtracts.length > 1) {
            const combineSystemPrompt = "You are a specialized academic assistant. You are given concept extractions from different sections of a lecture. Combine them into one cohesive, well-organized list of all key definitions, formulas, and core concepts. Use Markdown formatting with bold terms and bullet points. Remove duplicates but keep all unique concepts.";
            const combineUserPrompt = `Section Extractions:\n\n${chunkExtracts.map((s, i) => `--- Section ${i + 1} ---\n${s}`).join('\n\n')}`;

            const combineResponse = await env.AI.run(model, {
              messages: [
                { role: 'system', content: combineSystemPrompt },
                { role: 'user', content: combineUserPrompt }
              ],
              max_tokens: 4096
            });

            coreConceptsResponse = combineResponse.response;
          } else {
            coreConceptsResponse = chunkExtracts[0];
          }
        }
        
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
        await env.lecturelens_db.prepare('INSERT INTO users (id, email, password_hash, salt, created_at) VALUES (?, ?, ?, ?, ?)').bind(crypto.randomUUID(), email, hash, salt, new Date().toISOString()).run();

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

    // GOOGLE AUTH ENDPOINT
    if (path === '/api/auth/google' && request.method === 'POST') {
      // --- IP-BASED RATE LIMITING (reuse login limits) ---
      const ipAddress = request.headers.get('CF-Connecting-IP') || 'unknown';
      const rateLimitStatus = await checkRateLimit(ipAddress, 'login', env);
      if (!rateLimitStatus.allowed) {
        console.log('Rate limit exceeded for google auth', { ip: ipAddress, remaining: rateLimitStatus.remaining });
        return createRateLimitResponse(rateLimitStatus);
      }

      try {
        const { credential } = await request.json() as { credential: string };

        if (!credential) {
          return addCorsHeaders(new Response(JSON.stringify({ error: 'Missing Google credential token' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          }));
        }

        // Verify the Google ID token using Google's tokeninfo endpoint
        const googleResponse = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${credential}`);
        if (!googleResponse.ok) {
          return addCorsHeaders(new Response(JSON.stringify({ error: 'Invalid Google token' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' }
          }));
        }

        const googleUser = await googleResponse.json() as {
          sub: string;
          email: string;
          email_verified: string;
          name?: string;
          aud: string;
        };

        // Verify the token audience matches our Google Client ID
        if (googleUser.aud !== env.GOOGLE_CLIENT_ID) {
          return addCorsHeaders(new Response(JSON.stringify({ error: 'Token audience mismatch' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' }
          }));
        }

        // Ensure the email is verified by Google
        if (googleUser.email_verified !== 'true') {
          return addCorsHeaders(new Response(JSON.stringify({ error: 'Google email is not verified' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          }));
        }

        const email = googleUser.email;
        const googleId = googleUser.sub;
        const name = googleUser.name || '';

        // Look for existing user by google_id first (returning Google user)
        let user = await env.lecturelens_db.prepare(
          'SELECT id, email, auth_provider, google_id FROM users WHERE google_id = ?'
        ).bind(googleId).first() as { id: string; email: string; auth_provider: string; google_id: string } | null;

        let isNewUser = false;

        if (!user) {
          // Check if a user with this email already exists (email/password user)
          user = await env.lecturelens_db.prepare(
            'SELECT id, email, auth_provider, google_id FROM users WHERE email = ?'
          ).bind(email).first() as { id: string; email: string; auth_provider: string; google_id: string } | null;

          if (user) {
            // Existing email user → link their Google account
            await env.lecturelens_db.prepare(
              'UPDATE users SET google_id = ?, name = COALESCE(name, ?) WHERE id = ?'
            ).bind(googleId, name, user.id).run();
          } else {
            // Brand new user → create account with Google provider
            const userId = crypto.randomUUID();
            await env.lecturelens_db.prepare(
              'INSERT INTO users (id, email, auth_provider, google_id, name, created_at) VALUES (?, ?, ?, ?, ?, ?)'
            ).bind(userId, email, 'google', googleId, name, new Date().toISOString()).run();
            user = { id: userId, email, auth_provider: 'google', google_id: googleId };
            isNewUser = true;
          }
        }

        // Create a session token (same as regular login)
        const token = crypto.randomUUID();
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

        await env.lecturelens_db.prepare(
          'INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'
        ).bind(token, user.id, new Date().toISOString(), expiresAt.toISOString()).run();

        return addCorsHeaders(new Response(JSON.stringify({
          token: token,
          message: isNewUser ? 'Account created with Google' : 'Login successful with Google',
          isNewUser: isNewUser,
          expiresAt: expiresAt.toISOString()
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      } catch (error) {
        console.error('Google auth error:', error);
        return addCorsHeaders(new Response(JSON.stringify({ error: 'Google authentication failed' }), {
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
        // Query the database for the lectures owned by this user with full metadata
        const {results} = await env.lecturelens_db.prepare(
          'SELECT lecture_id, lecture_name, created_at FROM user_lectures WHERE user_id = ? ORDER BY created_at DESC'
        ).bind(userId).all();

        // Return the lectures with metadata
        return addCorsHeaders(new Response(JSON.stringify({ lectures: results }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      } catch (error) {
        console.error('Get my lectures error:', error);
        return addCorsHeaders(new Response(JSON.stringify({ error: 'Internal Server Error' }), { 
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        }));
      }
    }

    // DELETE LECTURE ENDPOINT
    if (path.startsWith('/api/lectures/') && request.method === 'DELETE') {
      // --- VALIDATE SESSION ---
      const userId = await validateSession(request, env.lecturelens_db);
      if (!userId){
        return addCorsHeaders(new Response(JSON.stringify({ error: 'Unauthorized' }), { 
          status: 401,
          headers: { 'Content-Type': 'application/json' }
        }));
      }

      // Extract lecture ID from path
      const lectureId = path.split('/').pop();
      if (!lectureId) {
        return addCorsHeaders(new Response(JSON.stringify({ error: 'Missing lecture ID' }), { 
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        }));
      }

      // --- AUTHORIZATION (Ownership Check) ---
      const ownership = await env.lecturelens_db.prepare(
        'SELECT user_id FROM user_lectures WHERE user_id = ? AND lecture_id = ?'
      ).bind(userId, lectureId).first();
      
      if (!ownership){
        return addCorsHeaders(new Response(JSON.stringify({ error: 'Forbidden: You do not have access to this lecture.' }), { 
          status: 403,
          headers: { 'Content-Type': 'application/json' }
        }));
      }

      try {
        // Delete the lecture from user_lectures
        await env.lecturelens_db.prepare(
          'DELETE FROM user_lectures WHERE user_id = ? AND lecture_id = ?'
        ).bind(userId, lectureId).run();

        return addCorsHeaders(new Response(JSON.stringify({ 
          message: 'Lecture deleted successfully',
          lectureId: lectureId
        }), { 
          status: 200, 
          headers: { 'Content-Type': 'application/json' } 
        }));
      } catch (error) {
        console.error('Delete lecture error:', error);
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

    // STATS ENDPOINT - Track signups and usage
    // This endpoint returns aggregate statistics about the app
    if (path === '/api/stats' && request.method === 'GET') {
      try {
        // Get total user count
        const userCountResult = await env.lecturelens_db.prepare(
          'SELECT COUNT(*) as count FROM users'
        ).first();
        
        // Get total lecture count
        const lectureCountResult = await env.lecturelens_db.prepare(
          'SELECT COUNT(*) as count FROM user_lectures'
        ).first();
        
        // Get signups in the last 24 hours
        const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const recentSignupsResult = await env.lecturelens_db.prepare(
          'SELECT COUNT(*) as count FROM users WHERE created_at > ?'
        ).bind(oneDayAgo).first();
        
        // Get signups in the last 7 days
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
        const weeklySignupsResult = await env.lecturelens_db.prepare(
          'SELECT COUNT(*) as count FROM users WHERE created_at > ?'
        ).bind(sevenDaysAgo).first();

        // Get auth provider breakdown
        const emailUsersResult = await env.lecturelens_db.prepare(
          "SELECT COUNT(*) as count FROM users WHERE auth_provider = 'email'"
        ).first();
        
        const googleUsersResult = await env.lecturelens_db.prepare(
          "SELECT COUNT(*) as count FROM users WHERE auth_provider = 'google'"
        ).first();

        // Google-linked users (email users who also connected Google)
        const googleLinkedResult = await env.lecturelens_db.prepare(
          "SELECT COUNT(*) as count FROM users WHERE auth_provider = 'email' AND google_id IS NOT NULL"
        ).first();

        // Google signups in the last 24 hours
        const recentGoogleSignupsResult = await env.lecturelens_db.prepare(
          "SELECT COUNT(*) as count FROM users WHERE auth_provider = 'google' AND created_at > ?"
        ).bind(oneDayAgo).first();

        // Google signups in the last 7 days
        const weeklyGoogleSignupsResult = await env.lecturelens_db.prepare(
          "SELECT COUNT(*) as count FROM users WHERE auth_provider = 'google' AND created_at > ?"
        ).bind(sevenDaysAgo).first();

        return addCorsHeaders(new Response(JSON.stringify({
          totalUsers: userCountResult?.count || 0,
          totalLectures: lectureCountResult?.count || 0,
          signupsLast24Hours: recentSignupsResult?.count || 0,
          signupsLast7Days: weeklySignupsResult?.count || 0,
          authProviders: {
            emailUsers: emailUsersResult?.count || 0,
            googleUsers: googleUsersResult?.count || 0,
            googleLinkedUsers: googleLinkedResult?.count || 0,
          },
          googleSignupsLast24Hours: recentGoogleSignupsResult?.count || 0,
          googleSignupsLast7Days: weeklyGoogleSignupsResult?.count || 0,
          timestamp: new Date().toISOString()
        }), { 
          status: 200, 
          headers: { 'Content-Type': 'application/json' } 
        }));
      } catch (error) {
        console.error('Stats error:', error);
        return addCorsHeaders(new Response(JSON.stringify({ error: 'Failed to fetch stats' }), { 
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
          'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
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
