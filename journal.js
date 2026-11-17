import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

// Убирает секреты из диагностики записи настроек; ответы OAuth сюда не передаются.
export function settingsDiagnostic(error) {
  return String(error?.message ?? 'SETTINGS_WRITE_FAILED')
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?/g, '[REDACTED]')
    .replace(/((?:token|secret|password|code)\s*[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/https?:\/\/[^\s]+/g, '[URL]')
    .slice(0, 500);
}

// Дублирует безопасные события коннектора из штатного logger в ограниченный по размеру журнал DSH.
export function createJournal(logger, file) {
  let queue = Promise.resolve();
  return {
    write(level, event, fields = {}) {
      const record = { time: new Date().toISOString(), source: 'chatgpt-codex', level, event, ...fields };
      logger[level](JSON.stringify(record));
      if (!file) return;
      queue = queue.then(async () => {
        await mkdir(dirname(file), { recursive: true });
        const size = await stat(file).then(info => info.size, error => { if (error.code === 'ENOENT') return 0; throw error; });
        if (size > 2 * 1024 * 1024) await rename(file, `${file}.1`);
        await appendFile(file, JSON.stringify(record) + '\n', { mode: 0o600 });
      }).catch(error => logger.error(`chatgpt-codex journal write failed: ${error.code ?? 'IO_ERROR'}`));
    },
    async flush() { await queue; }
  };
}
