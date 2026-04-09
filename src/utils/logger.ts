// src/utils/logger.ts
import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import path from 'path';

// ─── Error Serialiser ───────────────────────────────────────────────────────
// Winston's default JSON transport can't serialise Error objects properly.
// This format ensures stack traces always appear in log files.
const errorSerializer = winston.format((info) => {
    if (info instanceof Error) {
        return Object.assign({}, info, {
            level: info.level,
            message: info.message,
            stack: info.stack,
        });
    }

    // Handle errors passed as a second argument: logger.error('msg', err)
    if (info.error instanceof Error) {
        info.errorMessage = info.error.message;
        info.stack = info.error.stack;
        delete info.error;
    }

    // Also handle bare Error objects stored under the splat
    const splat = (info as any)[Symbol.for('splat')];
    if (splat && splat.length > 0 && splat[0] instanceof Error) {
        info.errorMessage = splat[0].message;
        info.stack = splat[0].stack;
    }

    return info;
});

// ─── Log Directory ──────────────────────────────────────────────────────────
const LOG_DIR = path.resolve(process.cwd(), 'logs');
const IS_PRODUCTION = process.env.NODE_ENV?.toLowerCase() === 'production';

// ─── Formats ────────────────────────────────────────────────────────────────
const sharedFormats = winston.format.combine(
    errorSerializer(),
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
    winston.format.errors({ stack: true }),
);

// Development: colourised, human-readable
const consoleFormat = winston.format.combine(
    sharedFormats,
    winston.format.colorize({ all: true }),
    winston.format.printf(({ timestamp, level, message, module: mod, stack, errorMessage, ...meta }) => {
        const moduleTag = mod ? ` [${mod}]` : '';
        const metaStr = Object.keys(meta).length > 0 ? `\n  ${JSON.stringify(meta, null, 2)}` : '';
        const errStr = errorMessage ? `\n  ↳ ${errorMessage}` : '';
        const stackStr = stack ? `\n${stack}` : '';
        return `${timestamp} ${level}${moduleTag}: ${message}${errStr}${metaStr}${stackStr}`;
    }),
);

// Production / file: compact JSON
const fileFormat = winston.format.combine(
    sharedFormats,
    winston.format.json(),
);

// ─── Transports ─────────────────────────────────────────────────────────────
const transports: winston.transport[] = [
    // Console — always on, format depends on env
    new winston.transports.Console({
        format: IS_PRODUCTION ? fileFormat : consoleFormat,
        handleExceptions: true,
        handleRejections: true,
    }),

    // Combined log (all levels) — rotates daily, keeps 14 days
    new DailyRotateFile({
        dirname: LOG_DIR,
        filename: 'combined-%DATE%.log',
        datePattern: 'YYYY-MM-DD',
        zippedArchive: true,
        maxFiles: '14d',
        maxSize: '20m',
        format: fileFormat,
        handleExceptions: true,
        handleRejections: true,
    }),

    // Error-only log — long retention for post-mortems
    new DailyRotateFile({
        dirname: LOG_DIR,
        filename: 'error-%DATE%.log',
        datePattern: 'YYYY-MM-DD',
        level: 'error',
        zippedArchive: true,
        maxFiles: '30d',
        maxSize: '20m',
        format: fileFormat,
    }),
];

// ─── Root Logger ─────────────────────────────────────────────────────────────
const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || (IS_PRODUCTION ? 'info' : 'debug'),
    defaultMeta: { service: 'whatsapp-automation' },
    transports,
    exitOnError: false,
});

// ─── Child Logger Factory ───────────────────────────────────────────────────
/**
 * Creates a child logger tagged with a module name.
 * Use this in every module for structured, filterable logs:
 *
 *   const log = createChildLogger('browser');
 *   log.info('Browser started');
 *   // → { "module": "browser", "message": "Browser started", ... }
 */
export const createChildLogger = (moduleName: string): winston.Logger =>
    logger.child({ module: moduleName });

// ─── Graceful Drain Helper ───────────────────────────────────────────────────
/**
 * Call this before process.exit() to ensure all buffered log entries are
 * flushed to disk. Winston's file transports are asynchronous; without this
 * the last few lines of a shutdown sequence can be silently dropped.
 */
export const drainLogger = (): Promise<void> =>
    new Promise((resolve) => {
        let pending = transports.length;
        const done = () => { if (--pending === 0) resolve(); };
        transports.forEach((t) => {
            if (typeof (t as any).close === 'function') {
                (t as any).on('finish', done);
                (t as any).close();
            } else {
                done();
            }
        });
        // Safety timeout — never block shutdown for more than 3s
        setTimeout(resolve, 3000);
    });

export default logger;
