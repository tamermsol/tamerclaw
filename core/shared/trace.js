/**
 * Distributed Tracing / Correlation IDs
 */
import crypto from 'crypto';

export function newTraceId() {
  const ts = Date.now().toString(36);
  const rand = crypto.randomBytes(4).toString('hex');
  return `${ts}-${rand}`;
}

export function newSpanId() {
  return crypto.randomBytes(4).toString('hex');
}

export function createTrace(component, operation, parentTraceId = null) {
  return {
    traceId: parentTraceId || newTraceId(),
    spanId: newSpanId(),
    component,
    operation,
    startedAt: Date.now()
  };
}

export function tracePrefix(trace) {
  if (!trace) return '';
  return `[${trace.component}][${trace.traceId}]`;
}

export function tracedLogger(trace) {
  const prefix = tracePrefix(trace);
  return {
    log: (...args) => console.log(prefix, ...args),
    error: (...args) => console.error(prefix, ...args),
    warn: (...args) => console.warn(prefix, ...args),
    trace
  };
}

export function stampMessage(msg, trace) {
  return {
    ...msg,
    traceId: trace?.traceId || msg.traceId || newTraceId(),
    spanId: trace?.spanId || newSpanId()
  };
}

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
