/**
 * Pages Function: API Proxy
 * 
 * This function acts as a proxy to forward all /api/* requests
 * to the Worker backend via Service Binding.
 * 
 * The [[path]] catch-all captures everything after /api/
 * For example: /api/chat/lecture-123 -> forwards to Worker
 */

interface Env {
  WORKER_BACKEND: {
    fetch(request: Request): Promise<Response>;
  };
}

export async function onRequest(context: { request: Request; env: Env }) {
  const { request, env } = context;
  
  try {
    // Forward the request to the Worker backend via Service Binding
    // The Service Binding automatically handles the request routing
    const response = await env.WORKER_BACKEND.fetch(request);
    
    return response;
  } catch (error) {
    console.error('Error calling Worker backend:', error);
    return new Response(JSON.stringify({
      error: 'Failed to reach backend service',
      details: error instanceof Error ? error.message : String(error)
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

