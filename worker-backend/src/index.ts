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

interface Env {
  AI: any;
  LECTURE_MEMORY: DurableObjectNamespace;
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

    // Contextual Chat Endpoint
    // Handles requests like /api/chat/lecture-uuid-123
    if (path.startsWith('/api/chat/')) {
      const segments = path.split('/').filter(Boolean);
      const lectureId = segments[2];

      if (!lectureId) {
        return addCorsHeaders(new Response('Missing lecture ID in path.', { status: 400 }));
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

    // Summarization Endpoint
    if (path === '/api/summarize' && request.method === 'POST') {
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

    // File Upload Endpoint
    if (path === '/api/upload' && request.method === 'POST') {
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
