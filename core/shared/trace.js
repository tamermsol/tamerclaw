/**
 * Distributed Tracing / Correlation IDs
 *
 * Lightweight tracing for request flow across bridge, relay, and supreme.
 * Each message gets a traceId that follows it through the system.
 */

import crypto from 'crypto';

/**
 * Generate a new trace ID (compact, URL-safe).
 * Format: {timestamp-hex}-{random-4bytes}
 */
export function newTraceId() {
  const ts = Date.now().toString(36);
  const rand = crypto.randomBytes(4).toString('hex');
  return `${ts}-${rand}`;
}

/**
 * Create a child span ID from a parent trace.
 */
export function newSpanId() {
  return crypto.randomBytes(4).toString('hex');
}

/**
 * Create a trace context object.
 */
export function createTrace(component, operation, parentTraceId = null) {
  return {
    traceId: parentTraceId || newTraceId(),
    spanId: newSpanId(),
    component,
    operation,
    startedAt: Date.now()
  };
}

/**
 * Format a log prefix with trace context.
 */
export function tracePrefix(trace) {
  if (!trace) return '';
  return `[${trace.component}][${trace.traceId}]`;
}

/**
 * Create a traced logger that includes trace context in every message.
 */
export function tracedLogger(trace) {
  const prefix = tracePrefix(trace);
  return {
    log: (...args) => console.log(prefix, ...args),
    error: (...args) => console.error(prefix, ...args),
    warn: (...args) => console.warn(prefix, ...args),
    trace // expose trace context for passing downstream
  };
}

/**
 * Stamp a message object with trace context before writing to inbox/outbox.
 */
export function stampMessage(msg, trace) {
  return {
    ...msg,
    traceId: trace?.traceId || msg.traceId || newTraceId(),
    spanId: trace?.spanId || newSpanId()
  };
}

/**
 * Extract trace context from a message object.
 */
export function extractTrace(msg, component = 'unknown') {
  if (msg.traceId) {
    return {
      traceId: msg.traceId,
      spanId: msg.spanId || newSpanId(),
      component,
      operation: 'process',
      startedAt: Date.now()
    };
  }
  return createTrace(component, 'process');
}
