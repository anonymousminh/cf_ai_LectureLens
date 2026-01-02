interface ChatRequest {
  message: string;
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

interface ChatHistory {
  messages: ChatMessage[];
}

interface LectureContentRequest{
  lectureText: string;
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

        // 1. Define the storage key for the chat history
        const HISTORY_KEY = "chat_history";

        // 2. Retrieve the existing history (or initialize if there is not)
        let history = (await this.state.storage.get<ChatHistory>(HISTORY_KEY)) || {messages: []};

        // 3. Append the new user message
        const userMessage: ChatMessage = {
          role: 'user',
          content: message,
          timestamp: Date.now()
        };

        // 4. Add the user message to the history
        history.messages.push(userMessage);

        // 5. Save the updated history back to storage
        await this.state.storage.put(HISTORY_KEY, history);

        // 6. Construct the AI prompt that use the history
        const systemPrompt = "You are LectureLens, an AI-powered study assistant. Your goal is to answer question strictly based on the provided conversation history and lecture context. Respond concisely and helpfully.";

        // 7. Map the history to the format required by the AI model
        const aiMessage = history.messages.map(msg => ({
          role: msg.role,
          content: msg.content
        }));

        // 8. Prepend the system prompt
        const messages = [
          {role: 'system', content: systemPrompt},
          ...aiMessage
        ]

        // 9. Call the Workers AI binding
        const model = '@cf/meta/llama-3-8b-instruct';
        const aiResponse = await this.env.AI.run(model, {messages});

        const assistantResponse = aiResponse.response;

        // 10. Append the AI's response to the history and save it
        const assistantMessage: ChatMessage = {
          role: 'assistant',
          content: assistantResponse,
          timestamp: Date.now()
        };

        history.messages.push(assistantMessage);
        await this.state.storage.put(HISTORY_KEY, history);

        // 11. Return the AI's response to the user
        return new Response(JSON.stringify({
          response: assistantResponse,
          doId: this.state.id.toString()
        }), {
          headers: {'Content-Type': 'application/json'}
        })
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

    // Lecture endpoint
    if (path === '/lecture' && request.method === 'POST'){
      try {
      // Define the json lecture text body
      const {lectureText} = (await request.json()) as LectureContentRequest;

      if (!lectureText){
        return new Response('Missing lectureText property in the body', {status: 400});
      }
      // Define the key for lecture text
      const LECTURE_KEY = "raw_lecture_text";

      // Save the lecture text to the storage
      await this.state.storage.put(LECTURE_KEY, lectureText);

      return new Response(JSON.stringify({
        response: 'Received and stored the lecture content successfully'
      }), {
        headers: {'Content-Type': 'application/json'}
      });
      } catch (error){
        console.log('Error when save the lecture text', error);
        const errorMessage = error instanceof Error ? error.message : String(error);
        return new Response(JSON.stringify({
          error: 'Fail to process the lecture content',
          details: errorMessage
        }), {
          status: 500,
          headers: {'Content-Type': 'application/json'}
        });
      }
    }

    // Fallback
    return new Response("LectureMemory DO is active, but no action matched.", { status: 200 });
  }
}
