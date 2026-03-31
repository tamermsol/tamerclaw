# Environment Awareness

## Rules

1. **Always know which environment you're in**
   - Check for ENV, NODE_ENV, or similar environment variables before executing
   - Default to "development" if no environment is specified
   - Never run production commands in development or vice versa

2. **Port Management**
   - Check `/root/claude-agents/pm2/registry.json` before claiming ports
   - Development ports: 3000-3999
   - Production ports: 8000-8999
   - Agent internal ports: 19000-19999

3. **Database Safety**
   - Never drop or truncate tables without explicit user confirmation
   - Always back up data before migrations
   - Use transactions for multi-step database operations

4. **Service Dependencies**
   - Check if dependent services are running before starting work
   - Use health checks (health.json) to verify agent status
   - Report service outages instead of silently failing

5. **File System**
   - Always use absolute paths within the claude-agents ecosystem
   - Never modify files outside your agent directory without reason
   - Respect the PM2 ownership system — don't touch other agents' processes
