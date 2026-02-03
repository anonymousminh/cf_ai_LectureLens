/**
 * Handle POST /api/auth/login
 */
export async function onRequestPost(context) {
  const { request, env } = context;
  
  // Check if Service Binding is available
  if (!env.WORKER_BACKEND) {
    return new Response(JSON.stringify({
      error: 'Service binding WORKER_BACKEND not configured',
      hint: 'Add Service Binding in Cloudflare Dashboard: Pages > Settings > Functions'
    }), {
      status: 503,
      headers: { 
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });
  }
  
  try {
    // Forward to Worker backend
    const response = await env.WORKER_BACKEND.fetch(request);
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

// Handle OPTIONS for CORS preflight
export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    }
  });
}
