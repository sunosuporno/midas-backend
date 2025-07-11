import * as fs from 'fs';
import * as path from 'path';

export class Logger {
  private static instance: Logger;
  private logFile: string;
  private isProduction: boolean;
  private logStream: fs.WriteStream | null = null;
  private originalConsoleLog: typeof console.log;
  private originalConsoleError: typeof console.error;
  private originalConsoleWarn: typeof console.warn;
  private originalConsoleInfo: typeof console.info;
  private originalConsoleDebug: typeof console.debug;

  private constructor() {
    this.isProduction = process.env.NODE_ENV === 'production';
    this.logFile = path.join(
      process.cwd(),
      'logs',
      `app-${new Date().toISOString().split('T')[0]}.log`,
    );

    // Create logs directory if it doesn't exist
    const logsDir = path.dirname(this.logFile);
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }

    // Store original console methods
    this.originalConsoleLog = console.log;
    this.originalConsoleError = console.error;
    this.originalConsoleWarn = console.warn;
    this.originalConsoleInfo = console.info;
    this.originalConsoleDebug = console.debug;

    this.setupLogging();
  }

  public static getInstance(): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger();
    }
    return Logger.instance;
  }

  private setupLogging(): void {
    if (this.isProduction) {
      console.log('🚫 File logging disabled in production mode');
      return;
    }

    // Create write stream for the log file
    this.logStream = fs.createWriteStream(this.logFile, { flags: 'a' });

    // Override console methods
    console.log = (...args: any[]) => {
      this.writeToFile('LOG', ...args);
      this.originalConsoleLog(...args);
    };

    console.error = (...args: any[]) => {
      this.writeToFile('ERROR', ...args);
      this.originalConsoleError(...args);
    };

    console.warn = (...args: any[]) => {
      this.writeToFile('WARN', ...args);
      this.originalConsoleWarn(...args);
    };

    console.info = (...args: any[]) => {
      this.writeToFile('INFO', ...args);
      this.originalConsoleInfo(...args);
    };

    console.debug = (...args: any[]) => {
      this.writeToFile('DEBUG', ...args);
      this.originalConsoleDebug(...args);
    };

    // Log startup message
    this.originalConsoleLog(
      `📝 File logging enabled. Logs will be written to: ${this.logFile}`,
    );
  }

  private writeToFile(level: string, ...args: any[]): void {
    if (this.isProduction || !this.logStream) {
      return;
    }

    const timestamp = new Date().toISOString();
    const bigIntReplacer = (_key: string, value: any) =>
      typeof value === 'bigint' ? value.toString() : value;
    const message = args
      .map((arg) =>
        typeof arg === 'object'
          ? JSON.stringify(arg, bigIntReplacer, 2)
          : String(arg),
      )
      .join(' ');

    const logEntry = `[${timestamp}] [${level}] ${message}\n`;

    try {
      this.logStream.write(logEntry);
    } catch (error) {
      // If file writing fails, don't break the application
      this.originalConsoleError('Failed to write to log file:', error);
    }
  }

  public getLogFilePath(): string {
    return this.logFile;
  }

  public isFileLoggingEnabled(): boolean {
    return !this.isProduction && this.logStream !== null;
  }

  public rotateLogFile(): void {
    if (this.isProduction || !this.logStream) {
      return;
    }

    // Close current stream
    if (this.logStream) {
      this.logStream.end();
      this.logStream = null;
    }

    // Update log file path with new date
    this.logFile = path.join(
      process.cwd(),
      'logs',
      `app-${new Date().toISOString().split('T')[0]}.log`,
    );

    // Create new stream
    this.logStream = fs.createWriteStream(this.logFile, { flags: 'a' });

    this.originalConsoleLog(`📝 Log file rotated to: ${this.logFile}`);
  }

  public cleanup(): void {
    if (this.logStream) {
      this.logStream.end();
      this.logStream = null;
    }

    // Restore original console methods
    console.log = this.originalConsoleLog;
    console.error = this.originalConsoleError;
    console.warn = this.originalConsoleWarn;
    console.info = this.originalConsoleInfo;
    console.debug = this.originalConsoleDebug;
  }
}

// Initialize logger immediately
export const logger = Logger.getInstance();

// Graceful shutdown handling
process.on('SIGINT', () => {
  logger.cleanup();
  process.exit(0);
});

process.on('SIGTERM', () => {
  logger.cleanup();
  process.exit(0);
});

// Rotate log file daily at midnight
setInterval(() => {
  const now = new Date();
  if (now.getHours() === 0 && now.getMinutes() === 0) {
    logger.rotateLogFile();
  }
}, 60000); // Check every minute
