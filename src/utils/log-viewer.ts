import * as fs from 'fs';
import * as path from 'path';

export class LogViewer {
  private logsDir: string;

  constructor() {
    this.logsDir = path.join(process.cwd(), 'logs');
  }

  /**
   * Get all available log files
   */
  public getLogFiles(): string[] {
    if (!fs.existsSync(this.logsDir)) {
      return [];
    }

    return fs
      .readdirSync(this.logsDir)
      .filter((file) => file.endsWith('.log'))
      .sort()
      .reverse(); // Most recent first
  }

  /**
   * Read the latest log file
   */
  public readLatestLog(lines: number = 100): string[] {
    const logFiles = this.getLogFiles();
    if (logFiles.length === 0) {
      return ['No log files found'];
    }

    const latestLogFile = path.join(this.logsDir, logFiles[0]);
    return this.readLogFile(latestLogFile, lines);
  }

  /**
   * Read a specific log file
   */
  public readLogFile(filename: string, lines: number = 100): string[] {
    const filePath = path.join(this.logsDir, filename);

    if (!fs.existsSync(filePath)) {
      return [`Log file not found: ${filename}`];
    }

    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const allLines = content.split('\n').filter((line) => line.trim() !== '');

      // Return last N lines
      return allLines.slice(-lines);
    } catch (error) {
      return [`Error reading log file: ${error.message}`];
    }
  }

  /**
   * Search logs for specific terms
   */
  public searchLogs(searchTerm: string, filename?: string): string[] {
    const logFiles = filename ? [filename] : this.getLogFiles();
    const results: string[] = [];

    for (const logFile of logFiles) {
      const filePath = path.join(this.logsDir, logFile);

      if (!fs.existsSync(filePath)) {
        continue;
      }

      try {
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split('\n');

        lines.forEach((line, index) => {
          if (line.toLowerCase().includes(searchTerm.toLowerCase())) {
            results.push(`[${logFile}:${index + 1}] ${line}`);
          }
        });
      } catch (error) {
        results.push(`Error reading ${logFile}: ${error.message}`);
      }
    }

    return results;
  }

  /**
   * Get log file size and last modified date
   */
  public getLogFileInfo(
    filename: string,
  ): { size: string; modified: string; lines: number } | null {
    const filePath = path.join(this.logsDir, filename);

    if (!fs.existsSync(filePath)) {
      return null;
    }

    try {
      const stats = fs.statSync(filePath);
      const content = fs.readFileSync(filePath, 'utf8');
      const lines = content
        .split('\n')
        .filter((line) => line.trim() !== '').length;

      return {
        size: this.formatBytes(stats.size),
        modified: stats.mtime.toISOString(),
        lines,
      };
    } catch {
      return null;
    }
  }

  /**
   * Clear old log files (keep last N days)
   */
  public clearOldLogs(daysToKeep: number = 7): {
    deleted: number;
    kept: number;
  } {
    const logFiles = this.getLogFiles();
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);

    let deleted = 0;
    let kept = 0;

    for (const logFile of logFiles) {
      const filePath = path.join(this.logsDir, logFile);

      try {
        const stats = fs.statSync(filePath);
        if (stats.mtime < cutoffDate) {
          fs.unlinkSync(filePath);
          deleted++;
        } else {
          kept++;
        }
      } catch {
        // Skip files that can't be processed
      }
    }

    return { deleted, kept };
  }

  private formatBytes(bytes: number): string {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }
}

// Export singleton instance
export const logViewer = new LogViewer();
