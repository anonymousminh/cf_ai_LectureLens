/**
 * Handle POST /api/auth/signup
 */
export async function onRequestPost(context) {
  const { request, env } = context;
  
  if (!env.WORKER_BACKEND) {
    return new Response(JSON.stringify({
      error: 'Service binding WORKER_BACKEND not configured'
    }), {
      status: 503,
      headers: { 
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });
  }
  
  try {
    // Create a new request with the correct path for the Worker
    const workerUrl = new URL(request.url);
    workerUrl.hostname = 'worker-backend';
    
    const workerRequest = new Request(workerUrl.toString(), {
      method: request.method,
      headers: request.headers,
      body: request.body
    });
    
    const response = await env.WORKER_BACKEND.fetch(workerRequest);
    return response;
  } catch (error) {
    return new Response(JSON.stringify({
      error: 'Failed to reach backend',
      details: String(error)
    }), {
      status: 500,
      headers: { 
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    }
  });
}
