# Security Guidance

## Secrets Management
- Store secrets in environment variables or .env files (never commit .env)
- Use process.env for runtime access
- Rotate tokens periodically
- Never log secrets (mask them in logs: `token: "sk-...xxxx"`)

## Input Validation
- Validate types, lengths, and formats before processing
- Whitelist allowed values rather than blacklisting bad ones
- Sanitize HTML/markdown to prevent XSS
- Validate file uploads (type, size, content)

## Authentication & Authorization
- Always verify tokens server-side
- Check authorization on every protected endpoint
- Use short-lived tokens with refresh mechanism
- Hash passwords with bcrypt (cost factor >= 12)

## Network Security
- Use HTTPS everywhere
- Set CORS to specific origins, never wildcard in production
- Rate limit API endpoints
- Set security headers (HSTS, CSP, X-Frame-Options)

## File System
- Never construct file paths from user input without sanitization
- Use path.resolve() and verify the result is within expected directory
- Set restrictive file permissions (600 for secrets, 644 for public)
- Don't expose stack traces in production error responses

## Logging
- Log authentication events (login, logout, failed attempts)
- Log authorization failures
- Never log passwords, tokens, or personal data
- Include request IDs for correlation
