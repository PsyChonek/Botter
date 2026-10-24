// Structured JSON logger, one line per event. LOG_LEVEL picks the minimum level.
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const min = LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info;

function emit(level, msg, fields = {}) {
  if (LEVELS[level] < min) return;
  const line = JSON.stringify({ time: new Date().toISOString(), app: 'botter-server', level, msg, ...fields });
  (level === 'error' ? process.stderr : process.stdout).write(line + '\n');
}

export const log = {
  debug: (msg, fields) => emit('debug', msg, fields),
  info: (msg, fields) => emit('info', msg, fields),
  warn: (msg, fields) => emit('warn', msg, fields),
  error: (msg, fields) => emit('error', msg, fields),
};
