import * as fs from 'fs';
import * as path from 'path';

class LoggingService {
    private logDir: string;
    private logStream: fs.WriteStream | null = null;
    private currentDate: string = '';

    constructor(logDir: string = path.resolve(process.cwd(), 'logs')) {
        this.logDir = logDir;
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

    private formatMessage(level: string, message: string): string {
        const timestamp = new Date().toISOString();
        return `[${timestamp}] [${level}] ${message}`;
    }


    log(message: string) {
        this.updateLogStream();
        const formatted = this.formatMessage('LOG', message);
        this.logStream!.write(formatted + '\n');
        console.log(message);
    }

    info(message: string) {
        this.updateLogStream();
        const formatted = this.formatMessage('INFO', message);
        this.logStream!.write(formatted + '\n');
        console.info(message);
    }

    error(message: string) {
        this.updateLogStream();
        const formatted = this.formatMessage('ERROR', message);
        this.logStream!.write(formatted + '\n');
        console.error(message);
    }

    debug(message: string) {
        this.updateLogStream();
        const formatted = this.formatMessage('DEBUG', message);
        this.logStream!.write(formatted + '\n');
        console.debug(message);
    }

    close() {
        if (this.logStream) {
            this.logStream.end();
            this.logStream = null;
        }
    }
}

export { LoggingService };