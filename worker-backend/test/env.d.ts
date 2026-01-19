declare module 'cloudflare:test' {
	interface ProvidedEnv extends Env {
		AI: any;
		LECTURE_MEMORY: DurableObjectNamespace;
		DB: D1Database;
	}
}
