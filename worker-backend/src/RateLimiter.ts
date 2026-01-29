// TypeScript interfaces for rate limiting
interface RateLimitWindow {
  count: number;
  windowStart: number; // Unix timestamp in milliseconds
  windowDuration: number; // Duration in milliseconds
}

interface RateLimitConfig {
  maxRequests: number;
  windowSeconds: number;
}

interface RateLimitStatus {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number; // Unix timestamp in milliseconds
  retryAfter: number; // Seconds until retry (if denied)
}

interface LimitsStorage {
  [endpoint: string]: RateLimitWindow;
}

// Rate limit configuration per endpoint
const RATE_LIMIT_CONFIG: { [key: string]: RateLimitConfig } = {
  chat: {
    maxRequests: 15,
    windowSeconds: 60, // 15 requests per minute
  },
  summarize: {
    maxRequests: 5,
    windowSeconds: 3600, // 5 per hour
  },
  extract: {
    maxRequests: 5,
    windowSeconds: 3600, // 5 per hour
  },
  upload: {
    maxRequests: 10,
    windowSeconds: 3600, // 10 per hour
  },
  signup: {
    maxRequests: 3,
    windowSeconds: 3600, // 3 signups per hour per IP
  },
  login: {
    maxRequests: 10,
    windowSeconds: 3600, // 10 login attempts per hour per IP
  },
};

export class RateLimiter {
  state: DurableObjectState;
  env: any;

  private readonly STORAGE_KEY = 'limits';

  constructor(state: DurableObjectState, env: any) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const endpoint = url.searchParams.get('endpoint');

    try {
      // Route to appropriate handler
      if (path === '/check' && endpoint) {
        return await this.handleCheck(endpoint);
      } else if (path === '/check-and-increment' && endpoint) {
        return await this.handleCheckAndIncrement(endpoint);
      } else if (path === '/reset' && endpoint) {
        return await this.handleReset(endpoint);
      } else if (path === '/reset-all') {
        return await this.handleResetAll();
      } else {
        return new Response('Invalid endpoint or missing parameters', { status: 400 });
      }
    } catch (error) {
      console.error('RateLimiter error:', error);
      return new Response(
        JSON.stringify({
          error: 'Rate limiter error',
          details: error instanceof Error ? error.message : String(error),
        }),
        {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }
  }

  /**
   * Check if a request is allowed without incrementing the counter
   */
  private async handleCheck(endpoint: string): Promise<Response> {
    const status = await this.checkLimit(endpoint);
    return new Response(JSON.stringify(status), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  /**
   * Check limit and increment counter in one operation (more efficient)
   */
  private async handleCheckAndIncrement(endpoint: string): Promise<Response> {
    const status = await this.checkLimit(endpoint);

    if (status.allowed) {
      // Increment the counter
      await this.incrementCounter(endpoint);
      // Get updated status
      const updatedStatus = await this.checkLimit(endpoint);
      return new Response(JSON.stringify(updatedStatus), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Return denied status
    return new Response(JSON.stringify(status), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  /**
   * Reset rate limit for a specific endpoint
   */
  private async handleReset(endpoint: string): Promise<Response> {
    const limits = (await this.state.storage.get<LimitsStorage>(this.STORAGE_KEY)) || {};
    delete limits[endpoint];
    await this.state.storage.put(this.STORAGE_KEY, limits);

    return new Response(JSON.stringify({ message: `Reset limit for ${endpoint}` }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  /**
   * Reset all rate limits
   */
  private async handleResetAll(): Promise<Response> {
    await this.state.storage.delete(this.STORAGE_KEY);
    return new Response(JSON.stringify({ message: 'Reset all limits' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  /**
   * Core rate limiting logic - checks if request is allowed
   */
  private async checkLimit(endpoint: string): Promise<RateLimitStatus> {
    // Get configuration for this endpoint
    const config = RATE_LIMIT_CONFIG[endpoint];
    if (!config) {
      // If endpoint not configured, allow by default but log warning
      console.warn(`No rate limit config for endpoint: ${endpoint}`);
      return {
        allowed: true,
        limit: 999999,
        remaining: 999999,
        resetAt: Date.now() + 3600000,
        retryAfter: 0,
      };
    }

    const { maxRequests, windowSeconds } = config;
    const windowDuration = windowSeconds * 1000; // Convert to milliseconds
    const now = Date.now();

    // Load current limits from storage
    const limits = (await this.state.storage.get<LimitsStorage>(this.STORAGE_KEY)) || {};

    // Get or initialize window for this endpoint
    let window = limits[endpoint];

    // Check if window has expired or doesn't exist
    if (!window || now >= window.windowStart + window.windowDuration) {
      // Start a fresh window
      window = {
        count: 0,
        windowStart: now,
        windowDuration: windowDuration,
      };
      limits[endpoint] = window;
      await this.state.storage.put(this.STORAGE_KEY, limits);
    }

    // Check if limit is exceeded
    if (window.count >= maxRequests) {
      const resetAt = window.windowStart + window.windowDuration;
      const retryAfter = Math.ceil((resetAt - now) / 1000); // Convert to seconds

      return {
        allowed: false,
        limit: maxRequests,
        remaining: 0,
        resetAt,
        retryAfter: Math.max(0, retryAfter),
      };
    }

    // Request is allowed
    const remaining = maxRequests - window.count;
    const resetAt = window.windowStart + window.windowDuration;

    return {
      allowed: true,
      limit: maxRequests,
      remaining,
      resetAt,
      retryAfter: 0,
    };
  }

  /**
   * Increment the counter for an endpoint
   */
  private async incrementCounter(endpoint: string): Promise<void> {
    const config = RATE_LIMIT_CONFIG[endpoint];
    if (!config) {
      return; // Don't increment if no config
    }

    const windowDuration = config.windowSeconds * 1000;
    const now = Date.now();

    // Load current limits
    const limits = (await this.state.storage.get<LimitsStorage>(this.STORAGE_KEY)) || {};

    // Get or initialize window for this endpoint
    let window = limits[endpoint];
    if (!window || now >= window.windowStart + window.windowDuration) {
      // Create new window
      window = {
        count: 0,
        windowStart: now,
        windowDuration: windowDuration,
      };
    }

    // Increment counter
    window.count += 1;
    limits[endpoint] = window;

    // Save back to storage
    await this.state.storage.put(this.STORAGE_KEY, limits);
  }
}
