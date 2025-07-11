#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

// Colors for terminal output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
};

function colorize(text, color) {
  return `${colors[color]}${text}${colors.reset}`;
}

function printUsage() {
  console.log(colorize('📝 Midas Log Viewer', 'bright'));
  console.log('');
  console.log('Usage:');
  console.log('  node scripts/view-logs.js [command] [options]');
  console.log('');
  console.log('Commands:');
  console.log('  list                    - List all log files');
  console.log(
    '  latest [lines]          - Show latest log file (default: 50 lines)',
  );
  console.log(
    '  file <filename> [lines] - Show specific log file (default: 50 lines)',
  );
  console.log('  search <term>           - Search all logs for term');
  console.log(
    '  cleanup [days]          - Clean up old log files (default: 7 days)',
  );
  console.log('');
  console.log('Examples:');
  console.log('  node scripts/view-logs.js latest 100');
  console.log('  node scripts/view-logs.js file app-2024-01-15.log 200');
  console.log('  node scripts/view-logs.js search "rebalance"');
  console.log('  node scripts/view-logs.js cleanup 3');
}

function getLogsDir() {
  return path.join(process.cwd(), 'logs');
}

function getLogFiles() {
  const logsDir = getLogsDir();
  if (!fs.existsSync(logsDir)) {
    return [];
  }

  return fs
    .readdirSync(logsDir)
    .filter((file) => file.endsWith('.log'))
    .sort()
    .reverse();
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function getFileInfo(filename) {
  const filePath = path.join(getLogsDir(), filename);
  if (!fs.existsSync(filePath)) {
    return null;
  }

  const stats = fs.statSync(filePath);
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n').filter((line) => line.trim() !== '').length;

  return {
    size: formatBytes(stats.size),
    modified: stats.mtime.toISOString(),
    lines,
  };
}

function listLogs() {
  console.log(colorize('📋 Available Log Files:', 'bright'));
  console.log('');

  const logFiles = getLogFiles();
  if (logFiles.length === 0) {
    console.log(colorize('No log files found', 'yellow'));
    return;
  }

  logFiles.forEach((filename, index) => {
    const info = getFileInfo(filename);
    if (info) {
      console.log(
        `${colorize(`${index + 1}.`, 'cyan')} ${colorize(filename, 'bright')}`,
      );
      console.log(
        `   Size: ${info.size} | Lines: ${info.lines} | Modified: ${info.modified}`,
      );
      console.log('');
    }
  });
}

function showLogFile(filename, lines = 50) {
  const filePath = path.join(getLogsDir(), filename);

  if (!fs.existsSync(filePath)) {
    console.log(colorize(`❌ Log file not found: ${filename}`, 'red'));
    return;
  }

  console.log(
    colorize(`📄 Showing last ${lines} lines from ${filename}:`, 'bright'),
  );
  console.log(colorize('─'.repeat(80), 'blue'));
  console.log('');

  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const allLines = content.split('\n').filter((line) => line.trim() !== '');
    const lastLines = allLines.slice(-lines);

    lastLines.forEach((line) => {
      // Color code different log levels
      if (line.includes('[ERROR]')) {
        console.log(colorize(line, 'red'));
      } else if (line.includes('[WARN]')) {
        console.log(colorize(line, 'yellow'));
      } else if (line.includes('[INFO]')) {
        console.log(colorize(line, 'green'));
      } else if (line.includes('[DEBUG]')) {
        console.log(colorize(line, 'cyan'));
      } else {
        console.log(line);
      }
    });

    console.log('');
    console.log(colorize(`Total lines in file: ${allLines.length}`, 'blue'));
  } catch (error) {
    console.log(colorize(`❌ Error reading log file: ${error.message}`, 'red'));
  }
}

function searchLogs(term) {
  console.log(
    colorize(`🔍 Searching for "${term}" in all log files:`, 'bright'),
  );
  console.log('');

  const logFiles = getLogFiles();
  let totalResults = 0;

  logFiles.forEach((filename) => {
    const filePath = path.join(getLogsDir(), filename);

    if (!fs.existsSync(filePath)) {
      return;
    }

    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const lines = content.split('\n');
      const matches = [];

      lines.forEach((line, index) => {
        if (line.toLowerCase().includes(term.toLowerCase())) {
          matches.push({ line: line.trim(), lineNumber: index + 1 });
        }
      });

      if (matches.length > 0) {
        console.log(
          colorize(`📁 ${filename} (${matches.length} matches):`, 'cyan'),
        );
        matches.forEach((match) => {
          console.log(`   Line ${match.lineNumber}: ${match.line}`);
        });
        console.log('');
        totalResults += matches.length;
      }
    } catch (error) {
      console.log(
        colorize(`❌ Error reading ${filename}: ${error.message}`, 'red'),
      );
    }
  });

  if (totalResults === 0) {
    console.log(colorize('No matches found', 'yellow'));
  } else {
    console.log(colorize(`Total matches found: ${totalResults}`, 'green'));
  }
}

function cleanupLogs(days = 7) {
  console.log(
    colorize(`🧹 Cleaning up log files older than ${days} days:`, 'bright'),
  );
  console.log('');

  const logFiles = getLogFiles();
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - days);

  let deleted = 0;
  let kept = 0;

  logFiles.forEach((filename) => {
    const filePath = path.join(getLogsDir(), filename);

    try {
      const stats = fs.statSync(filePath);
      if (stats.mtime < cutoffDate) {
        fs.unlinkSync(filePath);
        console.log(colorize(`🗑️  Deleted: ${filename}`, 'red'));
        deleted++;
      } else {
        console.log(colorize(`✅ Kept: ${filename}`, 'green'));
        kept++;
      }
    } catch (error) {
      console.log(
        colorize(`❌ Error processing ${filename}: ${error.message}`, 'red'),
      );
    }
  });

  console.log('');
  console.log(
    colorize(`Cleanup complete: ${deleted} deleted, ${kept} kept`, 'bright'),
  );
}

// Main execution
const args = process.argv.slice(2);
const command = args[0];

if (
  !command ||
  command === 'help' ||
  command === '--help' ||
  command === '-h'
) {
  printUsage();
  process.exit(0);
}

try {
  switch (command) {
    case 'list': {
      listLogs();
      break;
    }

    case 'latest': {
      const lines = parseInt(args[1], 10) || 50;
      const logFiles = getLogFiles();
      if (logFiles.length > 0) {
        showLogFile(logFiles[0], lines);
      } else {
        console.log(colorize('No log files found', 'yellow'));
      }
      break;
    }

    case 'file': {
      if (!args[1]) {
        console.log(colorize('❌ Please specify a filename', 'red'));
        process.exit(1);
      }
      const fileLines = parseInt(args[2], 10) || 50;
      showLogFile(args[1], fileLines);
      break;
    }

    case 'search': {
      if (!args[1]) {
        console.log(colorize('❌ Please specify a search term', 'red'));
        process.exit(1);
      }
      searchLogs(args[1]);
      break;
    }

    case 'cleanup': {
      const days = parseInt(args[1], 10) || 7;
      cleanupLogs(days);
      break;
    }

    default: {
      console.log(colorize(`❌ Unknown command: ${command}`, 'red'));
      console.log('');
      printUsage();
      process.exit(1);
    }
  }
} catch (error) {
  console.log(colorize(`❌ Error: ${error.message}`, 'red'));
  process.exit(1);
}
