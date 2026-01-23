// Helper function to convert Buffer to Hex String
function bufToHex(buf: ArrayBuffer): string {
    return Array.from(new Uint8Array(buf))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}

// Helper function to convert Hex String to Buffer
function hexToBuf(hex: string): ArrayBuffer {
    return Uint8Array.from(hex.match(/.{1,2}/g)!.map(byte => parseInt(byte, 16))).buffer;
}

// Async function for validating session
export async function validateSession(request: Request, db: D1Database){
   // Get the Authorization header
   const authHeader = request.headers.get('Authorization');
   
   // Check if it exists and follows the "Bearer <token>" format
   if (!authHeader || !authHeader.startsWith('Bearer ')){
       return null;
   }

   // Extract the token from the header
   const token = authHeader.split(' ')[1];
   
   if (!token){
       return null;
   }

   try {
       // Query the database for the session with user_id and expires_at
       const session = await db.prepare('SELECT user_id, expires_at FROM sessions WHERE token = ?').bind(token).first();

       // Check if the session exists
       if (!session){
           return null;
       }

       // Check if the session is expired (expires_at is stored as ISO string or timestamp)
       const expiresAt = new Date(session.expires_at as string);
       const now = new Date();
       
       if (expiresAt < now){
           // Delete expired session during validation
           await db.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
           return null;
       }

       // Return the user_id if session is valid
       return session.user_id as string;
   } catch (error) {
       console.error('Session validation error:', error);
       return null;
   }
}

export async function hashPassword(password: string, saltStr?: string){
    const encoder = new TextEncoder();
    const salt = saltStr ? hexToBuf(saltStr) : crypto.getRandomValues(new Uint8Array(16));

    const keyMaterial = await crypto.subtle.importKey(
        'raw',
        encoder.encode(password),
        'PBKDF2',
        false,
        ['deriveBits'],
    );

    const hash = await crypto.subtle.deriveBits(
        {
            name: 'PBKDF2',
            salt: salt,
            iterations: 100000,
            hash: 'SHA-256',
        },
        keyMaterial,
        256,
    );

    return {
        hash: bufToHex(hash),
        salt: bufToHex(salt instanceof ArrayBuffer ? salt : salt.buffer),
    }
}