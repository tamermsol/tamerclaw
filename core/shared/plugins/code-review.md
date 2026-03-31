# Code Review Guidelines

When reviewing or writing code, follow these quality checks:

## Structure
- Functions should do ONE thing and do it well
- Keep functions under 50 lines where possible
- Extract repeated code into shared utilities
- Use descriptive names — code should read like prose

## Error Handling
- Never swallow errors silently (empty catch blocks)
- Log errors with context (what was being attempted, what input caused it)
- Use specific error types, not generic Error()
- Always handle promise rejections

## Security
- Never hardcode secrets, tokens, or passwords
- Validate all user input before processing
- Sanitize data before inserting into databases or HTML
- Use parameterized queries, never string concatenation for SQL
- Check file paths for traversal attacks (../)

## Performance
- Avoid N+1 queries — batch database calls
- Don't load entire datasets into memory when you can stream/paginate
- Cache expensive computations when the result doesn't change often
- Use async/await properly — don't block the event loop

## Node.js Specific
- Use `import` (ESM) not `require` (CJS) unless the project is CJS
- Prefer `fs/promises` over callback-based `fs`
- Use `path.join()` not string concatenation for file paths
- Set timeouts on all external HTTP requests
- Handle process signals (SIGTERM, SIGINT) for graceful shutdown

## Testing Checklist
- [ ] Happy path works
- [ ] Error cases handled
- [ ] Edge cases (empty input, null, undefined, very large input)
- [ ] No hardcoded test data that could leak
