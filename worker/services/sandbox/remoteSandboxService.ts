import {
    TemplateDetailsResponse,
    BootstrapResponse,
    GetInstanceResponse,
    BootstrapStatusResponse,
    ShutdownResponse,
    WriteFilesRequest,
    WriteFilesResponse,
    GetFilesResponse,
    ExecuteCommandsResponse,
    RuntimeErrorResponse,
    ClearErrorsResponse,
    StaticAnalysisResponse,
    DeploymentResult,
    GetLogsResponse,
    ListInstancesResponse,
    TemplateDetailsResponseSchema,
    BootstrapResponseSchema,
    BootstrapRequest,
    GetInstanceResponseSchema,
    BootstrapStatusResponseSchema,
    WriteFilesResponseSchema,
    GetFilesResponseSchema,
    ExecuteCommandsRequest,
    ExecuteCommandsResponseSchema,
    RuntimeErrorResponseSchema,
    ClearErrorsResponseSchema,
    DeploymentResultSchema,
    ShutdownResponseSchema,
    StaticAnalysisResponseSchema,
    GitHubPushRequest,
    GitHubPushResponse,
    GitHubExportRequest,
    GitHubExportResponse,
    GitHubPushResponseSchema,
} from './sandboxTypes';
import { BaseSandboxService } from "./BaseSandboxService";
import { env } from 'cloudflare:workers'
import z from 'zod';

export async function runnerFetch(url: string, method: 'GET' | 'POST' | 'DELETE', headers: Headers, body: string | undefined) {
    // Use direct fetch for runner service communication
    return await fetch(url, { method, headers, body });
}

/**
 * Client for interacting with the Runner Service API.
 */
export class RemoteSandboxServiceClient extends BaseSandboxService{
    private static sandboxServiceUrl: string;
    private static token: string;

    static init(sandboxServiceUrl: string, token: string) {
        RemoteSandboxServiceClient.sandboxServiceUrl = sandboxServiceUrl;
        RemoteSandboxServiceClient.token = token;
    }

    constructor(sandboxId: string) {
        super(sandboxId)
        this.logger.info('RemoteSandboxServiceClient initialized', { sandboxId: this.sandboxId });
    }

    private async makeRequest<T extends z.ZodTypeAny>(
        endpoint: string,
        method: 'GET' | 'POST' | 'DELETE',
        schema?: T,
        body?: unknown,
        resetPrevious: boolean = false
    ): Promise<z.infer<T>> {
        const url = `${RemoteSandboxServiceClient.sandboxServiceUrl}${endpoint}`;

        try {
            const headers = new Headers();
            headers.set('Content-Type', 'application/json');
            headers.set('Authorization', `Bearer ${RemoteSandboxServiceClient.token}`);
            headers.set('x-session-id', this.sandboxId);
            if (resetPrevious) {
                headers.set('x-container-action', 'reset');
            }

            const response = await runnerFetch(url, method, headers, body ? JSON.stringify(body) : undefined);

            if (!response.ok) {
                const errorText = await response.text();
                this.logger.error('Runner service request failed', { 
                    status: response.status, 
                    statusText: response.statusText, 
                    errorText,
                    url 
                });
                return {
                    success: false,
                    error: errorText
                };
            }

            const responseData = await response.json();
            if(!schema) return responseData;
            const validation = schema.safeParse(responseData);

            if (!validation.success) {
                this.logger.error('Failed to validate response', validation.error.errors, { url });
                return {
                    success: false,
                    error: "Failed to validate response"
                };
            }

            // this.logger.info('Response validated', { url });
            return validation.data;
        } catch (error) {
            this.logger.error('Error making request to runner service', error, { url });
            return {
                success: false,
                error: "Failed to validate response"
            };
        }
    }
    /**
     * Get details for a specific template.
     */
    async getTemplateDetails(templateName: string): Promise<TemplateDetailsResponse> {
        return this.makeRequest(`/templates/${templateName}`, 'GET', TemplateDetailsResponseSchema);
    }

    /**
     * Create a new runner instance.
     */
    async createInstance(templateName: string, projectName: string, webhookUrl?: string, localEnvVars?: Record<string, string>): Promise<BootstrapResponse> {
        const requestBody: BootstrapRequest = { 
            templateName, 
            projectName, 
            ...(webhookUrl && { webhookUrl }),
            ...(localEnvVars && { envVars: localEnvVars })
        };
        return this.makeRequest('/instances', 'POST', BootstrapResponseSchema, requestBody);
    }

    /**
     * Get details for a specific runner instance.
     */
    async getInstanceDetails(instanceId: string): Promise<GetInstanceResponse> {
        return this.makeRequest(`/instances/${instanceId}`, 'GET', GetInstanceResponseSchema);
    }

