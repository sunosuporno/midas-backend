# Midas Logging System

This document explains how to use the logging system in the Midas backend application.

## Overview

The logging system automatically captures all console output and writes it to daily log files while maintaining terminal output. This is especially useful for debugging rebalancing issues and other system events that occur when you're not actively monitoring the terminal.

## Features

- ✅ **Automatic file logging** - All console.log, console.error, console.warn, etc. are captured
- ✅ **Daily log rotation** - New log file created each day
- ✅ **Production safety** - File logging is automatically disabled in production
- ✅ **Terminal output preserved** - You still see all logs in your terminal
- ✅ **Search and filter** - Built-in tools to search through logs
- ✅ **Automatic cleanup** - Old log files can be automatically cleaned up

## How It Works

### Development Mode

- Logs are written to `logs/app-YYYY-MM-DD.log` files
- Each day gets a new log file
- All console output is preserved in terminal
- Log entries include timestamps and log levels

### Production Mode

- File logging is automatically disabled
- Only terminal output is maintained
- No performance impact on production

## Usage

### Command Line Tools

#### View Latest Logs

```bash
# View last 50 lines of latest log file
npm run logs:latest

# View last 100 lines
npm run logs:latest 100
```

#### List All Log Files

```bash
npm run logs list
```

#### View Specific Log File

```bash
# View specific log file (last 50 lines)
npm run logs file app-2024-01-15.log

# View specific log file (last 200 lines)
npm run logs file app-2024-01-15.log 200
```

#### Search Logs

```bash
# Search all logs for "rebalance"
npm run logs search "rebalance"

# Search specific log file for "error"
npm run logs search "error" app-2024-01-15.log
```

#### Clean Up Old Logs

```bash
# Clean up logs older than 7 days (default)
npm run logs:cleanup

# Clean up logs older than 3 days
npm run logs:cleanup 3
```

### API Endpoints (Development Only)

When running in development mode, you can also access logs via API:

- `GET /logs` - List all log files with metadata
- `GET /logs/latest?lines=100` - Get latest log file
- `GET /logs/app-2024-01-15.log?lines=200` - Get specific log file
- `GET /logs/search/rebalance` - Search all logs
- `GET /logs/cleanup?days=7` - Clean up old logs

## Log File Format

Each log entry includes:

- Timestamp in ISO format
- Log level (LOG, ERROR, WARN, INFO, DEBUG)
- The actual log message

Example:

```
[2024-01-15T10:30:45.123Z] [LOG] === STARTING REBALANCING CRON ===
[2024-01-15T10:30:45.124Z] [LOG] Analyzing pool: weth-usdc
[2024-01-15T10:30:45.125Z] [ERROR] Failed to get token price: Network error
```

## Configuration

### Environment Variables

- `NODE_ENV=production` - Automatically disables file logging
- `NODE_ENV=development` - Enables file logging (default)

### Log File Location

Logs are stored in the `logs/` directory in your project root:

```
midas-backend/
├── logs/
│   ├── app-2024-01-15.log
│   ├── app-2024-01-16.log
│   └── app-2024-01-17.log
```

## Troubleshooting

### Log Files Not Created

- Check that `NODE_ENV` is not set to `production`
- Ensure the `logs/` directory exists and is writable
- Check disk space

### Can't Find Recent Logs

- Log files are created daily, check the current date
- Use `npm run logs list` to see all available files
- Use `npm run logs:latest` to see the most recent logs

### Large Log Files

- Use `npm run logs:cleanup` to remove old files
- Consider reducing log verbosity in your code
- Monitor disk space usage

## Best Practices

1. **Search for specific terms** when debugging:

   ```bash
   npm run logs search "rebalance"
   npm run logs search "error"
   npm run logs search "position"
   ```

2. **Check recent activity** after being away:

   ```bash
   npm run logs:latest 200
   ```

3. **Clean up regularly** to prevent disk space issues:

   ```bash
   npm run logs:cleanup 7
   ```

4. **Use log levels appropriately** in your code:
   ```typescript
   console.log('General information');
   console.error('Error conditions');
   console.warn('Warning conditions');
   console.info('Informational messages');
   console.debug('Debug information');
   ```

## Integration with Existing Code

The logging system works automatically with all existing `console.log` statements in your codebase. No changes are needed to existing code - all console output will be automatically captured and written to log files.

For example, your existing rebalancing logs in `aerodrome.service.ts` will automatically be captured:

```typescript
console.log('=== STARTING REBALANCING CRON ===');
console.log(`Analyzing pool: ${currentPool}`);
console.error('Error rebalancing position:', error);
```

These will appear in both your terminal and the log files with proper timestamps and formatting.
