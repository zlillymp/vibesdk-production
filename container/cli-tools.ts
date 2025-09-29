#!/usr/bin/env bun
import { parseArgs } from 'util';
import { StorageManager } from './storage.js';
import { ProcessMonitor } from './process-monitor.js';
import { 
  ProcessRunnerConfig, 
  ProcessInfo, 
  MonitoringOptions,
  LogStoreOptions as LogStoreOptionsType,
  ErrorStoreOptions as ErrorStoreOptionsType,
  LogFilter,
  LogCursor,
  LogLevel,
  StoredError,
  StoredLog,
  Result,
  DEFAULT_MONITORING_OPTIONS,
  DEFAULT_STORAGE_OPTIONS,
  DEFAULT_LOG_STORE_OPTIONS,
  ErrorSeverity,
  ErrorCategory,
  getDataDirectory,
  getErrorDbPath,
  getLogDbPath
} from './types.js';

/**
 * Safe JSON operations with circular reference protection
 */
class SafeJSON {
  /**
   * Safely stringify data with circular reference protection
   */
  static stringify(data: unknown, space?: number): string {
    try {
      const seen = new WeakSet();
      const json = JSON.stringify(data, (_key, value) => {
        if (typeof value === 'object' && value !== null) {
          if (seen.has(value)) {
            return '[Circular Reference]';
          }
          seen.add(value);
        }
        return value;
      }, space);
      return json;
    } catch (error) {
      // Fallback for any stringify errors
      return JSON.stringify({
        error: 'Failed to serialize data',
        type: typeof data,
        string: String(data).substring(0, 200)
      }, null, space);
    }
  }

  /**
   * Safely parse JSON with fallback
   */
  static parse(text: string): unknown {
    try {
      return JSON.parse(text);
    } catch (error) {
      // Return error object for failed parsing
      return {
        success: false,
        error: 'Invalid JSON format',
        rawText: text.substring(0, 200)
      };
    }
  }
}

/**
 * Safe resource cleanup utilities
 */
class SafeCleanup {
  /**
   * Safely close storage with timeout
   */
  static async closeStorage(storage: StorageManager | null, timeoutMs: number = 2000): Promise<void> {
    if (!storage) return;
    
    try {
      const timeout = setTimeout(() => {
        console.warn('Storage close timeout, forcing cleanup');
      }, timeoutMs);
      
      storage.close();
      clearTimeout(timeout);
    } catch (error) {
      console.warn('Storage close error:', error);
      // Don't throw - we're in cleanup
    }
  }
}

/**
 * Shared output formatting utilities
 */
class OutputFormatter {
  /**
   * Format output based on specified format type
   */
  static formatOutput(data: unknown, format: 'json' | 'table' | 'raw' = 'json'): void {
    switch (format) {
      case 'json':
        console.log(SafeJSON.stringify(data, 2));
        break;
      case 'raw':
        if (typeof data === 'string') {
          console.log(data);
        } else {
          console.log(String(data));
        }
        break;
      case 'table':
        // Table formatting is handled by specific formatters
        console.log(SafeJSON.stringify(data, 2));
        break;
    }
  }

  /**
   * Format error response consistently
   */
  static formatError(error: string, additionalData?: Record<string, unknown>): void {
    const errorResponse = {
      success: false,
      error,
      ...additionalData
    };
    console.log(SafeJSON.stringify(errorResponse, 2));
  }

  /**
   * Format success response consistently
   */
  static formatSuccess(message: string, data?: unknown): void {
    const successResponse: Record<string, unknown> = {
      success: true,
      message
    };
    if (data) {
      successResponse.data = data;
    }
    console.log(SafeJSON.stringify(successResponse, 2));
  }

  /**
   * Print errors in table format
   */
  static printErrorsTable(errors: readonly StoredError[]): void {
    if (errors.length === 0) {
      console.log('No errors found.');
      return;
    }

    console.log('Timestamp'.padEnd(20) + 'Severity'.padEnd(10) + 'Category'.padEnd(12) + 'File'.padEnd(25) + 'Message');
    console.log('-'.repeat(100));

    for (const error of errors) {
      const timestamp = new Date(error.lastOccurrence).toISOString().slice(0, 16).replace('T', ' ');
      const severity = error.severity.padEnd(9);
      const category = error.category.padEnd(11);
      const file = (error.sourceFile || '').padEnd(24);
      const message = error.message.length > 40 ? error.message.substring(0, 37) + '...' : error.message;
      
      console.log(`${timestamp} ${severity} ${category} ${file} ${message}`);
      
      if (error.occurrenceCount > 1) {
        console.log(''.padEnd(67) + `(occurred ${error.occurrenceCount} times)`);
      }
    }
  }

