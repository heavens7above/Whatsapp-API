// src/utils/httpLogger.ts
// Morgan → Winston bridge for structured HTTP access logs.
import morgan from 'morgan';
import { createChildLogger } from './logger';

const httpLog = createChildLogger('http');

// Define a concise token format.
// In production JSON format the child-logger already wraps with timestamp etc.,
// so we only need the fields meaningful at the HTTP layer.
const FORMAT = ':method :url :status :res[content-length] b - :response-time ms [:remote-addr]';

/**
 * Express middleware that logs every inbound HTTP request via Winston.
 * - 4xx/5xx → logged at `warn` / `error` level
 * - 2xx/3xx  → logged at `http` level (visible in dev, filtered in production unless LOG_LEVEL=http)
 */
const httpLogger = morgan(FORMAT, {
    stream: {
        write: (message: string) => {
            const trimmed = message.trim();

            // Extract status code to route to the right level
            const parts = trimmed.split(' ');
            const statusCode = parseInt(parts[2], 10);

            if (statusCode >= 500) {
                httpLog.error(trimmed);
            } else if (statusCode >= 400) {
                httpLog.warn(trimmed);
            } else {
                httpLog.http(trimmed);
            }
        },
    },
    // Skip health-check spam — these provide no diagnostic value
    skip: (req) => req.url === '/health',
});

export default httpLogger;