    /**
     * Get status for a specific runner instance.
     */
    async getInstanceStatus(instanceId: string): Promise<BootstrapStatusResponse> {
        return this.makeRequest(`/instances/${instanceId}/status`, 'GET', BootstrapStatusResponseSchema);
    }
    /**
     * Write files to a runner instance.
     */
    async writeFiles(instanceId: string, files: WriteFilesRequest['files'], commitMessage?: string): Promise<WriteFilesResponse> {
        const requestBody: WriteFilesRequest = { files, commitMessage };
        return this.makeRequest(`/instances/${instanceId}/files`, 'POST', WriteFilesResponseSchema, requestBody);
    }

    /**
     * Get specific files from a runner instance.
     * @param instanceId The ID of the runner instance.
     * @param filePaths An optional array of file paths to retrieve.
     */
    async getFiles(instanceId: string, filePaths?: string[]): Promise<GetFilesResponse> {
        // Build query params if filePaths are provided
        const queryParams = filePaths && filePaths.length > 0 ? `?filePaths=${encodeURIComponent(JSON.stringify(filePaths))}` : '';
        return this.makeRequest(`/instances/${instanceId}/files${queryParams}`, 'GET', GetFilesResponseSchema);
    }

    /**
     * Execute commands in a runner instance.
     */
    async executeCommands(instanceId: string, commands: string[], timeout?: number): Promise<ExecuteCommandsResponse> {
        const requestBody: ExecuteCommandsRequest = { commands, timeout };
        return this.makeRequest(`/instances/${instanceId}/commands`, 'POST', ExecuteCommandsResponseSchema, requestBody);
    }

    /**
     * Get runtime errors from a runner instance.
     */
    async getInstanceErrors(instanceId: string): Promise<RuntimeErrorResponse> {
        return this.makeRequest(`/instances/${instanceId}/errors`, 'GET', RuntimeErrorResponseSchema);
    }

    async clearInstanceErrors(instanceId: string): Promise<ClearErrorsResponse> {
        return this.makeRequest(`/instances/${instanceId}/errors`, 'DELETE', ClearErrorsResponseSchema);
    }

    /**
     * Perform static code analysis on a runner instance to find potential issues.
     * @param instanceId The ID of the runner instance
     * @param files Optional comma-separated list of specific files to lint
     */
    async runStaticAnalysisCode(instanceId: string, lintFiles?: string[]): Promise<StaticAnalysisResponse> {
        const queryParams = lintFiles?.length ? `?files=${lintFiles.join(',')}` : '';
        return this.makeRequest(`/instances/${instanceId}/analysis${queryParams}`, 'GET', StaticAnalysisResponseSchema);
    }

    /**
     * Deploy a runner instance to Cloudflare Workers.
     * @param instanceId The ID of the runner instance to deploy
     * @param credentials Optional Cloudflare deployment credentials
     */
    async deployToCloudflareWorkers(instanceId: string): Promise<DeploymentResult> {
        return this.makeRequest(`/instances/${instanceId}/deploy`, 'POST', DeploymentResultSchema);
    }

    /**
     * Shutdown a runner instance.
     */
    async shutdownInstance(instanceId: string): Promise<ShutdownResponse> {
        return this.makeRequest(`/instances/${instanceId}`, 'DELETE', ShutdownResponseSchema);
    }

    /**
     * Export generated app to GitHub (creates repository if needed, then pushes files)
     */
    async exportToGitHub(instanceId: string, request: GitHubExportRequest): Promise<GitHubExportResponse> {
        return this.makeRequest(`/instances/${instanceId}/github/export`, 'POST', undefined, request);
    }

    /**
     * Push instance files to existing GitHub repository
     */
    async pushToGitHub(instanceId: string, request: GitHubPushRequest): Promise<GitHubPushResponse> {
        return this.makeRequest(`/instances/${instanceId}/github/push`, 'POST', GitHubPushResponseSchema, request);
    }

    /**
     * Initialize the client (no-op for remote client)
     */
    async initialize(): Promise<void> {
        // No initialization needed for remote client
        this.logger.info('Remote sandbox service client initialized', { sandboxId: this.sandboxId });
    }

    /**
     * List all instances across all sessions
     */
    async listAllInstances(): Promise<ListInstancesResponse> {
        return this.makeRequest('/instances', 'GET');
    }

    /**
     * Get logs from a runner instance
     */
    async getLogs(instanceId: string): Promise<GetLogsResponse> {
        return this.makeRequest(`/instances/${instanceId}/logs`, 'GET');
    }

    // temp, debug
    async writeFileLogs(logName: string, log: string) {
        return this.makeRequest('/logs', 'POST', undefined, { logName, log });
    }
}

RemoteSandboxServiceClient.init(env.SANDBOX_SERVICE_URL, env.SANDBOX_SERVICE_API_KEY);
