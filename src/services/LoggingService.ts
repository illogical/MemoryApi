import * as fs from 'fs';
import * as path from 'path';

type LogLevel = 'error' | 'info' | 'log' | 'debug';

const LOG_LEVELS: LogLevel[] = ['error', 'info', 'log', 'debug'];

class LoggingService {
    private logDir: string;
    private logStream: fs.WriteStream | null = null;
    private currentDate: string = '';
    private fileLogLevel: LogLevel;
    private consoleLogLevel: LogLevel;

    constructor(logDir: string = path.resolve(process.cwd(), 'logs'), fileLogLevel: LogLevel = 'debug', consoleLogLevel: LogLevel = 'info') {
        this.logDir = logDir;
        this.fileLogLevel = fileLogLevel;
        this.consoleLogLevel = consoleLogLevel;
        if (!fs.existsSync(this.logDir)) {
            fs.mkdirSync(this.logDir, { recursive: true });
        }
        this.updateLogStream();
    }

    private getLogFileName(): string {
        const date = new Date();
        const dateStr = date.toISOString().slice(0, 10); // YYYY-MM-DD
        return path.join(this.logDir, `memoryrag_${dateStr}.log`);
    }

    private updateLogStream() {
        const dateStr = new Date().toISOString().slice(0, 10);
        if (this.currentDate !== dateStr || !this.logStream) {
            this.currentDate = dateStr;
            if (this.logStream) {
                this.logStream.end();
            }
            this.logStream = fs.createWriteStream(this.getLogFileName(), { flags: 'a' });
        }
    }


    private formatMessage(level: LogLevel, message: string): string {
        const timestamp = new Date().toISOString();
        return `[${timestamp}] [${level.toUpperCase()}] ${message}`;
    }

    private shouldLog(level: LogLevel, target: 'file' | 'console'): boolean {
        const levels = LOG_LEVELS;
        const idx = levels.indexOf(level);
        if (target === 'file') {
            return idx <= levels.indexOf(this.fileLogLevel);
        } else {
            return idx <= levels.indexOf(this.consoleLogLevel);
        }
    }



    log(message: string) {
        this.updateLogStream();
        const formatted = this.formatMessage('log', message);
        if (this.shouldLog('log', 'file')) {
            this.logStream!.write(formatted + '\n');
        }
        if (this.shouldLog('log', 'console')) {
            console.log(formatted);
        }
    }

    info(message: string) {
        this.updateLogStream();
        const formatted = this.formatMessage('info', message);
        if (this.shouldLog('info', 'file')) {
            this.logStream!.write(formatted + '\n');
        }
        if (this.shouldLog('info', 'console')) {
            console.info(formatted);
        }
    }

    error(message: string) {
        this.updateLogStream();
        const formatted = this.formatMessage('error', message);
        if (this.shouldLog('error', 'file')) {
            this.logStream!.write(formatted + '\n');
        }
        if (this.shouldLog('error', 'console')) {
            console.error(formatted);
        }
    }

    debug(message: string) {
        this.updateLogStream();
        const formatted = this.formatMessage('debug', message);
        if (this.shouldLog('debug', 'file')) {
            this.logStream!.write(formatted + '\n');
        }
        if (this.shouldLog('debug', 'console')) {
            console.debug(formatted);
        }
    }

    close() {
        if (this.logStream) {
            this.logStream.end();
            this.logStream = null;
        }
    }
}

export { LoggingService };