  /**
   * Print logs in table format
   */
  static printLogsTable(logs: readonly StoredLog[]): void {
    if (logs.length === 0) {
      console.log('No logs found.');
      return;
    }

    console.log('Timestamp'.padEnd(20) + 'Level'.padEnd(8) + 'Stream'.padEnd(8) + 'Source'.padEnd(15) + 'Message');
    console.log('-'.repeat(100));

    for (const log of logs) {
      const timestamp = new Date(log.timestamp).toISOString().slice(0, 16).replace('T', ' ');
      const level = log.level.padEnd(7);
      const stream = log.stream.padEnd(7);
      const source = (log.source || 'unknown').padEnd(14);
      const message = log.message.length > 50 ? log.message.substring(0, 47) + '...' : log.message;
      
      console.log(`${timestamp} ${level} ${stream} ${source} ${message}`);
    }
  }
}

/**
 * Process management commands
 */
class ProcessCommands {
  private static activeRunners = new Map<string, ProcessRunner>();

  /**
   * Start process monitoring
   */
  static async start(options: {
    instanceId: string;
    command: string;
    args: string[];
    cwd?: string;
    port?: string;
    maxRestarts?: number;
    restartDelay?: number;
    maxErrors?: number;
    retentionDays?: number;
    logRetentionHours?: number;
  }): Promise<void> {
    try {
      // Check if already running
      if (this.activeRunners.has(options.instanceId)) {
        OutputFormatter.formatError(`Process ${options.instanceId} is already running`);
        process.exit(1);
      }

      // Set PORT environment variable if provided
      if (options.port) {
        process.env.PORT = options.port;
      }

      // Build configuration
      const monitoring: MonitoringOptions = {
        ...DEFAULT_MONITORING_OPTIONS,
        maxRestarts: options.maxRestarts ?? DEFAULT_MONITORING_OPTIONS.maxRestarts,
        restartDelay: options.restartDelay ?? DEFAULT_MONITORING_OPTIONS.restartDelay
      };

      const errorStorage: ErrorStoreOptionsType = {
        ...DEFAULT_STORAGE_OPTIONS,
        maxErrors: options.maxErrors ?? DEFAULT_STORAGE_OPTIONS.maxErrors,
        retentionDays: options.retentionDays ?? DEFAULT_STORAGE_OPTIONS.retentionDays
      };

      const logStorage: LogStoreOptionsType = {
        ...DEFAULT_LOG_STORE_OPTIONS,
        retentionHours: options.logRetentionHours ?? DEFAULT_LOG_STORE_OPTIONS.retentionHours
      };

      const config: ProcessRunnerConfig = {
        instanceId: options.instanceId,
        command: options.command,
        args: options.args,
        cwd: options.cwd || process.cwd(),
        env: process.env as Record<string, string>,
        monitoring,
        storage: errorStorage
      };

      console.log('Starting Process Monitor:');
      console.log(`  Instance ID: ${options.instanceId}`);
      console.log(`  Command: ${options.command} ${options.args.join(' ')}`);
      console.log(`  Working Directory: ${config.cwd}`);
      console.log(`  Max Restarts: ${monitoring.maxRestarts}`);
      console.log(`  Restart Delay: ${monitoring.restartDelay}ms`);

      // Create and start ProcessRunner
      const runner = new ProcessRunner(config, { error: errorStorage, log: logStorage });
      const startResult = await runner.start();

      if (!startResult.success) {
        OutputFormatter.formatError(`Failed to start process: ${startResult.error.message}`);
        process.exit(1);
      }

      // Store active runner
      this.activeRunners.set(options.instanceId, runner);

      if (startResult.success) {
        console.log(`Process monitoring started successfully. PID: ${startResult.data.pid}`);
        console.log('Process is active. Press Ctrl+C to stop.');
      }

      // Setup periodic status reporting
      const statusInterval = setInterval(() => {
        const processInfo = runner.getProcessInfo();
        if (processInfo) {
          const uptime = Math.floor((Date.now() - processInfo.startTime.getTime()) / 1000);
          console.log(`[STATUS] Process ${processInfo.id} running for ${uptime}s (restarts: ${processInfo.restartCount})`);
        }
      }, 60000); // Every minute

      // Setup graceful shutdown with race condition protection
      let isShuttingDown = false;
      const gracefulShutdown = async (signal: string) => {
        if (isShuttingDown) {
          console.log(`\nAlready shutting down, ignoring ${signal}`);
          return;
        }
        isShuttingDown = true;
        
        console.log(`\nReceived ${signal}. Initiating graceful shutdown...`);
        clearInterval(statusInterval);
        
        try {
          await runner.stop();
          this.activeRunners.delete(options.instanceId);
          console.log('Graceful shutdown completed');
        } catch (shutdownError) {
          console.error('Error during shutdown:', shutdownError);
        }
        
        process.exit(0);
      };

      process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
      process.on('SIGINT', () => gracefulShutdown('SIGINT'));
      process.on('SIGHUP', () => gracefulShutdown('SIGHUP'));

      // Keep alive (process will exit via signal handlers)
      await new Promise(() => {}); // Never resolves

    } catch (error) {
      OutputFormatter.formatError(`Process start failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      process.exit(1);
    }
  }

  /**
   * Stop process monitoring
   */
  static async stop(options: { instanceId: string; force?: boolean }): Promise<void> {
    try {
      const runner = this.activeRunners.get(options.instanceId);
      if (!runner) {
        OutputFormatter.formatError(`Process ${options.instanceId} is not running`);
        process.exit(1);
      }

      if (runner) {
        const stopResult = await runner.stop(options.force);
        if (!stopResult.success) {
          OutputFormatter.formatError(`Failed to stop process: ${stopResult.error.message}`);
          process.exit(1);
        }

        this.activeRunners.delete(options.instanceId);
        OutputFormatter.formatSuccess(`Process ${options.instanceId} stopped successfully`);
      }

    } catch (error) {
      OutputFormatter.formatError(`Process stop failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      process.exit(1);
    }
  }

  /**
   * Get process status
   */
  static async status(options: { instanceId?: string }): Promise<void> {
    try {
      if (options.instanceId) {
        const runner = this.activeRunners.get(options.instanceId);
        if (!runner) {
          OutputFormatter.formatError(`Process ${options.instanceId} is not running`);
          return;
        }

        const stats = runner.getStats();
        OutputFormatter.formatOutput({
          success: true,
          instanceId: options.instanceId,
          status: 'running',
          ...stats
        });
      } else {
        // List all active processes
        const processes = Array.from(this.activeRunners.entries()).map(([instanceId, runner]) => ({
          instanceId,
          stats: runner.getStats()
        }));

        OutputFormatter.formatOutput({
          success: true,
          activeProcesses: processes.length,
          processes
        });
      }
    } catch (error) {
      OutputFormatter.formatError(`Status check failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
}

/**
 * ProcessRunner class for managing individual processes
 */
class ProcessRunner {
  private config: ProcessRunnerConfig;
  private storage: StorageManager;
  private monitor?: ProcessMonitor;
  private isRunning = false;

  constructor(config: ProcessRunnerConfig, storageOptions: { error?: ErrorStoreOptionsType; log?: LogStoreOptionsType } = {}) {
    this.config = config;
    this.storage = new StorageManager(undefined, undefined, storageOptions);
  }

  async start(): Promise<Result<ProcessInfo>> {
    try {
      if (this.isRunning) {
        return { success: false, error: new Error('ProcessRunner is already running') };
      }

      const processInfo: ProcessInfo = {
        id: `proc-${this.config.instanceId}-${Date.now()}`,
        instanceId: this.config.instanceId,
        command: this.config.command,
        args: this.config.args,
        cwd: this.config.cwd,
        state: 'starting',
        startTime: new Date(),
        restartCount: 0
      };

      this.monitor = new ProcessMonitor(processInfo, this.storage, this.config.monitoring);
      this.setupMonitorEventHandlers();

      const startResult = await this.monitor.start();
      if (!startResult.success) {
        return startResult;
      }

      this.isRunning = true;
      return startResult;
    } catch (error) {
      return { 
        success: false, 
        error: error instanceof Error ? error : new Error('Unknown error starting ProcessRunner') 
      };
    }
  }

  async stop(force = false): Promise<Result<boolean>> {
    try {
      if (!this.isRunning || !this.monitor) {
        return { success: true, data: true };
      }

      const stopResult = await this.monitor.stop(force);
      this.isRunning = false;

      this.monitor.cleanup();
      this.monitor = undefined;
      this.storage.close();

      return stopResult;
    } catch (error) {
      return { 
        success: false, 
        error: error instanceof Error ? error : new Error('Unknown error stopping ProcessRunner') 
      };
    }
  }

  getProcessInfo(): ProcessInfo | null {
    return this.monitor?.getProcessInfo() || null;
  }

  getStats(): Record<string, unknown> {
    if (!this.monitor) {
      return { error: 'Monitor not initialized' };
    }

    return {
      ...this.monitor.getStats(),
      config: {
        instanceId: this.config.instanceId,
        command: this.config.command,
        args: this.config.args,
        cwd: this.config.cwd
      }
    };
  }

  private setupMonitorEventHandlers(): void {
    if (!this.monitor) return;

    this.monitor.on('process_started', (event) => {
      console.log(`[${event.timestamp.toISOString()}] Process started: PID ${event.pid}`);
    });

    this.monitor.on('process_stopped', (event) => {
      console.log(`[${event.timestamp.toISOString()}] Process stopped: ${event.reason}`);
    });

    this.monitor.on('error_detected', (event) => {
      const { error } = event;
      console.error(`[${event.timestamp.toISOString()}] Error detected [${error.category}/${error.severity}]: ${error.message}`);
    });

    this.monitor.on('process_crashed', (event) => {
      console.error(`[${event.timestamp.toISOString()}] Process crashed: Exit code ${event.exitCode}, Signal: ${event.signal}`);
      if (event.willRestart) {
        console.log('Process will be restarted automatically');
      }
    });
  }
}

/**
 * Error management commands
 */
class ErrorCommands {
  /**
   * List errors for an instance
   */
  static async list(options: {
    instanceId: string;
    categories?: ErrorCategory[];
    severities?: ErrorSeverity[];
    since?: string;
    until?: string;
    limit?: number;
    offset?: number;
    format?: 'json' | 'table' | 'raw';
    dbPath?: string;
  }): Promise<void> {
    let storage: StorageManager | null = null;
    
    try {
      storage = new StorageManager(options.dbPath);
      const result = storage.getErrors(options.instanceId);
      
      if (!result.success) {
        throw result.error;
      }

      let filteredErrors = result.data;

      // Apply filters
      if (options.categories) {
        filteredErrors = filteredErrors.filter(error => 
          options.categories!.includes(error.category as ErrorCategory)
        );
      }
      
      if (options.severities) {
        filteredErrors = filteredErrors.filter(error => 
          options.severities!.includes(error.severity as ErrorSeverity)
        );
      }

      if (options.since) {
        const sinceDate = new Date(options.since);
        filteredErrors = filteredErrors.filter(error => 
          new Date(error.lastOccurrence) >= sinceDate
        );
      }

      if (options.until) {
        const untilDate = new Date(options.until);
        filteredErrors = filteredErrors.filter(error => 
          new Date(error.lastOccurrence) <= untilDate
        );
      }

      // Apply pagination
      const offset = options.offset || 0;
      const limit = options.limit || 100;
      const paginatedErrors = filteredErrors.slice(offset, offset + limit);

      const response = {
        success: true,
        errors: paginatedErrors,
        summary: {
          totalErrors: filteredErrors.length,
          errorsByCategory: this.countByField(filteredErrors, 'category'),
          errorsBySeverity: this.countByField(filteredErrors, 'severity'),
          hasMore: offset + paginatedErrors.length < filteredErrors.length
        }
      };

      if (options.format === 'table') {
        OutputFormatter.printErrorsTable(paginatedErrors);
      } else {
        OutputFormatter.formatOutput(response, options.format);
      }
      
      // Explicit exit after successful execution
      process.exit(0);

    } catch (error) {
      try {
        OutputFormatter.formatError(
          error instanceof Error ? error.message : String(error),
          { instanceId: options.instanceId }
        );
      } catch (formatError) {
        // Fallback if formatting fails
        console.error(SafeJSON.stringify({ success: false, error: String(error) }));
      }
      
      // Ensure cleanup before exit
      if (storage) {
        try {
          storage.close();
        } catch (closeError) {
          // Ignore close errors
        }
      }
      process.exit(1);
    } finally {
      await SafeCleanup.closeStorage(storage);
    }
  }

  /**
   * Get error statistics
   */
  static async stats(options: { instanceId: string; dbPath?: string }): Promise<void> {
    const storage = new StorageManager(options.dbPath);
    
    try {
      const result = storage.getErrorSummary(options.instanceId);
      if (!result.success) {
        throw result.error;
      }

      const response = {
        success: true,
        instanceId: options.instanceId,
        ...result.data
      };

      OutputFormatter.formatOutput(response);
      
      // Explicit exit after successful execution
      process.exit(0);

    } catch (error) {
      OutputFormatter.formatError(
        error instanceof Error ? error.message : String(error),
        { instanceId: options.instanceId }
      );
      process.exit(1);
    } finally {
      await SafeCleanup.closeStorage(storage);
    }
  }

  /**
   * Clear errors for an instance
   */
  static async clear(options: { instanceId: string; confirm: boolean; dbPath?: string }): Promise<void> {
    if (!options.confirm) {
      OutputFormatter.formatError('--confirm flag required to clear errors');
      process.exit(1);
    }

    const storage = new StorageManager(options.dbPath);
    
    try {
      const result = storage.clearErrors(options.instanceId);
      if (!result.success) {
        throw result.error;
      }

      const response = {
        success: true,
        message: `Cleared ${result.data.clearedCount} errors for instance ${options.instanceId}`,
        clearedCount: result.data.clearedCount
      };

      OutputFormatter.formatOutput(response);
      
      // Explicit exit after successful execution
      process.exit(0);

    } catch (error) {
      OutputFormatter.formatError(
        error instanceof Error ? error.message : String(error),
        { instanceId: options.instanceId }
      );
      process.exit(1);
    } finally {
      await SafeCleanup.closeStorage(storage);
    }
  }

  private static countByField(errors: readonly StoredError[], field: keyof StoredError): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const error of errors) {
      const value = String(error[field]);
      counts[value] = (counts[value] || 0) + 1;
    }
    return counts;
  }
}

/**
 * Log management commands
 */
class LogCommands {
  /**
   * List logs for an instance
   */
  static async list(options: {
    instanceId: string;
    levels?: LogLevel[];
    streams?: ('stdout' | 'stderr')[];
    since?: string;
    until?: string;
    limit?: number;
    offset?: number;
    format?: 'json' | 'table' | 'raw';
    dbPath?: string;
  }): Promise<void> {
    const storage = new StorageManager(undefined, options.dbPath);
    
    try {
      const filter: LogFilter = {
        instanceId: options.instanceId,
        levels: options.levels,
        streams: options.streams,
        since: options.since ? new Date(options.since) : undefined,
        until: options.until ? new Date(options.until) : undefined,
        limit: options.limit || 100,
        offset: options.offset || 0,
        sortOrder: 'desc'
      };

      const result = storage.getLogs(filter);
      if (!result.success) {
        throw result.error;
      }

      const response = result.data;

      if (options.format === 'table') {
        OutputFormatter.printLogsTable(response.logs);
      } else if (options.format === 'raw') {
        response.logs.forEach(log => console.log(log.message));
      } else {
        OutputFormatter.formatOutput(response, options.format);
      }
      
      // Explicit exit after successful execution
      process.exit(0);

    } catch (error) {
      OutputFormatter.formatError(
        error instanceof Error ? error.message : String(error),
        { instanceId: options.instanceId }
      );
      process.exit(1);
    } finally {
      await SafeCleanup.closeStorage(storage);
    }
  }



  /**
   * Get all process logs from file with optional reset
   */
  static async get(options: {
    instanceId: string;
    format?: 'json' | 'raw';
    reset?: boolean;
  }): Promise<void> {
    try {
      const { promises: fs } = require('fs');
      const { join } = require('path');
      
      const logFilePath = join(getDataDirectory(), `${options.instanceId}-process.log`);
      const lockFilePath = `${logFilePath}.lock`;
      const tempPath = `${logFilePath}.tmp.${Date.now()}.${process.pid}`;
      
      let logs = '';
      
      // Simple file-based locking to prevent concurrent access
      const acquireLock = async (): Promise<boolean> => {
        try {
          await fs.writeFile(lockFilePath, process.pid.toString(), { flag: 'wx' });
          return true;
        } catch (error) {
          return false;
        }
      };
      
      const releaseLock = async (): Promise<void> => {
        try {
          await fs.unlink(lockFilePath);
        } catch (error) {
          // Ignore lock release errors
        }
      };
      
      // Try to acquire lock with retry
      let lockAcquired = false;
      for (let attempt = 0; attempt < 5; attempt++) {
        lockAcquired = await acquireLock();
        if (lockAcquired) break;
        
        // Wait briefly before retry
        await new Promise(resolve => setTimeout(resolve, 50 + Math.random() * 50));
      }
      
      if (!lockAcquired) {
        throw new Error('Could not acquire file lock for log reset operation');
      }
      
      try {
        if (options.reset) {
          // Reset mode: Atomic operation to read and clear the file
          try {
            await fs.rename(logFilePath, tempPath);
            
            // Create new empty log file immediately
            await fs.writeFile(logFilePath, '', 'utf8').catch(() => {});
            
            // Read from temp file and clean up
            try {
              logs = await fs.readFile(tempPath, 'utf8');
              await fs.unlink(tempPath).catch(() => {}); // Clean up temp file
            } catch (error) {
              // If we can't read temp file, at least clean it up
              await fs.unlink(tempPath).catch(() => {});
              logs = '';
            }
          } catch (error) {
            // File doesn't exist yet, return empty
            if ((error as any).code === 'ENOENT') {
              logs = '';
            } else {
              throw error;
            }
          }
        } else {
          // Read-only mode: Just read the file without resetting
          try {
            logs = await fs.readFile(logFilePath, 'utf8');
          } catch (error) {
            // File doesn't exist yet, return empty
            if ((error as any).code === 'ENOENT') {
              logs = '';
            } else {
              throw error;
            }
          }
        }
      } finally {
        await releaseLock();
      }
      
      if (options.format === 'raw') {
        console.log(logs);
      } else {
        const response = {
          success: true,
          logs: logs,
          instanceId: options.instanceId
        };
        OutputFormatter.formatOutput(response, options.format);
      }
      
      // Explicit exit after successful execution
      process.exit(0);

    } catch (error) {
      OutputFormatter.formatError(
        error instanceof Error ? error.message : String(error),
        { instanceId: options.instanceId }
      );
      process.exit(1);
    }
  }

  /**
   * Get log statistics
   */
  static async stats(options: { instanceId: string; dbPath?: string }): Promise<void> {
    const storage = new StorageManager(undefined, options.dbPath);
    
    try {
      const result = storage.getLogStats(options.instanceId);
      if (!result.success) {
        throw result.error;
      }

      const response = {
        success: true,
        instanceId: options.instanceId,
        ...result.data
      };

      OutputFormatter.formatOutput(response);
      
      // Explicit exit after successful execution
      process.exit(0);

    } catch (error) {
      OutputFormatter.formatError(
        error instanceof Error ? error.message : String(error),
        { instanceId: options.instanceId }
      );
      process.exit(1);
    } finally {
      await SafeCleanup.closeStorage(storage);
    }
  }

  /**
   * Clear logs for an instance
   */
  static async clear(options: { instanceId: string; confirm: boolean; dbPath?: string }): Promise<void> {
    if (!options.confirm) {
      OutputFormatter.formatError('--confirm flag required to clear logs');
      process.exit(1);
    }

    const storage = new StorageManager(undefined, options.dbPath);
    
    try {
      const result = storage.clearLogs(options.instanceId);
      if (!result.success) {
        throw result.error;
      }

      const response = {
        success: true,
        message: `Cleared ${result.data.clearedCount} logs for instance ${options.instanceId}`,
        clearedCount: result.data.clearedCount
      };

      OutputFormatter.formatOutput(response);
      
      // Explicit exit after successful execution
      process.exit(0);

    } catch (error) {
      OutputFormatter.formatError(
        error instanceof Error ? error.message : String(error),
        { instanceId: options.instanceId }
      );
      process.exit(1);
    } finally {
      await SafeCleanup.closeStorage(storage);
    }
  }
}

/**
 * Show comprehensive help
 */
function showHelp() {
  console.log(`
Unified Process Monitoring CLI - Comprehensive management for containerized processes

Usage: bun run cli-tools.ts <command> [subcommand] [options]

COMMANDS:

  process                    Process lifecycle management
    start                    Start process monitoring
    stop                     Stop process monitoring  
    status                   Get process status
    
  errors                     Error management
    list                     List runtime errors
    stats                    Get error statistics
    clear                    Clear stored errors
    
  logs                       Log management
    list                     List process logs
    get                      Get process logs with optional reset
    stats                    Get log statistics  
    clear                    Clear stored logs

PROCESS COMMANDS:

  # Start monitoring a development server
  bun run cli-tools.ts process start --instance-id my-app --port 8080 -- bun run dev
  
  # Start with custom restart policy  
  bun run cli-tools.ts process start -i my-app --max-restarts 5 --restart-delay 2000 -- npm start
  
  # Stop monitoring
  bun run cli-tools.ts process stop --instance-id my-app
  
  # Get process status
  bun run cli-tools.ts process status --instance-id my-app

ERROR COMMANDS:

  # List recent errors
  bun run cli-tools.ts errors list --instance-id my-app --limit 50
  
  # Filter by severity and category
  bun run cli-tools.ts errors list -i my-app --severities error,fatal --categories runtime
  
  # Get error statistics
  bun run cli-tools.ts errors stats --instance-id my-app
  
  # Clear all errors
  bun run cli-tools.ts errors clear --instance-id my-app --confirm

LOG COMMANDS:

  # List recent logs
  bun run cli-tools.ts logs list --instance-id my-app --limit 100
  
  # Filter by log level and stream
  bun run cli-tools.ts logs list -i my-app --levels error,warn --streams stderr
  
  # Get all process logs (for SandboxSdkClient)
  bun run cli-tools.ts logs get --instance-id my-app --format raw
  
  # Get all process logs and reset log file
  bun run cli-tools.ts logs get --instance-id my-app --format raw --reset
  
  # Get log statistics
  bun run cli-tools.ts logs stats --instance-id my-app

GLOBAL OPTIONS:

  --instance-id, -i <id>     Instance identifier (required for most commands)
  --format <format>          Output format: json (default), table, raw
  --db-path <path>           Custom database path
  --help, -h                 Show help message

PROCESS START OPTIONS:

  --port, -p <port>          Set PORT environment variable
  --cwd, -c <path>           Working directory (default: current directory)
  --max-restarts <num>       Maximum restart attempts (default: 3)
  --restart-delay <ms>       Delay between restarts in ms (default: 1000)
  --max-errors <num>         Maximum errors to store (default: 1000)
  --retention-days <days>    Error retention period (default: 7)
  --log-retention-hours <h>  Log retention period in hours (default: 168)

FILTER OPTIONS:

  --levels <levels>          Filter by log levels (comma-separated)
  --streams <streams>        Filter by streams (comma-separated: stdout,stderr)
  --categories <categories>  Filter by error categories (comma-separated)
  --severities <severities>  Filter by error severities (comma-separated)
  --since <date>             Filter since date (ISO format)
  --until <date>             Filter until date (ISO format)
  --limit <number>           Limit number of results (default: 100)
  --offset <number>          Offset for pagination (default: 0)

EXAMPLES:

  # Complete workflow: start monitoring, check errors, view logs
  bun run cli-tools.ts process start -i vite-app -- bun run dev
  bun run cli-tools.ts errors list -i vite-app --format table
  bun run cli-tools.ts logs get -i vite-app --format raw
  
  # Monitor production deployment
  bun run cli-tools.ts process start -i prod-api --max-restarts 10 -- node server.js
  
  # Debug specific error patterns
  bun run cli-tools.ts errors list -i my-app --severities fatal,error --since 2024-01-01

Environment Variables:
  INSTANCE_ID               Default instance identifier
  PORT                      Port for the application
  CLI_DATA_DIR              Data directory path (default: ./data)
  CLI_ERROR_DB_PATH         Error database path (default: <CLI_DATA_DIR>/errors.db)
  CLI_LOG_DB_PATH           Log database path (default: <CLI_DATA_DIR>/logs.db)
  
Database Storage:
  Errors: ${getErrorDbPath()} (configurable via CLI_ERROR_DB_PATH)
  Logs:   ${getLogDbPath()} (configurable via CLI_LOG_DB_PATH)
  Data:   ${getDataDirectory()} (configurable via CLI_DATA_DIR)
`);
}

/**
 * Initialize data directory if it doesn't exist
 */
function initializeDataDirectory(): void {
  const fs = require('fs');
  const dataDir = getDataDirectory();
  
  try {
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
      console.log(`Created data directory: ${dataDir}`);
    }
  } catch (error) {
    console.warn(`Failed to create data directory ${dataDir}:`, error);
  }
}

/**
 * Main CLI function with unified command routing
 */
async function main() {
  try {
    // Initialize data directory
    initializeDataDirectory();
    
    const { values: args, positionals } = parseArgs({
      args: process.argv.slice(2),
      options: {
        // Global options
        'instance-id': { type: 'string', short: 'i' },
        'format': { type: 'string' },
        'db-path': { type: 'string' },
        'help': { type: 'boolean', short: 'h' },
        
        // Process options
        'cwd': { type: 'string', short: 'c' },
        'port': { type: 'string', short: 'p' },
        'max-restarts': { type: 'string' },
        'restart-delay': { type: 'string' },
        'max-errors': { type: 'string' },
        'retention-days': { type: 'string' },
        'log-retention-hours': { type: 'string' },
        'force': { type: 'boolean' },
        
        // Filter options
        'levels': { type: 'string' },
        'streams': { type: 'string' },
        'categories': { type: 'string' },
        'severities': { type: 'string' },
        'since': { type: 'string' },
        'until': { type: 'string' },
        'limit': { type: 'string' },
        'offset': { type: 'string' },
        'last-sequence': { type: 'string' },
        'count': { type: 'string' },
        'confirm': { type: 'boolean' },
        'reset': { type: 'boolean' }
      },
      allowPositionals: true
    });

    const command = positionals[0];
    const subcommand = positionals[1];

    if (args.help || !command) {
      showHelp();
      process.exit(0);
    }

    // Route to appropriate command handler
    switch (command) {
      case 'process':
        await handleProcessCommand(subcommand, args, positionals.slice(2));
        break;
        
      case 'errors':
        await handleErrorCommand(subcommand, args);
        break;
        
      case 'logs':
        await handleLogCommand(subcommand, args);
        break;
        
      default:
        OutputFormatter.formatError(`Unknown command: ${command}`);
        showHelp();
        process.exit(1);
    }

  } catch (error) {
    OutputFormatter.formatError(`CLI failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    process.exit(1);
  }
}

/**
 * Handle process commands
 */
async function handleProcessCommand(subcommand: string, args: Record<string, unknown>, remainingArgs: string[]) {
  switch (subcommand) {
    case 'start':
      if (remainingArgs.length === 0) {
        OutputFormatter.formatError('No command specified to monitor');
        process.exit(1);
      }
      
      const instanceId = String(args['instance-id'] || process.env.INSTANCE_ID || `instance-${Date.now()}`);
      
      await ProcessCommands.start({
        instanceId,
        command: remainingArgs[0],
        args: remainingArgs.slice(1),
        cwd: args.cwd ? String(args.cwd) : undefined,
        port: args.port ? String(args.port) : undefined,
        maxRestarts: args['max-restarts'] ? parseInt(String(args['max-restarts'])) : undefined,
        restartDelay: args['restart-delay'] ? parseInt(String(args['restart-delay'])) : undefined,
        maxErrors: args['max-errors'] ? parseInt(String(args['max-errors'])) : undefined,
        retentionDays: args['retention-days'] ? parseInt(String(args['retention-days'])) : undefined,
        logRetentionHours: args['log-retention-hours'] ? parseInt(String(args['log-retention-hours'])) : undefined
      });
      break;
      
    case 'stop':
      if (!args['instance-id']) {
        OutputFormatter.formatError('--instance-id is required for stop command');
        process.exit(1);
      }
      
      await ProcessCommands.stop({
        instanceId: String(args['instance-id']),
        force: Boolean(args.force)
      });
      break;
      
    case 'status':
      await ProcessCommands.status({
        instanceId: args['instance-id'] ? String(args['instance-id']) : undefined
      });
      break;
      
    default:
      OutputFormatter.formatError(`Unknown process subcommand: ${subcommand}`);
      process.exit(1);
  }
}

/**
 * Handle error commands
 */
async function handleErrorCommand(subcommand: string, args: Record<string, unknown>) {
  switch (subcommand) {
    case 'list':
      if (!args['instance-id']) {
        OutputFormatter.formatError('--instance-id is required for list command');
        process.exit(1);
      }
      
      await ErrorCommands.list({
        instanceId: String(args['instance-id']),
        categories: args.categories ? String(args.categories).split(',') as ErrorCategory[] : undefined,
        severities: args.severities ? String(args.severities).split(',') as ErrorSeverity[] : undefined,
        since: args.since ? String(args.since) : undefined,
        until: args.until ? String(args.until) : undefined,
        limit: args.limit ? parseInt(String(args.limit)) : undefined,
        offset: args.offset ? parseInt(String(args.offset)) : undefined,
        format: args.format as 'json' | 'table' | 'raw',
        dbPath: args['db-path'] ? String(args['db-path']) : undefined
      });
      break;
      
    case 'stats':
      if (!args['instance-id']) {
        OutputFormatter.formatError('--instance-id is required for stats command');
        process.exit(1);
      }
      
      await ErrorCommands.stats({
        instanceId: String(args['instance-id']),
        dbPath: args['db-path'] ? String(args['db-path']) : undefined
      });
      break;
      
    case 'clear':
      if (!args['instance-id']) {
        OutputFormatter.formatError('--instance-id is required for clear command');
        process.exit(1);
      }
      
      await ErrorCommands.clear({
        instanceId: String(args['instance-id']),
        confirm: Boolean(args.confirm),
        dbPath: args['db-path'] ? String(args['db-path']) : undefined
      });
      break;
      
    default:
      OutputFormatter.formatError(`Unknown error subcommand: ${subcommand}`);
      process.exit(1);
  }
}

/**
 * Handle log commands
 */
async function handleLogCommand(subcommand: string, args: Record<string, unknown>) {
  switch (subcommand) {
    case 'list':
      if (!args['instance-id']) {
        OutputFormatter.formatError('--instance-id is required for list command');
        process.exit(1);
      }
      
      await LogCommands.list({
        instanceId: String(args['instance-id']),
        levels: args.levels ? String(args.levels).split(',') as LogLevel[] : undefined,
        streams: args.streams ? String(args.streams).split(',') as ('stdout' | 'stderr')[] : undefined,
        since: args.since ? String(args.since) : undefined,
        until: args.until ? String(args.until) : undefined,
        limit: args.limit ? parseInt(String(args.limit)) : undefined,
        offset: args.offset ? parseInt(String(args.offset)) : undefined,
        format: args.format as 'json' | 'table' | 'raw',
        dbPath: args['db-path'] ? String(args['db-path']) : undefined
      });
      break;
      
    case 'get':
      if (!args['instance-id']) {
        OutputFormatter.formatError('--instance-id is required for get command');
        process.exit(1);
      }
      
      await LogCommands.get({
        instanceId: String(args['instance-id']),
        format: args.format as 'json' | 'raw',
        reset: Boolean(args.reset)
      });
      break;
      
    case 'stats':
      if (!args['instance-id']) {
        OutputFormatter.formatError('--instance-id is required for stats command');
        process.exit(1);
      }
      
      await LogCommands.stats({
        instanceId: String(args['instance-id']),
        dbPath: args['db-path'] ? String(args['db-path']) : undefined
      });
      break;
      
    case 'clear':
      if (!args['instance-id']) {
        OutputFormatter.formatError('--instance-id is required for clear command');
        process.exit(1);
      }
      
      await LogCommands.clear({
        instanceId: String(args['instance-id']),
        confirm: Boolean(args.confirm),
        dbPath: args['db-path'] ? String(args['db-path']) : undefined
      });
      break;
      
    default:
      OutputFormatter.formatError(`Unknown log subcommand: ${subcommand}`);
      process.exit(1);
  }
}

// Run CLI if this file is executed directly
if (process.argv[1] && process.argv[1].endsWith('cli-tools.ts')) {
  main().catch(error => {
    OutputFormatter.formatError(`Unhandled error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    process.exit(1);
  });
}

export { ProcessCommands, ErrorCommands, LogCommands, OutputFormatter };