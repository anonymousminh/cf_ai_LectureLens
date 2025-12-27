interface SaveDataRequest {
    value: string;
}

export class LectureMemory {
    state: DurableObjectState;
    env: any;

    constructor(state: DurableObjectState, env: any) {
        this.state = state;
        this.env = env;
    }

    async fetch(request: Request): Promise<Response>{
        const url = new URL(request.url);
        const segments = url.pathname.split('/').filter(Boolean);
        const action = segments[segments.length - 1];

        // Endpoint to save data
        if (action == 'save' && request.method == 'POST'){
            const {value} = (await request.json()) as SaveDataRequest;
            if (!value){
                return new Response(`Missing "value in the request body"`, {status: 400});
            }
            await this.state.storage.put("test-data", value);
            return new Response(`Saved: ${value}`, {status: 200});
        }

        // Endpoint to retrieve data
        if (action == 'get' && request.method == 'GET'){
            const value = await this.state.storage.get("test-data");

            if (value == undefined){
                return new Response(`No data found`, {status: 404});
            }
            return new Response(`Retrieved: ${value}`, {status: 200});
        }
        return new Response(`LectureMemory DO is active`, {status: 200});
    }
}