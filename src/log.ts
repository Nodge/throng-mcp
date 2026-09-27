// stdout is the MCP stdio transport, so every log line goes to stderr.

type Level = 'info' | 'warn' | 'error';
type Fields = Record<string, unknown>;

function write(level: Level, msg: string, fields?: Fields): void {
  let line = `${new Date().toISOString()} ${level} ${msg}`;
  if (fields) {
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) continue;
      line += ` ${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`;
    }
  }
  process.stderr.write(line.replaceAll('\n', ' ') + '\n');
}

/** One short stderr line per call: ISO timestamp, level, message, `key=value` fields. */
export const log = {
  info: (msg: string, fields?: Fields) => write('info', msg, fields),
  warn: (msg: string, fields?: Fields) => write('warn', msg, fields),
  error: (msg: string, fields?: Fields) => write('error', msg, fields),
};
