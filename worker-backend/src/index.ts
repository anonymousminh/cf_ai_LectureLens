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
interface Env{
	AI: any;
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname;

		// Implement simple routing
		if (path == '/' && request.method == 'GET') {
			return new Response('LectureLens API is running!', { status: 200 });
		}

		if (path == '/api/ai-test' && request.method == 'GET'){

		
		// Call the Worker API
		const response = await env.AI.run("@cf/meta/llama-3-8b-instruct", {prompt: "What is Cloudflare in one sentence?"});

		// Return the response from the worker AI
		return new Response(JSON.stringify(response));
		}


		return new Response('Not Found.', { status: 404 });
	}
};
