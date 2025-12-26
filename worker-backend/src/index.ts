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
import { LectureMemory} from "./LectureMemory";
interface Env{
	AI: any;
	LECTURE_MEMORY: DurableObjectNamespace;
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname;

		// Implement simple routing
		if (path == '/' && request.method == 'GET') {
			return new Response('LectureLens API is running!', { status: 200 });
		}

		// Summarize endpoint
		if (path == '/api/summarize' && request.method == 'POST'){
			try {
				const { text } = await request.json() as { text?: string };

				if (!text){
					return new Response('Text is required', { status: 400 });
				}

				// Define the system prompt for the AI
				const prompt = `
					You are a helpful study assistant. Summarize the following lecture transcript into clear, structured key points. Use markdown format for readability.
					Here is the lecture transcript:
					${text}
				`;

				// Call the AI
				const response = await env.AI.run("@cf/meta/llama-3-8b-instruct", {
					prompt: prompt,
				});

				// Extract the summary from the response
				const summary = response.response;

				return new Response(JSON.stringify({ summary }), {
					headers: {
						'Content-Type': 'application/json',
					},
				});	
			} catch (error) {
				console.error('Error summarizing text:', error);
				return new Response('Error summarizing text', { status: 500 });
			}
		}

		if (path == '/api/do-test' && request.method == 'GET'){
			const id = env.LECTURE_MEMORY.idFromName("test-lecture-id");
			const stub = env.LECTURE_MEMORY.get(id);

			// Forward the request to DO
			const doResponse = await stub.fetch(request.url);
			return doResponse;
		}

		return new Response('Not Found.', { status: 404 });
	}
};

export { LectureMemory };
