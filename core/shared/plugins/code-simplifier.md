# Code Simplifier Patterns

When you notice these patterns, simplify:

## Unnecessary Complexity
```js
// Bad: Overly verbose
if (condition === true) { return true; } else { return false; }
// Good: Simple
return condition;

// Bad: Unnecessary variable
const result = someFunction();
return result;
// Good: Direct return
return someFunction();

// Bad: Manual array building
const items = [];
for (const item of list) { items.push(transform(item)); }
// Good: Map
const items = list.map(transform);
```

## Reduce Nesting
```js
// Bad: Deep nesting
function process(input) {
  if (input) {
    if (input.valid) {
      if (input.data) {
        return doWork(input.data);
      }
    }
  }
  return null;
}
// Good: Early returns
function process(input) {
  if (!input?.valid?.data) return null;
  return doWork(input.data);
}
```

## Prefer Modern Syntax
- Use optional chaining: `obj?.prop?.nested`
- Use nullish coalescing: `value ?? defaultValue`
- Use template literals: `` `Hello ${name}` ``
- Use destructuring: `const { a, b } = obj`
- Use async/await over .then() chains

## DRY (Don't Repeat Yourself)
- If you copy-paste code, extract it into a function
- If 3+ agents need the same logic, put it in /root/claude-agents/shared/
- If a constant is used in multiple places, define it once

## File Organization
- One concern per file
- Related files in the same directory
- Shared utilities in shared/
- Agent-specific code in the agent's directory
