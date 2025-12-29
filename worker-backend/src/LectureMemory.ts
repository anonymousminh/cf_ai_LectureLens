interface ChatRequest {
  message: string;
}

export class LectureMemory {
  state: DurableObjectState;
  env: any;

  constructor(state: DurableObjectState, env: any) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Chat endpoint
    if (path === '/chat' && request.method === 'POST') {
      try {
        const { message } = (await request.json()) as ChatRequest;

        return new Response(JSON.stringify({
          response: `Received message: "${message}". Ready for memory implementation.`,
          doId: this.state.id.toString()
        }), {
          headers: { 'Content-Type': 'application/json' },
        });
      } catch (error) {
        console.error('Error processing chat request:', error);
        const errorMessage = error instanceof Error ? error.message : String(error);
        return new Response(JSON.stringify({
          error: 'Failed to process chat request',
          details: errorMessage
        }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    // Fallback
    return new Response("LectureMemory DO is active, but no action matched.", { status: 200 });
  }
}
