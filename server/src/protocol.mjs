// Validates messages from the dashboard WebSocket. Returns null for anything
// that does not match exactly, so the browser only sees well-formed commands.
const BUTTONS = new Set(['left', 'middle', 'right']);
const TARGETS = new Set(['casino', 'settings']);
const NAV = new Set(['back', 'forward', 'reload', 'goto']);

const isCoord = (value) => Number.isFinite(value) && value >= 0 && value <= 10_000;
const isDelta = (value) => Number.isFinite(value) && Math.abs(value) <= 10_000;
const isId = (value) => typeof value === 'string' && /^[\w-]{1,32}$/.test(value);

function parseInput(event) {
  if (!event || typeof event !== 'object') return null;
  const { kind } = event;
  if (kind === 'move' && isCoord(event.x) && isCoord(event.y)) return { kind, x: event.x, y: event.y };
  if ((kind === 'down' || kind === 'up') && isCoord(event.x) && isCoord(event.y) && BUTTONS.has(event.button)) {
    return { kind, x: event.x, y: event.y, button: event.button };
  }
  if (kind === 'wheel' && isCoord(event.x) && isCoord(event.y) && isDelta(event.dx) && isDelta(event.dy)) {
    return { kind, x: event.x, y: event.y, dx: event.dx, dy: event.dy };
  }
  if ((kind === 'keydown' || kind === 'keyup') && typeof event.key === 'string' && event.key.length >= 1 && event.key.length <= 32) {
    return { kind, key: event.key };
  }
  if (kind === 'text' && typeof event.text === 'string' && event.text.length >= 1 && event.text.length <= 10_000) {
    return { kind, text: event.text };
  }
  return null;
}

export function parseClientMessage(raw) {
  let message;
  try {
    message = JSON.parse(String(raw));
  } catch {
    return null;
  }
  if (!message || typeof message !== 'object') return null;
  switch (message.type) {
    case 'input': {
      const event = parseInput(message.event);
      return event && { type: 'input', event };
    }
    case 'select':
    case 'close':
      return isId(message.id) ? { type: message.type, id: message.id } : null;
    case 'open':
      return TARGETS.has(message.target) ? { type: 'open', target: message.target } : null;
    case 'nav':
      if (!NAV.has(message.action)) return null;
      if (message.action !== 'goto') return { type: 'nav', action: message.action };
      return typeof message.url === 'string' && message.url.length <= 2048 ? { type: 'nav', action: 'goto', url: message.url } : null;
    default:
      return null;
  }
}
