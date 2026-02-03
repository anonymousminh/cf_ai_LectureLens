/**
 * Pages Function: API Proxy
 * 
 * This function acts as a proxy to forward all /api/* requests
 * to the Worker backend via Service Binding.
 */

export async function onRequest(context) {
  const { request, env } = context;
  
  // Check if Service Binding is available
  if (!env.WORKER_BACKEND) {
    return new Response(JSON.stringify({
      error: 'Service binding WORKER_BACKEND not configured',
      hint: 'Add a Service Binding in Cloudflare Dashboard: Pages > Settings > Functions > Service bindings'
    }), {
      status: 503,
      headers: { 
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });
  }
  
  try {
    // Create a new request with the correct URL for the Worker
    const workerUrl = new URL(request.url);
    workerUrl.hostname = 'worker-backend';
    
    const workerRequest = new Request(workerUrl.toString(), {
      method: request.method,
      headers: request.headers,
      body: request.body
    });
    
    // Forward the request to the Worker backend via Service Binding
    const response = await env.WORKER_BACKEND.fetch(workerRequest);
    return response;
  } catch (error) {
    console.error('Error calling Worker backend:', error);
    return new Response(JSON.stringify({
      error: 'Failed to reach backend service',
      details: error instanceof Error ? error.message : String(error)
    }), {
      status: 500,
      headers: { 
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });
  }
}

// Handle OPTIONS for CORS preflight
export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    }
  });
}
